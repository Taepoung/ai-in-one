/**
 * **권한·심사 층** — 「이 권한, 누구 말을 들을까」 (리팩토링 ⑦-3, 2026-10-20).
 *
 * 에이전트가 `request_permission` 을 보내면 **누구에게 물을지 정하고 답을 돌려준다** —
 * 사용자에게 카드를 띄우거나, 심사 봇에게 맡기고(큐에 권한 항목 · `verdict` 로 받는다)
 * 그 판정을 옮겨 답한다. 사람이 끼어드는 길 둘(가로채기 · 대기 목록)도 여기다.
 *
 * ★ **밑바닥 원칙은 「답하는 건 언제나 우리」다.** ACP 에 «다른 에이전트에게
 * 위임» 이 없어서, 봇이 심사해도 우리가 그 봇에게 묻고 **우리가 답을 만든다.**
 * 그래서 조건을 걸 수 있고, 하나라도 안 맞으면 사람에게 넘긴다(`askBotApprover`).
 *
 * `roomManager.ts` 에서 **그대로** 떼어 왔다 — 동작은 같다. 빌려 쓰는 것은 문
 * (`ReviewPort`) 하나로만 받는다.
 *
 * ⚠️ 심사 봇이 판정하는 길은 MCP 뿐이라 이 층은 MCP 를 **내려다본다**(큐 · `deny`).
 * 거꾸로 MCP 가 판정을 부를 때는 방 관리자가 이어 준다(`McpPort.giveVerdict`).
 */
import { CLOSED_MEMORY, type BotQueue } from "../mcp/botQueue.js";
import { deny } from "../mcp/calls.js";
import type { McpResult } from "../mcpServer.js";
import type { WorkspaceHost } from "../workspaceHost.js";
import type { BotRuntime } from "../room/runtimes.js";
import {
  ASK_USER,
  type BotInstance,
  type PermissionDecision,
  type PermissionRequest,
  type ReviewWait,
  type Room,
  type RoomStatus,
  type WaitItem,
} from "../types.js";

/**
 * ★ **이 층이 방 관리자에게서 빌리는 것 — 전부** (리팩토링 ⑦-3).
 *
 * 칸을 늘리고 싶으면 먼저 «이게 정말 심사의 일인가» 를 묻는다.
 */
export interface ReviewPort {
  readonly queue: BotQueue;
  readonly host: WorkspaceHost;
  /** 봇끼리 말하는 길(MCP)이 지금 살아 있나 — 심사 봇은 그 길로만 답한다 */
  mcpReady(): boolean;
  /** 그 에이전트가 http MCP 를 받나 — 아직 모르면 `undefined` */
  mcpHttp(agentId: string): boolean | undefined;
  roomById(roomId: string): Room | undefined;
  openRooms(): Iterable<Room>;
  botRuntime(roomId: string, botId: string): BotRuntime;
  botForSession(sessionId: string): { room: Room; bot: BotInstance } | undefined;
  statusOf(roomId: string, botId?: string): RoomStatus;
  setStatus(roomId: string, status: RoomStatus, botId?: string): void;
  noteRoom(room: Room, text: string, kind?: "error" | "info", about?: string[]): void;
  maybeWake(room: Room, botId?: string): void;
  emitNotice(roomId: string, text: string): void;
  emitReviews(roomId: string, list: ReviewWait[]): void;
  emitWaiting(roomId: string, list: WaitItem[]): void;
}

export class Review {
  constructor(private readonly port: ReviewPort) {}

  /**
   * 판정 까닭을 **한 번 꺼내 쓰고 지운다** — 활동 줄에 «왜» 를 접어 넣는 자리
   * (`RoomManager.recordDecision`)가 부른다.
   */
  takeWhy(toolCallId: string): string | undefined {
    const why = this.verdictWhy.get(toolCallId);
    this.verdictWhy.delete(toolCallId);
    return why;
  }

  /**
   * 큐에 든 권한 요청의 **답을 넣을 손** — id → 푸는 함수.
   *
   * `request_permission` 은 블로킹이라, 큐에 넣는 것만으로는 저쪽이 안
   * 풀린다. 봇이 `verdict` 로 답하거나 중지가 거둘 때 이 손을 쓴다.
   */
  private readonly queued = new Map<string, {
    settle: (d: PermissionDecision | undefined) => void;
    /** 봇의 불리언을 옮길 자리 — **우리가 옮긴다.** 봇은 id 를 못 지어낸다 */
    allowId: string;
    rejectId: string;
    roomId: string;
    /** 그 활동에 판정 까닭을 접어 넣을 때 쓴다 (2026-10-13) */
    toolCallId?: string;
  }>();

  /**
   * 봇이 적은 판정 까닭 — `toolCallId` → 글.
   *
   * `giveVerdict` 가 적어두면 **조금 뒤에** `recordDecision` 이 그 활동에
   * 접어 넣는다. 둘이 한 줄에서 못 만나는 까닭은, 판정을 푸는 것과 그 결과가
   * 활동으로 돌아오는 것이 **다른 가닥**이기 때문이다(저쪽이 답을 받고 나서
   * 우리에게 알려준다).
   */
  private readonly verdictWhy = new Map<string, string>();

  /**
   * 들고 있던 까닭을 버린다 — **짝이 영영 안 오는 것**이 있기 때문이다.
   *
   * 🔴 판정 결과가 활동으로 돌아오기 전에 그 CLI 가 죽으면 그 칸은 영영
   * 남는다. 하나는 작지만 **버리는 자리가 없는 것**이 문제다 — `closed` 가
   * 쓰는 것과 같은 손질을 건다.
   */
  private trimVerdictWhy(): void {
    while (this.verdictWhy.size > CLOSED_MEMORY) {
      const oldest = this.verdictWhy.keys().next().value;
      if (oldest === undefined) break;
      this.verdictWhy.delete(oldest);
    }
  }

  private readonly reviews = new Map<string, ReviewWait & { takenOver?: boolean }>();

  /**
   * 큐에 넣어둔 권한 요청에 답한다 — 기다리던 `request_permission` 을 푼다.
   *
   * 🔴 **답은 한 번만 간다.** 두 번 부르면 이미 끝난 약속을 또 푸는 것이라
   * 조용히 아무 일도 안 일어나는데, 그 사이 **두 번째 답이 사라진다** —
   * 지운 뒤에 부른다.
   */
  settleQueued(id: string, decision: PermissionDecision | undefined): void {
    const held = this.queued.get(id);
    if (!held) return;
    this.queued.delete(id);
    // 띠에서도 뺀다 — 답이 났으므로 «기다리는 중» 이 아니다
    this.reviews.delete(id);
    this.emitReviews(held.roomId);
    held.settle(decision);
  }

  /** 줄 서 있는 심사들을 화면에 알린다 */
  private emitReviews(roomId: string): void {
    this.port.emitReviews(roomId, this.reviewsIn(roomId));
  }

  /** 그 방에서 줄 서 있는 심사들 — 방을 새로 열었을 때도 실어 보낸다 */
  reviewsIn(roomId: string): ReviewWait[] {
    return [...this.reviews.values()]
      .filter((r) => r.roomId === roomId)
      .map(({ takenOver: _drop, ...rest }) => rest);
  }

  /**
   * ★ **그 방 봇들이 들고 있는 것 전부** — 방을 열 때도 실어 보낸다 (§5-M).
   *
   * 이번 몫과 다음 몫을 **안 가른다.** 「이번 턴 것 / 다음 턴 것」은 우리가
   * 턴을 끊는 방식일 뿐인데, 사용자에게는 **어느 쪽이든 아직 답 안 한 것**
   * 하나다 — 가르면 설명할 것만 는다.
   */
  waitingIn(roomId: string): WaitItem[] {
    const room = this.port.roomById(roomId);
    if (!room) return [];
    const out: WaitItem[] = [];
    for (const bot of room.participants) {
      for (const item of this.port.queue.pending(bot.id)) {
        out.push({
          id: item.id,
          botId: bot.id,
          kind: item.kind,
          from: item.from,
          at: item.at,
          text: item.kind === "permission" ? item.title : item.text,
          ...(item.kind === "permission"
            ? {
                ...(item.command ? { command: item.command } : {}),
                ...(item.paths?.length ? { paths: item.paths } : {}),
                ...(item.diff ? { diff: item.diff } : {}),
                ...(item.tool ? { tool: item.tool } : {}),
                readOnly: item.readOnly,
              }
            : {}),
        });
      }
    }
    return out;
  }

  /**
   * ★ **사용자가 하나를 버린다** (§5-M).
   *
   * 🔴 **권한은 못 버린다.** 낸 봇이 `request_permission` 에 얼어 있어서,
   * 그냥 빼면 **영영 기다린다** — 그쪽은 「유저 승인으로」(`takeOverReview`)로
   * 가야 하고, 그러면 카드가 사람에게 뜬다. 메시지는 아무도 안 기다리므로
   * (단방향이다) 버려도 멈추는 데가 없다.
   *
   * 기록에는 안 남긴다 — 보낸 쪽 말풍선에 **이미 적혀 있고**(그 `say` 활동),
   * 사용자가 제 손으로 버린 것이라 «언제 이게 사라졌지»가 안 생긴다.
   */
  dropWaiting(roomId: string, botId: string, id: string): boolean {
    const item = this.port.queue.find(botId, id);
    if (!item || item.kind !== "message") return false;
    this.port.queue.answer(botId, id);
    this.port.queue.close(id, "사용자가 버렸습니다");
    this.port.host.log(`[${roomId}] ${botId} 의 대기에서 «${id}» 를 사용자가 버렸습니다`);
    return true;
  }

  /**
   * ★ **대기 줄에서 사용자가 바로 답한다** (§5-M, 2026-10-14).
   *
   * 봇에게 맡겨둔 승인을 **가져와서 답하는 것이 한 걸음**이다. 사용자:
   * *"펼쳐볼 수 있고 바로 승인, 거절 할 수 있는게 더나을듯"*.
   *
   * ⏪ 전에는 두 걸음이었다 — 「유저 승인으로」로 **가져오고**, 뜬 카드에
   * **답하고**. 가져오는 것 자체는 사용자가 원하는 일이 아니라 **우리 사정**
   * 이었다(큐에서 빼야 봇이 나중에 또 꺼내지 않으므로). 한 번에 한다.
   *
   * 🔴 **«이번 한 번만» 으로 답한다** — 봇에게 «항상» 을 안 주는 것과 같은
   * 줄이다(§4.2.2). 「항상」은 카드를 펴서 고를 때만 있다.
   *
   * @returns 답했나. 없거나 메시지 항목이면 `false`
   */
  answerWaiting(roomId: string, botId: string, id: string, allow: boolean): boolean {
    const item = this.port.queue.find(botId, id);
    if (!item || item.kind !== "permission") return false;
    const held = this.queued.get(id);
    if (!held || held.roomId !== roomId) return false;

    this.port.queue.answer(botId, id);
    this.port.queue.close(id, "사용자가 답했습니다");
    /* 띠·심사 줄에서 빼고 기다리던 약속을 푸는 것은 전부 `settleQueued` 가 한다 */
    this.settleQueued(id, {
      outcome: "selected",
      optionId: allow ? held.allowId : held.rejectId,
    });
    this.port.host.log(
      `[${roomId}] ${botId} 의 대기에서 «${id}» 를 사용자가 ` +
        `${allow ? "허용" : "거절"}했습니다`,
    );
    return true;
  }

  /**
   * 큐가 바뀌었다 — **그 봇이 있는 방**의 화면에 알린다 (§5-M).
   *
   * 봇 id 로 방을 찾는다. 안 열린 방이면 보낼 데가 없으므로 조용히 넘어간다 —
   * 다시 열 때 `waitingIn` 이 통째로 실려 간다.
   */
  waitingChanged(botId: string): void {
    for (const room of this.port.openRooms()) {
      if (!room.participants.some((b) => b.id === botId)) continue;
      this.port.emitWaiting(room.id, this.waitingIn(room.id));
      return;
    }
  }

  /**
   * ★ **사람이 가로챈다** (§4.2.2).
   *
   * 기다리는 동안 **요청한 봇의 턴은 얼어 있다.** 심사 봇이 언제 한가해질지는
   * 알 수 없으므로, 기다림이 보이는 것만으로는 부족하다 — **빠져나올 길**이
   * 있어야 한다. 누르면 그 심사는 물러나고 승인 카드가 사람에게 뜬다.
   *
   * 이미 물어본 뒤(`asking`)라면 가로채지 않는다 — 그 턴은 이미 돌고 있고,
   * 끊어도 **자동으로 다시 이어지지 않는다.**
   */
  takeOverReview(reviewId: string): boolean {
    const wait = this.reviews.get(reviewId);
    const held = this.queued.get(reviewId);
    if (!wait || !held) return false;
    /*
     * ★ **큐에서도 뺀다.** 안 빼면 심사 봇이 나중에 제 턴에 꺼내 보고
     * `verdict` 를 부르는데, 그때는 **이미 사람이 답한 뒤**다 — 봇은 제
     * 판정이 먹힌 줄 알고, 사람은 모르는 답이 하나 더 생긴다.
     */
    this.port.queue.answer(wait.judgeBotId, reviewId);
    this.port.queue.close(reviewId, "사용자에 의해 이미 응답되었습니다");
    // `undefined` 는 «사람에게 넘긴다» 다 — `askApprover` 가 받아서 카드를 띄운다
    this.settleQueued(reviewId, undefined);
    this.port.emitNotice(wait.roomId, `직접 답하기로 했습니다 — «${wait.title}»`);
    return true;
  }

  /**
   * ★ **봇이 판정했다** (v3.0 3-I).
   *
   * 🔴 **`allow` 는 불리언이다.** 봇이 `optionId` 를 지어낼 수 없게 하려는
   * 것이고, 옮기는 것은 우리다 — 그리고 **«항상»은 매핑에 없다**(§4.2.2).
   *
   * 🔴 **소유자를 본다.** 큐에서 빼는 것이 곧 검사다 — 남의 항목이면
   * `answer` 가 `undefined` 를 돌려주고, 그때는 아무 일도 안 일어난다.
   * 이게 없으면 봇이 **제 요청을 스스로 승인**할 수 있다.
   */
  async giveVerdict(
    botId: string,
    id: string,
    allow: boolean,
    reason: string,
  ): Promise<McpResult> {
    const item = this.port.queue.answer(botId, id);
    if (!item || item.kind !== "permission") {
      /*
       * ★ **«없다»와 «이미 났다»를 가른다** (2-E ②).
       *
       * 🔴 둘이 같은 글로 돌아오면 모델이 할 일이 안 갈린다 — 앞엣것은 다시
       * 확인해야 하고, 뒤엣것은 **아무것도 안 해도 된다.** 특히 사람이 가로챈
       * 뒤라면, 다시 확인해봐야 그 항목은 영영 안 나온다.
       */
      const why = this.port.queue.closedWhy(id);
      return deny(why ? "already handled" : "id error");
    }
    this.port.queue.close(id, "당신에 의해 이미 응답되었습니다");
    const held = this.queued.get(id);
    if (!held) return deny("already handled");

    this.settleQueued(id, {
      outcome: "selected",
      optionId: allow ? held.allowId : held.rejectId,
    });

    /*
     * ★ **까닭은 «활동»에 접어 넣는다** (2026-10-13).
     *
     * 🔴 여기가 **대화에 시스템 줄**을 쌓고 있었다 — 「심사봇이 막았습니다 —
     * «…» · 이유」. 승인 결과(`decision`)는 이미 활동으로 옮겨놨는데
     * **이유만 밖에 나와 있었다.** 봇이 스무 번 물으면 그 줄로 덮이는 것은
     * 똑같다(§4.2.2). 사용자: *"승인, 거절 이유는 활동에 적으면 될듯, 굳이
     * 채팅창에 남길 필요 없음"*.
     *
     * 🔴 **버리는 것이 아니다**(§0). 적어뒀다가 `recordDecision` 이 그 활동에
     * 넣는다 — 누가(`by`)·무엇을(`title`)·어떻게(`label`) 옆에 **왜**가 붙는다.
     * 붙일 활동이 없으면 거기서 예전처럼 한 줄로 남는다.
     */
    const why = reason.trim().replace(/\s+/g, " ").slice(0, 200);
    if (held.toolCallId) {
      if (why) { this.verdictWhy.set(held.toolCallId, why); this.trimVerdictWhy(); }
    } else {
      /*
       * 🔴 **붙일 활동이 없으면 버리지 않는다** (§0). `toolCallId` 가 없는
       * 요청이 있다 — 그때는 접어 넣을 자리가 아예 없으므로 **예전처럼 한
       * 줄로** 남긴다. `recordDecision` 의 받침과 같은 규칙이다.
       */
      const room = this.port.roomById(held.roomId);
      if (room) {
        const judge = room.participants.find((b) => b.id === botId);
        this.port.noteRoom(
          room,
          `${judge?.name ?? "심사 봇"}이(가) ${allow ? "승인했습니다" : "막았습니다"} — ` +
            `«${item.title}»${why ? ` · ${why}` : ""}`,
          allow ? "info" : "error",
        );
      }
    }
    /*
     * ★ **도구 결과마다 `left` 를 싣는다** (v3.0 2-H).
     *
     * 답한 직후가 «또 꺼낼까» 를 정하는 자리다. 여기서 0 이면 모델은 턴을
     * 닫고, 아니면 `check_queue` 를 한 번 더 부른다 — 그 판단에 쓸 숫자를
     * **그 자리에서** 준다.
     */
    return {
      text: JSON.stringify({
        ok: true,
        result: allow ? "허용" : "막음",
        queue_left: this.port.queue.shareLeft(botId),
      }),
    };
  }

  /**
   * 승인을 **대상에게 묻고 답을 돌려준다** (D2).
   *
   * 권한은 「봇 : 범위 : 대상」이다. 범위(`autoApprove`)가 자동 승인을 안 해주면
   * 여기로 오고, 대상(`approver`)이 누가 답할지 정한다.
   *
   * **승인 주체가 넘어가는 게 아니다.** `session/request_permission`은 클라이언트
   * 메서드라 응답은 언제나 우리가 만든다 — 대상은 «누구 말을 듣나»일 뿐이고,
   * 그래서 기록(D3)도 제한도 우리 손에 남는다.
   */
  async askApprover(
    sessionId: string,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    const found = this.port.botForSession(sessionId);
    const approver = found?.bot.approver ?? ASK_USER;

    /*
     * ★ **기다리는 동안 «권한 대기»라고 말한다** (C10).
     *
     * 🔴 `RoomStatus` 에 `permission` 이 있는데 **아무도 세우지 않고 있었다.**
     * 그래서 승인 카드가 떠 있는 내내 상태 줄은 «답하는 중…»이라고 했고,
     * 말풍선에는 타이핑 점이 계속 돌았다 — **아무것도 안 흐르는데.**
     *
     * `session/request_permission` 은 **블로킹 요청**이다. 답할 때까지 그
     * 에이전트의 턴은 정말로 멈춰 있다. 화면이 그걸 그대로 말해야 한다 —
     * 안 그러면 사용자는 **자기를 기다리는 줄 모르고** 기다린다.
     *
     * 봇에게 맡겼을 때도 마찬가지다. 누가 답하든 «멈춰서 답을 기다리는 중»인
     * 것은 같고, **누가** 답하는지는 심사 줄(`reviews`)이 따로 말한다.
     */
    const before = found ? this.port.statusOf(found.room.id, found.bot.id) : undefined;
    if (found) this.port.setStatus(found.room.id, "permission", found.bot.id);
    // **누가 하려는 일인지** 붙여서 넘긴다 — 세션은 봇 하나에 속한다(B1)
    const asked: PermissionRequest = found
      ? { ...req, askerBotId: found.bot.id }
      : req;
    try {
      if (approver.kind === "bot" && found) {
        const decided = await this.askBotApprover(found.room, found.bot, approver.botId, asked);
        if (decided) return decided;
      }
      return await this.port.host.requestPermission(asked);
    } finally {
      /*
       * 턴은 막혀 있었으므로 **원래 하던 것으로** 돌아간다.
       *
       * 🔴 **그 사이에 죽었으면 안 돌아간다** (2026-10-14 실측). 카드가 떠
       * 있는 동안 CLI 가 죽으면 상태는 `error` 가 되는데, 늦게 답한 카드가
       * 그걸 **`tool` 로 되살렸다** — 죽은 프로세스를 기다리는 꼴이고 점도
       * 다시 돈다. 어제 고친 그 버그가 이 길로 되살아난다.
       *
       * 그래서 **아직 «묻는 중» 일 때만** 되돌린다 — 그 사이에 누가 상태를
       * 바꿨다면 그쪽이 더 새로운 소식이다.
       */
      if (found && before
        && this.port.statusOf(found.room.id, found.bot.id) === "permission") {
        this.port.setStatus(found.room.id, before, found.bot.id);
      }
    }
  }

  /**
   * ★ **다른 봇에게 물어본다** (§4.2.2).
   *
   * 🔴 **승인 주체가 넘어가는 게 아니다.** `session/request_permission`은
   * 클라이언트 메서드라 답은 언제나 우리가 만든다 — ACP에 «다른 에이전트에게
   * 위임»이라는 개념이 없다. 그래서 «위임»은 실제로 이 모양이다:
   *
   * ```
   * 에이전트 ──request_permission──▶ AI in One ──프롬프트──▶ 심사 봇
   *                                      │ ◀──── 의견 ─────┘
   *          ◀──────optionId─────────────┘   ← 답하는 건 언제나 우리
   * ```
   *
   * **주체가 우리라서 조건을 걸 수 있다.** 아래가 그 조건이고, 하나라도
   * 안 맞으면 `undefined`를 돌려 **사람에게 넘긴다.**
   *
   * @returns 봇의 판단. 못 물어봤거나 못 읽었으면 `undefined`
   */
  private async askBotApprover(
    room: Room,
    asker: BotInstance,
    judgeId: string,
    req: PermissionRequest,
  ): Promise<PermissionDecision | undefined> {
    const judge = room.participants.find((b) => b.id === judgeId);
    const hand = (why: string): undefined => {
      // **조용히 넘기지 않는다.** 맡겼다고 생각하고 자리를 비우면 안 된다.
      this.port.emitNotice(room.id, `${why} 직접 물어봅니다 — «${req.title}»`);
      return undefined;
    };

    if (!judge) return hand("심사를 맡긴 봇이 방에 없어");
    // **자기 자신은 심사하지 않는다** (§4.2.2). 같은 맥락에 있는 쪽이
    // «해도 된다»고 답하는 것은 심사가 아니라 메아리다.
    if (judge.id === asker.id) return hand("자기 자신은 심사할 수 없어");

    if (!this.port.botRuntime(room.id, judge.id).sessionId) {
      return hand(`${judge.name}의 세션이 아직 열리지 않아`);
    }

    /*
     * ★ **심사를 재귀시키지 않는다** (§4.2.2).
     *
     * 심사를 맡고 있는 봇이 스스로 권한을 요청하면 그 요청은 **사용자에게**
     * 간다. 안 그러면 A가 B에게, B가 A에게 묻는 고리가 생긴다.
     */
    /*
     * ★ **심사 중인 봇의 요청은 사람에게 — 재귀 금지** (§4.2.2).
     *
     * 안 그러면 A가 B에게, B가 A에게 묻는 고리가 생긴다 — 서로의 판정을 기다리며
     * 둘 다 얼어붙는다.
     *
     * 🔴 **예전엔 `judging` 이라는 칸을 따로 들었는데, 아무도 안 채웠다**
     * (리팩토링 ⑦-3 에서 찾았다). `baacde7`(권한을 큐로 넘긴 커밋)에서 넣던 줄이
     * 같이 걷혀, 그 뒤로 막이 **늘 비어 있었다.** 검사는 그 칸을 손수 채워 통과했다.
     *
     * ★ 이제 **큐에서 읽는다** — 그 봇 큐에 남이 맡긴 권한 항목이 남아 있으면 심사
     * 중이다. 따로 적는 칸이 없으니 **적는 걸 잊을 일도 없다.**
     */
    const judging = this.port.queue.pending(asker.id).some((i) => i.kind === "permission");
    if (judging) return hand("심사를 맡고 있는 중이라");
    /*
     * ★ **심사 봇이 정말 답할 수 있나** (리팩토링 ⑦-2, 2026-10-20).
     *
     * 🔴 심사 봇이 판정하는 길은 MCP 의 `check_queue`·`verdict` 뿐이다. 그 도구가
     * 그 세션에 없으면 큐에 넣어봐야 **판정이 영영 안 온다** — 요청한 봇의 턴이
     * 얼고, 사람이 가로채야 풀린다. 그래서 셋을 본다:
     *
     *   MCP 가 지금 살아 있나 · 그 세션을 열 때 우리 도구를 실어 보냈나
     *   · 그 에이전트가 http MCP 를 받나 (모르면 믿는다 — BUMP ⑩ 이 잰다)
     *
     * 하나라도 아니면 **처음부터** 사람에게 묻는다.
     */
    if (!this.port.mcpReady()) return hand("봇끼리 말하는 길(MCP)이 꺼져 있어");
    if (!this.port.botRuntime(room.id, judge.id).mcpOffered) {
      return hand(`${judge.name}의 세션에 심사 도구가 안 붙어 있어`);
    }
    if (this.port.mcpHttp(judge.agentId) === false) {
      return hand(`${judge.name}은(는) 우리 도구를 받지 못하는 에이전트라`);
    }

    /*
     * ★ **«이번만» 선택지가 없으면 애초에 안 넘긴다** (v3.0 3-I).
     *
     * 🔴 `verdict` 는 **불리언**이라 봇이 `optionId` 를 지어낼 수 없다 —
     * 우리가 `allow_once`·`reject_once` 로 옮긴다. 그런데 에이전트가 그
     * 선택지를 안 줬으면 **옮길 데가 없다.**
     *
     * ⏪ 예전에는 답을 받은 **뒤에** 그걸 알았다. 그러면 심사 봇의 턴을 한
     * 번 쓰고 나서 사용자에게 넘기게 된다 — **값을 치르고 아무것도 안 사는**
     * 꼴이다. 넣기 전에 본다.
     *
     * ★ **«항상»은 매핑에 없다.** `*_always` 는 이 요청 하나를 넘어 앞으로를
     * 바꾸므로, 프롬프트 인젝션 한 번의 값이 «이번 편집»이 아니라 «앞으로
     * 전부»가 된다. 사람은 고를 수 있다 — 그건 **사람이 스스로에게 준 권한**이다.
     */
    const allow = req.options.find((o) => o.kind === "allow_once");
    const reject = req.options.find((o) => o.kind === "reject_once");
    if (!allow || !reject) return hand("«이번만» 선택지가 없어");

    /*
     * ★ **큐에 넣는다 — 턴을 가로채지 않는다** (v3.0 3-I).
     *
     * ⏪ 여기서 `runQueue` 를 직접 불렀다. 그러면 들어가자마자 `releaseTurn`
     * 으로 **그 봇이 돌던 턴을 닫고 자리를 가져간다** — 실측에서 «긴 일 좀
     * 해줘» 의 답 자리에 심사 판결이 들어앉았다.
     *
     * 그걸 막으려고 «앞 일이 끝날 때까지 90초 줄서기» 를 뒀었는데, 줄을 선
     * 이유가 **턴 하나를 써야 해서**였다. 큐는 턴을 안 쓴다 — 봇이 제 턴에
     * 꺼내 보고 답한다. 줄 설 이유가 통째로 사라졌다.
     */
    const id = this.port.queue.put({
      kind: "permission",
      to: judge.id,
      from: asker.name,
      fromId: asker.id,
      title: req.title,
      ...(req.kind ? { tool: req.kind } : {}),
      ...(req.command ? { command: req.command } : {}),
      ...(req.paths?.length ? { paths: req.paths } : {}),
      ...(req.diff ? { diff: req.diff } : {}),
      readOnly: req.readOnly,
    });

    /*
     * ★ **기다리는 것은 보이고, 가로챌 수 있어야 한다** (§4.2.2).
     *
     * 기다리는 동안 **요청한 봇의 턴은 얼어 있다.** 심사 봇이 언제 제 턴을
     * 돌릴지는 알 수 없으므로, 보이는 것만으로는 부족하고 **빠져나올 길**이
     * 있어야 한다.
     */
    const wait: ReviewWait & { takenOver?: boolean } = {
      id,
      roomId: room.id,
      askerBotId: asker.id,
      judgeBotId: judge.id,
      title: req.title,
      since: Date.now(),
    };
    this.reviews.set(id, wait);
    this.emitReviews(room.id);

    /*
     * ★ **심사 봇도 깨운다** (v3.0 4-J).
     *
     * ⏪ §3-I 에서는 «봇이 제 턴에 꺼내 본다»에 기대고 넘어갔다. 그런데 **그
     * 턴이 영영 안 올 수 있다** — 심사만 맡고 아무도 말을 안 거는 봇이 그렇다.
     * 요청한 봇은 그동안 `request_permission` 에 **얼어 있다.**
     */
    this.port.maybeWake(room, judge.id);

    return await new Promise<PermissionDecision | undefined>((settle) => {
      this.queued.set(id, {
        settle,
        allowId: allow.optionId,
        rejectId: reject.optionId,
        roomId: room.id,
        ...(req.toolCallId ? { toolCallId: req.toolCallId } : {}),
      });
    });
  }
}
