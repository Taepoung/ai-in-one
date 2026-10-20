/**
 * ★ **턴** — 봇에게 말을 보내고 답을 받는 흐름 (리팩토링 ⑨, 2026-10-20).
 *
 * 줄에 선 말을 묶어 보내고(`runQueue`), 오는 사건을 대화에 적고(`applyEvent`),
 * 턴 밖에서 혼자 말하는 것도 받는다(`watchIdle` · `onIdleEvent`). MCP 수신함에 거리가
 * 생기면 깨운다(`maybeWake`).
 *
 * 받는 것은 `TurnPort` 가 전부다 — 아래층이 다 여기 모인다(방 저장 · 봇 상태 · 연결 풀 ·
 * 큐 · 프롬프트 · 세션 · 활동 · 설정). 위층(보내기/예약)을 부를 일은 **갈고리 둘**로
 * 받는다: 턴이 끝났다(`turnDone` — 예약을 보낼 때인가) · 안 보는 방이면 놓아라
 * (`releaseIfUnseen`).
 */
import type * as acp from "@agentclientprotocol/sdk";

import { describe, type AgentEvent } from "../acpConnection.js";
import { messageId } from "../ids.js";
import type { BotQueue } from "../mcp/botQueue.js";
import type { Rooms } from "../room/rooms.js";
import type { Runtimes } from "../room/runtimes.js";
import type { SessionConfig } from "../session/config.js";
import type { AgentPool } from "../session/pool.js";
import type { Sessions } from "../session/sessions.js";
import type { RoomStore } from "../store.js";
import {
  isBusy,
  taskIdOf,
  type BotInstance,
  type Message,
  type Room,
  type RoomUsage,
} from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";
import type { Activity } from "./activity.js";
import type { Prompts } from "./prompt.js";

/**
 * 턴 밖 발화를 **한 덩어리로 볼** 시간.
 *
 * 이보다 조용했다가 다시 오면 다른 말로 본다 — 한참 전 말풍선에 이어 붙이면
 * 시각이 거짓말을 한다.
 */
const IDLE_BURST_MS = 30_000;

/**
 * 응답이 온 뒤에도 **이만큼은 그 턴의 말로 친다.**
 *
 * 손으로 재보니 늦게 오는 조각은 수십 ms 안에 들어왔다. 여기서 더 늘리면
 * 진짜 턴 밖 발화(A11)까지 삼키게 된다 — 그건 숨기면 안 되는 것이다.
 */
const TURN_TAIL_MS = 1500;

/**
 * 스트리밍 중 응답을 디스크에 남기는 간격.
 *
 * 트랜스크립트가 JSONL이라 **한 줄 덧붙이기**로 끝나므로 대화가 길어져도 비용이
 * 같다. 그래서 받다 만 응답도 남길 수 있다 — 단일 JSON이었다면 매번 전체를
 * 다시 써야 해서 엄두를 못 냈다.
 */
const SAVE_INTERVAL_MS = 2000;

/** 스트리밍 델타마다 전체 방을 내보내면 웹뷰가 감당하지 못한다 */
const EMIT_INTERVAL_MS = 60;

/**
 * **다시 눌러볼 만한 실패인가** (v1.1).
 *
 * `↻ 다시 보내기`를 붙일지 정한다. 나눠야 하는 이유는 **버튼이 약속이기 때문**이다 —
 * 눌러도 같은 벽이면 사용자는 토큰만 쓰면서 «왜 안 되지»를 반복한다.
 *
 * ```
 * 다시 해볼 만하다   한도 · 과부하 · 프로세스 죽음 · 타임아웃 · 연결 끊김
 * 눌러도 그대로     로그인 필요 · 세션 없음 · 내용 거부 · 잘못된 요청
 * ```
 *
 * 🔴 **모르는 것은 «안 된다» 쪽에 둔다.** 반대로 두면 우리가 모르는 새 오류마다
 * 버튼이 뜨고, **되는 척하는 버튼**이 된다. 없는 버튼이 낫다.
 */
function retryable(reason: string): boolean {
  const s = reason.toLowerCase();
  // 사람 손이 필요한 것들 — 여기 걸리면 아무리 눌러도 같다
  if (/auth|login|\ub85c\uadf8\uc778|not found|\ucc3e\uc744 \uc218 \uc5c6|invalid|refus|\uac70\ubd80/.test(s)) return false;
  return /closed|crash|\uc885\ub8cc|overload|rate.?limit|usage limit|quota|\ud55c\ub3c4|too many|timeout|\uc2dc\uac04 \ucd08\uacfc|econnreset|epipe|socket|temporar|unavailable|5\d\d/.test(s);
}

/**
 * 턴이 왜 끝났는지 사용자에게 알릴 말. 정상 종료면 `undefined`.
 *
 * 이걸 버리면 **거부나 길이 초과가 그냥 짧은 응답으로 보인다** — 사용자는
 * 에이전트가 왜 말을 하다 말았는지 알 수 없다.
 */
function stopReasonNote(reason: string): string | undefined {
  switch (reason) {
    case "refusal":
      return "에이전트가 이 요청에 응답하지 않았습니다.";
    case "max_tokens":
      return "응답 길이 제한에 도달해 중간에 끊겼습니다.";
    case "max_turn_requests":
      return "한 턴에서 도구를 너무 많이 호출해 중단되었습니다.";
    case "cancelled":
      return "중단했습니다.";
    default:
      return undefined;
  }
}

/** 턴층이 받는 것 — 이게 전부다 */
export interface TurnPort {
  readonly host: WorkspaceHost;
  readonly disk: RoomStore;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  readonly pool: AgentPool;
  readonly queue: BotQueue;
  readonly prompts: Prompts;
  readonly sessions: Sessions;
  readonly activity: Activity;
  readonly config: SessionConfig;
  /** 사용자가 지금 보고 있는 방 */
  activeRoomId(): string | null;
  /** 내리는 중인가 — 그러면 안 깨운다 */
  isDown(): boolean;
  /** 방의 유일한 봇 — 둘 이상이면 없다 */
  soleBot(room: Room): BotInstance | undefined;
  /** ★ 턴이 끝났다 — 예약해 둔 말을 보낼 때인가 (위층의 일) */
  turnDone(room: Room): void;
  /** ★ 안 보는 방이면 자리를 놓는다 (위층의 일) */
  releaseIfUnseen(roomId: string): void;
  emitMessage(roomId: string, message: Message): void;
  emitRoom(room: Room): void;
  emitRoomError(roomId: string, text: string): void;
}

export class Turns {
  /**
   * 이미 자국을 남긴 압축들 (C11).
   *
   * `compaction_update`는 **같은 id로 여러 번 온다**(진행 → 완료). 그대로
   * 두면 구분선이 겹쳐 쌓인다.
   */
  private readonly compacted = new Set<string>();
  /** 아직 받는 중인 요약 조각들. 열쇠는 둘 다 `방id:압축id`다 */
  private readonly compacting = new Map<string, string>();

  constructor(private readonly port: TurnPort) {}

  async runQueue(
    room: Room,
    batch: Message[],
    botId?: string,
    /**
     * ★ **알림만으로 연 턴인가** (v3.0 4-J).
     *
     * 그때 `batch` 는 **대화에 없는 가짜**다 — 프롬프트를 짓는 데만 쓰고,
     * 자리(`placedAt`)도 실패 표시도 `replyToIds` 도 안 붙인다. 붙이면
     * 디스크에 **아무도 안 만든 말풍선**이 한 줄 남는다.
     */
    wake?: boolean,
  ): Promise<Message | undefined> {
    // 단체방에서는 **멘션된 봇마다** 이 함수가 돈다. 지금은 하나뿐이다.
    const bot = (botId ? room.participants.find((b) => b.id === botId) : undefined)
      ?? room.participants[0]!;
    const bt = this.port.runtimes.bot(room.id, bot.id);
    const conn = this.port.pool.connection(bot.agentId);

    let sessionId: string;
    try {
      this.port.runtimes.setStatus(room.id, "connecting", bot.id);
      sessionId = await this.port.sessions.ensure(room, bot);
    } catch (err) {
      /*
       * 세션을 못 열었으면 **프롬프트가 아예 안 나갔다.** 해당 메시지들을
       * 실패로 표시해 다시 보낼 수 있게 한다 — 그냥 버리면 다시 타이핑해야 한다.
       *
       * 🔴 **어느 봇에게 안 갔는지도 적는다** (2026-10-09). 여기가 `sendFailed`
       * 만 적고 `notSentTo` 를 비워뒀다 — 그래서 `retry` 의 «안 간 봇에게만»
       * 이 **한 번도 안 돌았다.** 빈칸이면 `deliveredTo`(전원)로 떨어지므로,
       * 알파는 멀쩡히 받았는데 ↻ 를 누르면 **알파가 같은 일을 또 한다.**
       * 코딩 에이전트에서는 파일을 두 번 고치는 일이다.
       */
      const reason = describe(err);
      // 🔴 **가짜 묶음에는 안 적는다** — `markNotSent` 는 디스크에 한 줄을
      // 쓰는데, 그 메시지는 `room.messages` 에 없다. 다시 열면 **빈 말풍선**이다.
      if (!wake) for (const m of batch) await this.port.rooms.markNotSent(room, m, bot.id, reason);
      this.port.runtimes.setStatus(room.id, "error", bot.id);
      this.port.emitRoomError(room.id, reason);
      return undefined;
    }

    // ★ **줄에서 나왔다** — 여기서 자리를 잡는다 (대기 정렬)
    for (const m of batch) this.port.rooms.placeNow(room, m);

    /*
     * ★ **이번 턴의 몫을 여기서 떼어낸다** (v3.0 2-H).
     *
     * 🔴 **안 떼면 턴이 안 끝난다.** 봇이 큐를 비우는 사이에 새 것이 들어오면
     * `left` 가 영영 0 이 안 되고, 모델은 «아직 남았구나» 하며 또 꺼낸다 —
     * 들어오는 속도가 처리 속도보다 빠르면 끝이 없다.
     *
     * **프롬프트를 짓기 직전이어야 한다.** 세는 자리와 떼는 자리가 갈리면
     * 프롬프트에 적힌 수와 `check_queue` 가 주는 수가 어긋난다.
     */
    const incoming = this.port.queue.startTurn(bot.id);
    /*
     * ★ **이 턴이 몇 다리 건너온 것인가** (v3.0 4-L).
     *
     * **이 턴을 연 것**의 깊이다(`startTurn` 이 돌려준다). 몫 전체로 재면
     * **답 안 한 옛 항목**이 섞여 다른 사슬이 서로를 오염시킨다.
     *
     * 🔴 **사용자가 말을 걸었다고 0 으로 내리지 않는다.** 한 턴에 사용자 말과
     * **밀려 있던 깊은 항목이 같이** 실릴 수 있다. 그때 턴을 0 으로 내리면
     * 그 깊은 사슬의 답까지 1다리째가 되어, **사용자가 그 봇에게 한 마디만
     * 하면 돌던 사슬이 통째로 되살아난다.**
     *
     * 사용자 말은 «깊이 0 짜리 항목이 하나 더 온 것»이다 — 그래서 `max` 가
     * 저절로 맞는다. 「누가 열었나」는 `fromUser` 가 따로 들고 있다.
     */
    bt.fromUser = batch.some((m) => m.role === "user");
    // 턴마다 새로 — «이 턴의 사용자 말»에 대해 누구에게 보냈나는 턴 안에서만 뜻이 있다
    bt.saidZero = new Set<string>();
    bt.depth = incoming || (bt.fromUser ? 0 : (bt.depth ?? 0));

    const prompt = await this.port.prompts.build(room, bot, bt, batch);

    const reply: Message = {
      id: messageId(),
      role: "agent",
      authorBotId: bot.id,
      text: "",
      deliveredTo: [bot.id],
      // 알림 턴에는 **답할 대상이 없다** — 가짜 id 를 적으면 짝짓기가 깨진다
      ...(wake ? {} : { replyToIds: batch.map((m) => m.id) }),
      /*
       * ★ **봇의 산문은 언제나 «나에게 한 말»이다** (2026-09-29 · v3.0 4-14).
       *
       * ⏪ 그날은 «사용자가 부른 턴이면» 이라고 적고 *"봇끼리 말하기가 들어오면
       * 이 값이 갈린다"* 고 미뤄뒀다. **그날이 왔고, 안 갈린다.**
       *
       * 갈리는 것은 **산문이 아니라 도구 인자**였다. 받는 이를 정하는 것은
       * `@` 도 턴을 연 사람도 아니고 **어디서 왔나**다:
       *
       * ```
       * say(to, …) 의 내용   받는 봇     → 말풍선 하나 (deliveredTo = 그 봇)
       * 그 턴의 산문          없음 → 사용자  → 말풍선 하나 (toUser)
       * ```
       *
       * 알림만으로 깨어난 턴에도 산문은 온다 — 에이전트는 **턴을 말로 닫기**
       * 때문이다. 그 말에 칩이 안 붙으면 «누구에게 한 말인지 알 수 없는 줄»이
       * 하나 생긴다. **없는 것으로 구별하면 약하다.**
       */
      toUser: true,
      createdAt: Date.now(),
      streaming: true,
    };
    this.port.rooms.append(room, reply);

    // **응답 자리를 프롬프트보다 먼저 저장한다.**
    //
    // 이게 없으면 스트리밍 도중에 VSCode가 꺼졌을 때 사용자 메시지만 남고,
    // 다시 켰을 때 "답이 안 달렸으니 전송 실패"로 잘못 판정된다(C5).
    // 실제로는 전송됐고 에이전트가 답까지 했는데 `↻`를 누르면 같은 질문이 두 번 간다.
    await this.port.rooms.saveNewMessage(room, reply);

    this.port.runtimes.setStatus(room.id, "waiting", bot.id);

    // 앞 턴이 유예 중이면 **확정하고** 자리를 받는다 — 그냥 밀어내면 디스크에만 빠진다
    this.releaseTurn(room, bot);
    /*
     * ★ **턴 밖 묶음은 여기서 끝난다** (2026-09-28).
     *
     * 안 끊으면 `IDLE_BURST_MS`(30초) 안에 온 다음 턴 밖 발화가 **턴을 건너뛴
     * 옛 말풍선에** 이어 붙는다 — 사이에 사용자 말과 답이 통째로 들어갔는데도.
     */
    clearTimeout(bt.idleClose);
    bt.idleClose = undefined;
    delete bt.idle;
    // **이 턴의 말은 여기로 모인다.** 리스너를 갈지 않고 표시만 켜둔다 — 이유는 `watchIdle`에.
    bt.turn = reply;
    try {
      const res = await conn.prompt(sessionId, prompt);
      // **이제 이 세션은 디스크에 남는다** — 되살릴 값이 여기서 확정된다 (F7)
      this.notePrompted(room, bot, sessionId);
      if (res.usage) this.applyUsage(room, bot, res.usage);
      // 왜 끝났는지 알려준다. 그냥 두면 거부나 길이 초과가 **짧은 응답**으로 보인다.
      const note = stopReasonNote(res.stopReason);
      if (note) reply.error = note;
    } catch (err) {
      const reason = describe(err);
      reply.error = reason;
      this.port.runtimes.setStatus(room.id, "error", bot.id);

      /*
       * ★ **다시 해볼 만한 실패에는 `↻`를 붙인다.**
       *
       * 한도나 과부하로 막히면 사용자가 할 수 있는 건 «나중에 다시»뿐인데,
       * 그때 **같은 말을 다시 타이핑하게 하면 안 된다.** `sendFailed`를 달아두면
       * 말풍선에 `↻ 다시 보내기`가 붙고, 누르면 `retry()`가 그 메시지를 그대로
       * 다시 보낸다 — 새 말풍선도 안 만든다.
       *
       * 🔴 **두 가지는 안 붙인다.**
       *
       * 1. **이미 일이 일어난 턴** — 에이전트가 말을 했거나 도구를 돌렸으면
       *    되돌릴 수 없는 것이 이미 있다. 다시 보내면 **같은 편집이 한 번 더** 간다.
       * 2. **사람이 풀어야 하는 실패** — 로그인이나 내용 거부는 다시 눌러봐야
       *    같은 벽이다. 누를 수 있게 해두면 누르게 되고, 그때마다 토큰만 쓴다.
       *
       * 모르는 오류는 «안 된다» 쪽이다(`retryable`). 되는 척하는 버튼보다
       * 없는 버튼이 낫다.
       */
      const touched = reply.text.length > 0 || (reply.tools?.length ?? 0) > 0;
      if (!touched && retryable(reason) && !wake) {
        // 🔴 여기도 **어느 봇에게 안 갔는지**를 같이 적는다 (위 주석 참고)
        for (const m of batch) await this.port.rooms.markNotSent(room, m, bot.id, reason);
      }
    }

    /*
     * blob 쓰기가 끝나야 해시가 채워진다 — **이 봇 것만** 기다린다.
     *
     * 🔴 방 단위였을 때는 `length = 0` 이 **옆 봇의 영수증까지 지웠다.**
     * 지워진 쪽은 기다릴 것이 없다고 보고 빈 해시로 저장할 수 있었다.
     */
    if (bt.pendingWrites.length > 0) {
      const mine = bt.pendingWrites.splice(0, bt.pendingWrites.length);
      await Promise.allSettled(mine);
    }

    reply.streaming = false;

    /*
     * ★ **꺼내 본 메시지는 여기서 닫는다** (2026-10-13).
     *
     * 사용자: *"봇이 반응을 나한테 할때, say를 안쓰니까 큐에서 안빠지는 문제가
     * 있네"*. 사용자에게 답하는 것도 반응인데 장부에는 안 빠져서, 그 항목이
     * **영영 몫에 남아** 매 턴 «queue: 1 · do: check_queue» 로 찔렀다.
     *
     * 🔴 **오류로 끝난 턴은 안 닫는다** — 모델이 반응할 기회를 못 가졌을 수
     * 있다. 꺼내 보고 답을 못 한 채 끊긴 것까지 닫으면 그때는 **잃는 것**이다.
     */
    if (!reply.error) this.port.queue.closeSeen(bot.id);

    // 보고 있지 않은 방의 응답만 안 읽은 것으로 센다 (B8)
    if (this.port.activeRoomId() !== room.id) room.unread += 1;

    await this.port.rooms.saveMessage(room, reply);
    await this.port.rooms.saveProps(room, { unread: room.unread, usage: room.usage });
    // 턴이 끝날 때도 바뀐 건 응답 하나다. 방 전체를 보낼 이유가 없다.
    this.port.emitMessage(room.id, reply);
    // **마지막에 놓는다.** 응답보다 늦게 오는 조각이 있어서 — `releaseTurn` 참조
    this.scheduleRelease(room, bot, reply);
    // ★ **이 봇이** 실패한 게 아니면 놓는다 — 다른 봇의 실패가 이 봇을 묶지 않는다
    if (this.port.runtimes.statusOf(room.id, bot.id) !== "error") this.port.runtimes.setStatus(room.id, "idle", bot.id);
    /*
     * ★ **턴 중에 들어온 것은 여기서 깨운다** (v3.0 4-J).
     *
     * 넣는 쪽이 깨우려 했지만 **그때 이 봇은 바빴다.** 스냅샷이 몫을 떼어놔서
     * 그 턴에는 보이지도 않았다 — 턴이 닫히는 지금이 그 다음 자리다.
     */
    this.maybeWake(room, bot.id);
    // 부른 쪽이 **답을 읽어야 할 때가 있다** — 봇 심사(§4.2.2)가 그렇다
    return reply;
  }

  applyUsage(room: Room, bot: BotInstance, usage: acp.Usage): void {
    bot.usage = {
      ...bot.usage,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
      ...(usage.cachedReadTokens != null
        ? { cachedReadTokens: usage.cachedReadTokens }
        : {}),
      ...(usage.cachedWriteTokens != null
        ? { cachedWriteTokens: usage.cachedWriteTokens }
        : {}),
    };
    this.rollUpUsage(room);
  }

  /**
   * 컨텍스트가 얼마나 찼는지 **그 봇에** 적는다.
   *
   * 봇을 모르면(턴에 주인이 없는 희귀한 경우) 방 하나뿐인 봇으로 본다 —
   * 1:1에서는 언제나 맞고, 단체방에서는 모르는 채로 아무 봇에게 씌우지 않는다.
   */
  private noteUsage(
    room: Room,
    botId: string | undefined,
    ev: Extract<AgentEvent, { type: "usage" }>,
  ): void {
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.port.soleBot(room);
    if (!bot) return;
    bot.usage = {
      ...bot.usage,
      contextUsed: ev.used,
      contextSize: ev.size,
      ...(ev.cost ? { cost: ev.cost } : {}),
    };
    this.rollUpUsage(room);
  }

  /**
   * 봇들의 사용량을 **방 하나의 눈금**으로 접는다.
   *
   * 목록의 고리와 «거의 찼다» 경고는 방당 하나뿐이라 숫자가 하나여야 한다.
   * 더하지 않고 **가장 많이 찬 봇**을 고른다 — 셋이 30%씩이라고 90%가 아니다.
   * 컨텍스트는 세션마다 따로 차고, 급한 것은 제일 많이 찬 쪽이다.
   */
  private rollUpUsage(room: Room): void {
    const filled = (u: RoomUsage | undefined): number =>
      u?.contextUsed && u.contextSize ? u.contextUsed / u.contextSize : -1;
    const worst = room.participants.reduce<BotInstance | undefined>(
      (a, b) => (a && filled(a.usage) >= filled(b.usage) ? a : b),
      undefined,
    );
    if (worst?.usage) room.usage = worst.usage;
  }

  applyEvent(room: Room, reply: Message, ev: AgentEvent): void {
    switch (ev.type) {
      case "text":
        reply.text += ev.delta;
        this.port.runtimes.setStatus(room.id, "streaming", reply.authorBotId);
        break;

      case "thought":
        reply.thought = (reply.thought ?? "") + ev.delta;
        break;

      case "tool":
        this.port.runtimes.setStatus(room.id, "tool", reply.authorBotId);
        this.port.activity.recordActivity(room, reply, ev);
        break;

      case "diff":
        this.port.activity.recordDiff(room, reply, ev);
        break;

      // 🔴 **세션마다 오는 값이다.** 방에 적으면 봇이 둘일 때 서로 덮어쓴다
      case "usage":
        this.noteUsage(room, reply.authorBotId, ev);
        break;

      case "commands":
        // 슬래시 명령은 **그 세션이** 광고한 것이다
        if (reply.authorBotId) this.port.runtimes.bot(room.id, reply.authorBotId).commands = ev.names;
        break;

      // 🔴 **압축은 «대화의 사건»이다** (C11). 이 지점부터 에이전트가 아는 건
      // 요약본인데 화면에는 전체가 그대로 보인다. 타임라인에 자국을 남기지
      // 않으면 *"아까 말한 거"* 가 왜 안 통하는지 알 길이 없다.
      //
      // **요약 내용은 안 보여준다.** 사용자가 읽을 것은 자기 대화지 요약이 아니다.
      case "compaction":
        this.noteCompaction(room, reply.authorBotId, ev);
        break;

      // 계획 (계획 모드의 알맹이). 메시지에 붙여 화면에 그대로 보여준다
      case "plan":
        reply.plan = ev.markdown
          ? { markdown: ev.markdown }
          : { entries: ev.entries ?? [] };
        break;

      case "planRemoved":
        delete reply.plan;
        break;

      // 에이전트가 스스로 모드를 바꿨다 — 우리 기록이 낡는다
      case "mode":
        this.noteAgentMode(room, reply.authorBotId, ev.modeId);
        break;

      case "config":
        this.noteAgentConfig(room, reply.authorBotId, ev.options);
        break;

      // 🔴 **모르는 것도 조용히 넘기지 않는다** (§0 P5)
      case "unknown":
        this.port.host.log(`[${room.id}] 아직 다루지 않는 업데이트: ${ev.kind}`);
        break;
    }
    room.lastActivityAt = Date.now();
    this.emitThrottled(room, reply);
    this.saveThrottled(room, reply);
  }

  /**
   * 압축 알림을 방에 반영한다 (C11).
   *
   * **턴 안에서도 밖에서도 온다** — 에이전트는 컨텍스트가 차면 스스로 압축하는데,
   * 그게 우리가 프롬프트를 보낸 동안일 거라는 보장이 없다.
   */
  private noteCompaction(
    room: Room,
    /** **누구의 기억이 줄었나** (v2.1). 압축은 세션 단위라 봇 단위다 (B1) */
    botId: string | undefined,
    ev: { id: string; status: string; summary?: string; summaryDelta?: string },
  ): void {
    // 🔴 **방까지 붙여야 유일하다.** `compactionId`는 스펙상 «세션 안에서»
    // 유일할 뿐이라, 같은 에이전트의 두 방이 같은 id를 쓸 수 있다.
    const key = `${room.id}:${ev.id}`;

    // 요약은 **조각으로 나뉘어 먼저** 올 수 있다. 끝날 때까지 모은다.
    if (ev.summaryDelta) {
      this.compacting.set(key, (this.compacting.get(key) ?? "") + ev.summaryDelta);
    }
    if (ev.status !== "completed" || this.compacted.has(key)) return;
    this.compacted.add(key);

    // `summary`는 «통째로 교체», 조각은 «덧붙이기». 준 쪽을 쓴다.
    const summary = (ev.summary ?? this.compacting.get(key) ?? "").trim();
    this.compacting.delete(key);
    const mark: Message = {
      id: messageId(),
      role: "system",
      text: "여기까지 압축됨 — 위쪽은 에이전트가 요약으로 기억합니다",
      // **그 봇의 기억이 줄어든 것**이다 — 다른 봇은 멀쩡하다 (B1)
      ...(botId ? { aboutBotIds: [botId] } : {}),
      mark: "compaction",
      // 보여주려고 담는 게 아니다 — **되먹일 때 앞부분을 대신한다**(F7)
      ...(summary ? { summary } : {}),
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.port.rooms.append(room, mark);
    void this.port.rooms.saveNewMessage(room, mark);
    this.port.emitMessage(room.id, mark);
  }

  /** 그 세션이 실제로 쓰였다 — 이제 이게 되살릴 값이다 */
  notePrompted(room: Room, bot: BotInstance, sessionId: string): void {
    if (bot.sessionId === sessionId && bot.sessionPrompted) return;
    bot.sessionId = sessionId;
    bot.sessionPrompted = true;
    void this.port.rooms.saveProps(room, { participants: room.participants });
  }

  /**
   * 턴을 놓을 **예약**을 건다 — 응답이 온 순간이 아니라 조금 뒤에 (A11 경계).
   *
   * 🔴 `session/prompt`의 응답과 그 턴의 `session/update`는 **도착 순서가 보장되지
   * 않는다.** 가짜 에이전트로 재보니 8턴 중 2턴에서 응답이 먼저 왔다 — 파이프는
   * 순서를 지키지만 SDK가 그 순서대로 넘겨주지는 않는다.
   *
   * 그래서 응답을 받자마자 턴을 닫으면 **그 턴의 마지막 말이 턴 밖 발화로 오인된다.**
   * 화면에는 «빈 말풍선 + 엉뚱한 자리에 붙은 말»이 되고, 30초 안에 여러 턴이 돌면
   * 그것들이 한 말풍선에 뭉친다.
   */
  private scheduleRelease(room: Room, bot: BotInstance, reply: Message): void {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    if (bt.turn !== reply) return;
    clearTimeout(bt.tail);
    bt.tail = setTimeout(() => this.releaseTurn(room, bot, reply), TURN_TAIL_MS);
  }

  /**
   * 턴을 **지금** 놓는다. 예약이 다 됐거나, 다음 턴이 시작하려 할 때.
   *
   * 🔴 **다음 턴이 밀고 들어올 때 그냥 버리면 안 된다.** 예약해둔 것을 «임자가
   * 바뀌었으니 없던 일»로 치면, 유예 중에 늦게 붙은 조각이 **디스크에만 빠진다** —
   * 화면에는 있는데 껐다 켜면 빈 말풍선이 된다. 실제로 그렇게 나왔다.
   * 그래서 밀려날 때도 **확정하고** 넘긴다.
   *
   * 저장은 **조건 없이** 한다. «바뀌었으면»으로 걸러봤더니, 늦게 온 조각이
   * 마지막 저장과 비교 시점 **사이에** 도착하면 비교 기준이 이미 그걸 품고
   * 있어서 «안 바뀌었다»가 됐다. 줄 하나 더 쓰는 값으로 **화면과 디스크가 같다**를
   * 산다 — JSONL은 같은 id를 병합하고 주기적으로 정리한다(`maybeCompact`).
   */
  private releaseTurn(room: Room, bot: BotInstance, only?: Message): void {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    const pending = bt.turn;
    if (!pending) return;
    // 예약이 걸린 뒤 다른 턴이 자리를 가져갔으면, 그 예약은 남의 것이다
    if (only && pending !== only) return;

    clearTimeout(bt.tail);
    bt.tail = undefined;
    bt.turn = undefined;
    void this.port.rooms.saveMessage(room, pending);
    this.port.emitMessage(room.id, pending);
  }

  /** 세션이 붙어 있는 동안 **계속** 듣는다 (A11) */
  /**
   * 그 세션의 이벤트를 받는다. **리스너는 세션당 하나뿐이다.**
   *
   * 🔴 예전에는 턴이 시작될 때 «턴 리스너»로 갈아끼우고 `prompt()`가 끝나면
   * «턴 밖 리스너»로 되돌렸다. 그런데 **`session/prompt`의 응답과 그 턴의
   * `session/update`는 도착 순서가 보장되지 않는다** — 응답이 먼저 처리되면
   * 리스너는 이미 갈려 있고, 그 턴의 말이 **턴 밖 발화로 오인된다.**
   *
   * 그 결과가 «빈 말풍선 + 그 아래 따로 뜬 말풍선»이고, 30초 안에 여러 턴이
   * 돌면 그것들이 **한 말풍선에 뭉쳐서** `알겠습니다알겠습니다알겠습니다`가 된다.
   *
   * 그래서 **갈아끼우지 않는다.** 리스너는 하나로 두고, 턴이 도는 중인지는
   * `bt.turn`으로 가른다 — 그건 우리가 정확히 언제 놓을지 정할 수 있다.
   */
  watchIdle(room: Room, bot: BotInstance, sessionId: string): void {
    this.port.pool.connection(bot.agentId).listen(sessionId, (ev) => {
      const turn = this.port.runtimes.bot(room.id, bot.id).turn;
      if (turn) this.applyEvent(room, turn, ev);
      else this.onIdleEvent(room, bot, ev);
    });
  }

  /**
   * **턴 밖에서** 온 것들 (A11).
   *
   * 🔴 예전에는 `listen`을 프롬프트 직전에 붙이고 끝나면 뗐다. 그래서 턴 사이에
   * 오는 건 **받는 사람이 없어 그냥 사라졌다.** 실제로 잃고 있던 것들:
   *
   * - `available_commands_update` — 보통 **세션을 열자마자** 온다. 그래서
   *   압축 버튼이 첫 턴을 돌기 전에는 안 보였다
   * - `compaction_update` — 에이전트가 **스스로** 압축하는 시점은 우리 턴과 무관하다
   * - `usage_update` — 컨텍스트가 얼마나 찼는지
   *
   * 🔴 **여기 적혀 있던 설명이 코드와 반대였다** (2026-09-28에 발견).
   * *"말과 도구 호출은 여기서 방에 심지 않는다"* 고 적혀 있었는데, 아래
   * `default:` 는 **심는다**(`idleReply`). 같은 커밋에서 글과 코드가 갈렸고,
   * 그대로 굳었다. 이 파일은 설명으로 굴러가므로 **틀린 설명은 없는 것보다
   * 나쁘다** — 읽고 «안 오는구나» 하고 딴 데를 판다.
   *
   * 실제 규칙은 이렇다: **말과 계획은 방에 심는다.** 턴 밖이라고 버리면
   * «CLI가 준 걸 우리가 숨긴» 것이 된다(§0 P5). 짝지을 응답이 없으면
   * `idleReply` 로 **새 말풍선을 만든다.**
   *
   * ★ **그래서 봇이 스스로 깨어나면 우리는 막지 않는다** — 화면에 그대로 뜬다.
   * 다만 «깨어나는가»는 어댑터에 달린 일이다(`tests/probes/selfwake.cjs` 참조).
   */
  onIdleEvent(room: Room, bot: BotInstance, ev: AgentEvent): void {
    switch (ev.type) {
      case "commands":
        this.port.runtimes.bot(room.id, bot.id).commands = ev.names;
        this.port.emitRoom(room);
        break;

      case "usage":
        this.noteUsage(room, bot.id, ev);
        void this.port.rooms.saveProps(room, { usage: room.usage, participants: room.participants });
        break;

      case "compaction":
        this.noteCompaction(room, bot.id, ev);
        break;

      case "mode":
        this.noteAgentMode(room, bot.id, ev.modeId);
        break;

      case "config":
        this.noteAgentConfig(room, bot.id, ev.options);
        break;

      case "unknown":
        this.port.host.log(`[${bot.agentId}] 아직 다루지 않는 업데이트: ${ev.kind}`);
        break;

      // 🔴 **말과 계획은 방에 심는다.** 턴 밖이라고 버리면 «CLI가 준 걸 우리가
      // 숨긴» 것이 된다(§0 P5). 짝지을 응답이 없으면 **새로 만든다.**
      default: {
        const idle = this.idleReply(room, bot);
        this.applyEvent(room, idle, ev);
        this.scheduleIdleClose(room, bot, idle);
      }
    }
  }

  /**
   * ★ **무엇이 이 말을 깨웠나** (2026-09-28).
   *
   * 깨어난 봇이 **제일 먼저 하는 일은 백그라운드 결과 파일을 읽는 것**이다.
   * 그 파일 이름은 띄울 때 도구 결과에 적혀 왔다 — 양쪽에 같은 조각이 있다.
   *
   * ```
   * 띄울 때   output: "…Output is being written to: …\tasks\bxgzrpssp.output"
   * 깨어나서  paths : ["…\tasks\bxgzrpssp.output"]
   * ```
   *
   * 짚으면 **그 활동이 든 말풍선**을 찾고, 거기서 **원래 요청**까지 간다.
   * 그래서 «도중에 딴 말» 이 있어도 안 흔들린다 — 대화 순서가 아니라 **일** 을
   * 따라가기 때문이다.
   *
   * 🔴 **못 짚으면 아무것도 안 적는다.** 이 연결은 CLI 의 내부 구현(출력 파일을
   * `tasks/<id>.output` 에 쓴다)에 기대고 있어 **언제든 조용히 안 맞게 될 수**
   * 있다. 그때 틀린 곳을 가리키느니 «먼저 보낸 말»로만 두는 편이 낫다.
   */
  private traceWake(room: Room, bot: BotInstance, message: Message): void {
    const want = (message.tools ?? []).map((t) => taskIdOf(t)).find(Boolean);
    if (!want) return;

    for (let i = room.messages.length - 1; i >= 0; i--) {
      const m = room.messages[i]!;
      if (m === message || m.authorBotId !== bot.id) continue;
      const hit = (m.tools ?? []).find((t) => taskIdOf(t) === want);
      if (!hit) continue;
      message.afterToolId = hit.id;
      if (m.replyToIds?.length) message.afterIds = m.replyToIds;
      return;
    }
  }

  /**
   * ★ **턴 밖 발화도 «끝»이 있어야 한다** (2026-09-28).
   *
   * 🔴 없을 때 두 가지가 깨졌다 — 실측으로 잡았다(`tests/selfwake.mts`):
   *
   * ```
   * 상태  : streaming   ← 영영 안 내려온다
   * 미읽음: 1 → 1       ← 안 보는 방인데도 안 오른다
   * ```
   *
   * 상태가 걸리는 쪽이 더 나쁘다. `isBusy` 가 참이라 **다음 말이 줄에 서는데,
   * 줄은 턴이 끝날 때 나간다.** 끝날 턴이 없으므로 **대화가 통째로 멈춘다.**
   *
   * 미읽음 쪽은 조용한 실패다. 이건 **아무도 안 기다리던 말**이라 — 사용자가
   * 물어본 적이 없다 — 표시가 없으면 다른 방에 있다가 영영 모른다. 턴 응답은
   * «내가 물었으니 보러 간다»가 되지만 이건 아니다.
   *
   * 유예는 턴과 **같은 값**을 쓴다. 조각이 이어 오는 동안은 한 묶음이고,
   * 1.5초 조용하면 끝난 것으로 본다.
   */
  private scheduleIdleClose(room: Room, bot: BotInstance, message: Message): void {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    clearTimeout(bt.idleClose);
    bt.idleClose = setTimeout(() => this.closeIdle(room, bot, message), TURN_TAIL_MS);
  }

  private closeIdle(room: Room, bot: BotInstance, message: Message): void {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    bt.idleClose = undefined;
    // 그새 진짜 턴이 시작됐으면 그쪽이 주인이다 — 상태를 가로채면 안 된다
    if (bt.turn) return;
    // 다른 말풍선이 자리를 가져갔으면 이 예약은 남의 것이다 (`releaseTurn` 과 같은 이유)
    if (bt.idle?.message !== message) return;

    this.traceWake(room, bot, message);

    // 보고 있지 않은 방의 말만 안 읽은 것으로 센다 (B8 — 턴 경로와 같은 규칙)
    if (this.port.activeRoomId() !== room.id) room.unread += 1;
    void this.port.rooms.saveMessage(room, message);
    void this.port.rooms.saveProps(room, { unread: room.unread });
    this.port.emitMessage(room.id, message);
    if (this.port.runtimes.statusOf(room.id, bot.id) !== "error") this.port.runtimes.setStatus(room.id, "idle", bot.id);

    /*
     * ★ **올려둔 것도 여기서 본다** (2026-09-28 의 이어달리기 고리가 있던 자리).
     *
     * 🔴 **혼잣말에는 끝낼 턴이 없다.** 봇이 스스로 깨어나 말하는 동안 상태는
     * `streaming` 이고, 그동안 올려둔 글을 내보낼 «턴의 끝»이 아무 데도 없다 —
     * 사용자가 **다음 말을 보낼 때까지** 안 나간다. 여기가 그 자리다.
     */
    this.port.turnDone(room);
    this.port.releaseIfUnseen(room.id);
  }

  /**
   * 턴 밖 발화를 담을 메시지 (A11).
   *
   * 잠깐 조용했다가 다시 오면 **다른 말**로 본다 — 한참 전 말풍선에 이어 붙이면
   * 시각이 거짓말을 한다.
   */
  private idleReply(room: Room, bot: BotInstance): Message {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    const now = Date.now();
    if (bt.idle && now - bt.idle.at < IDLE_BURST_MS) {
      bt.idle.at = now;
      return bt.idle.message;
    }

    /*
     * 🔴 **여기서 «마지막으로 답한 턴»을 물려받았었다.** 그럴듯했지만 틀린다 —
     * 백그라운드가 도는 사이에 사용자가 딴 말을 하면 **그 턴으로 걸린다.**
     * 실제로 «2 더하기 2는?» 을 가리켰다.
     *
     * 이어진 자리는 **깨운 활동을 짚고 나서** `closeIdle` 이 적는다. 못 짚으면
     * 비워 둔다 — 틀린 연결은 없느니만 못하다.
     */
    const message: Message = {
      id: messageId(),
      role: "agent",
      authorBotId: bot.id,
      text: "",
      deliveredTo: [bot.id],
      createdAt: now,
    };
    bt.idle = { message, at: now };
    this.port.rooms.append(room, message);
    void this.port.rooms.saveNewMessage(room, message);
    return message;
  }

  /** 에이전트가 스스로 바꾼 모드를 따라간다 (D2) */
  private noteAgentMode(room: Room, botId: string | undefined, modeId: string): void {
    const bot = room.participants.find((b) => b.id === botId) ?? this.port.soleBot(room);
    if (!bot || bot.agentMode === modeId) return;
    bot.agentMode = modeId;
    void this.port.rooms.saveProps(room, { participants: room.participants });
    this.port.emitRoom(room);
  }

  /** 우리가 안 시킨 설정 변경도 반영한다 (B15) */
  private noteAgentConfig(
    room: Room,
    botId: string | undefined,
    options: acp.SessionConfigOption[],
  ): void {
    const bot = room.participants.find((b) => b.id === botId) ?? this.port.soleBot(room);
    if (!bot) return;
    this.port.config.note(room, bot, options);
    void this.port.rooms.saveProps(room, { participants: room.participants });
    this.port.emitRoom(room);
  }

  /**
   * 스트리밍 중에도 응답을 디스크에 남긴다.
   *
   * 중간에 VSCode가 꺼져도 **받은 데까지는 남는다.** JSONL이라 한 줄 덧붙이기로
   * 끝나므로 대화가 길어져도 비용이 같다.
   */
  private saveThrottled(room: Room, reply: Message): void {
    // **봇마다 따로 솎는다.** 단체방에서 둘이 동시에 답하면 서로의 저장을
    // 밀어내게 되고, 그러면 한쪽 응답이 중간 저장 없이 통째로 날아갈 수 있다.
    const bt = this.port.runtimes.bot(room.id, reply.authorBotId ?? "");
    const now = Date.now();
    if (now - bt.lastSave < SAVE_INTERVAL_MS) return;
    bt.lastSave = now;
    void this.port.disk
      .updateMessage(room, { id: reply.id, text: reply.text })
      .catch((err) => this.port.host.log(`중간 저장 실패: ${describe(err)}`));
  }

  /**
   * 스트리밍 중에는 발행을 솎아낸다.
   *
   * 토큰 델타마다 방 전체를 내보내면 초당 수십 번 전체 대화를 직렬화하게 된다.
   * 턴이 끝날 때 한 번 더 확실히 내보내므로 마지막 델타를 놓치지 않는다.
   */
  private emitThrottled(room: Room, message: Message): void {
    // 같은 이유로 봇마다 따로 (위)
    const bt = this.port.runtimes.bot(room.id, message.authorBotId ?? "");
    const now = Date.now();
    if (now - bt.lastEmit < EMIT_INTERVAL_MS) return;
    bt.lastEmit = now;
    this.port.emitMessage(room.id, message);
  }

  /**
   * ★ **큐에 거리가 있으면 깨운다** (v3.0 4-J).
   *
   * 🔴 **주기적으로 세어보면 안 된다.** «0 이 아니면 알린다»를 돌리면 0 이라고
   * 판단한 **직후에** 들어온 것은 아무도 안 깨운다. 그래서 두 자리에서만 부른다:
   *
   * ```
   * 넣는 쪽      say · 심사 요청 — 놀고 있으면 그 자리에서
   * 턴이 끝날 때  바쁜 동안 들어온 것 — 스냅샷이 떼어놔서 그 턴에는 안 보인다
   * ```
   *
   * **둘을 같이 두면 놓칠 수가 없다.** 그리고 고리가 안 생긴다 — 프롬프트를
   * 보낼 때 `startTurn` 이 다음 몫을 비우므로, 새로 들어온 것이 없으면
   * `waiting` 이 0 이라 여기서 그냥 돌아간다.
   */
  maybeWake(room: Room, botId?: string): void {
    if (this.port.isDown()) return;
    const who = botId
      ? room.participants.filter((b) => b.id === botId)
      : room.participants;
    for (const bot of who) {
      if (this.port.queue.waiting(bot.id) === 0) continue;
      // 바쁘면 안 깨운다 — 지금 도는 턴이 끝나면서 여기를 다시 부른다
      if (isBusy(this.port.runtimes.statusOf(room.id, bot.id))) continue;
      /*
       * ★ **말풍선을 안 만든다** (§4.2.2 가 걱정한 그것).
       *
       * *"에이전트가 스무 번 물으면 대화가 시스템 줄로 덮인다"* — 깨우는 줄은
       * **전달 방식**이지 누가 한 말이 아니다. 실린 말은 이미 말풍선으로 떠
       * 있고(`relaySay`), 이 줄은 그걸 **꺼내 보라고 찌르는 것**뿐이다.
       */
      const poke: Message = {
        id: messageId(),
        role: "system",
        text: "",
        deliveredTo: [bot.id],
        createdAt: Date.now(),
      };
      void this.runQueue(room, [poke], bot.id, true)
        .catch((err) => this.port.host.log(`[${room.id}] 깨우기 실패: ${describe(err)}`))
        .finally(() => this.port.turnDone(room));
    }
  }
}
