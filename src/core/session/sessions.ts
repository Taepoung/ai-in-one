/**
 * ★ **세션** — 붙이기 · 되살리기 · 이어가기 (리팩토링 ⑧ L3, 2026-10-20).
 *
 * 봇 하나에 세션 하나(B1). 여기서 세션을 **열고**(`open` · `ensure`), 못 이어받은
 * 것을 **다시 붙여 보고**(`retryResume`), 끊긴 맥락을 어떻게 할지 **정하고**
 * (`decideRefeed`), 붙은 뒤 사용자가 고른 것들을 **되살린다**(`restoreChoices`).
 *
 * 받는 것은 `SessionsPort` 가 전부다 — 아래층 넷(방 저장 · 봇 상태 · 연결 풀 · 설정)과
 * MCP 서버 하나, 그리고 **갈고리 하나**(`watch` — 세션이 열린 뒤 혼자 말하는 것을
 * 받기 시작한다. 그건 턴 사건 처리의 일이다). 처음 떼려 했을 때 스무 칸이던 문이
 * 아래층부터 떼고 나니 이만큼이 됐다(`src/core/README.md`).
 *
 * 분기(fork)는 손님이다 — `ensure` · `restoreChoices` · `mcpFor` 를 쓴다.
 */
import type * as acp from "@agentclientprotocol/sdk";

import { describe, OUR_MCP_NAME } from "../acpConnection.js";
import { messageId } from "../ids.js";
import type { McpServer } from "../mcpServer.js";
import { rollUpLost, whose, type Rooms } from "../room/rooms.js";
import type { Runtimes } from "../room/runtimes.js";
import { withTimeout } from "../time.js";
import type { AgentDef, BotInstance, Message, Room } from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";
import type { SessionConfig } from "./config.js";
import type { AgentPool } from "./pool.js";

/** 세션 하나를 여는 데 기다려 주는 시간 — 띄우기는 `START_MS` 가 따로 잰다 */
const SESSION_MS = 30_000;

/**
 * 이어받기가 «다른 클라이언트가 쥐고 있어서» 실패했나 — 애드온에게 묻는다
 * (`AgentDef.sessionInUse`). 애드온이 없거나 터지면 **모른다** — 예전처럼 새로 연다.
 */
function inUse(agent: AgentDef, reason: string | undefined): boolean {
  if (!agent.sessionInUse || !reason) return false;
  try {
    return agent.sessionInUse(reason);
  } catch {
    return false;
  }
}

/**
 * 칸 하나의 **보이는 이름** (`opus` → `Opus 5`). 없으면 id 를 그대로 돌려준다.
 *
 * 사용자가 고른 것은 이름 쪽이다 — 시스템 줄에 `sonnet` 이라고 적으면
 * «내가 고른 그것» 과 같은 것인지 한 번 더 생각해야 한다.
 */
function nameOf(
  options: acp.SessionConfigOption[],
  id: string,
  value: unknown,
): string | undefined {
  const opt = options.find((o) => o.id === id);
  if (!opt || opt.type !== "select") return undefined;
  for (const entry of opt.options) {
    const found =
      "group" in entry
        ? entry.options.find((v) => v.value === value)
        : entry.value === value
          ? entry
          : undefined;
    if (found) return found.name;
  }
  return undefined;
}

/** 칸 범주를 사람 말로. 에이전트가 주는 이름은 영어다 (`Model`) */
const CONFIG_WORD: Record<string, string> = {
  model: "모델",
  mode: "권한 모드",
  thought_level: "사고 강도",
};

/** 세션층이 받는 것 — 이게 전부다 */
export interface SessionsPort {
  readonly host: WorkspaceHost;
  /** 우리 MCP 서버 — 꺼져 있으면 없다 */
  readonly mcp: McpServer | undefined;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  readonly pool: AgentPool;
  readonly config: SessionConfig;
  /** 그 에이전트의 정의 — 모르면 던진다 */
  agent(agentId: string): AgentDef;
  /** 방의 유일한 봇 — 둘 이상이면 없다 */
  soleBot(room: Room): BotInstance | undefined;
  /** ★ 세션이 열렸다 — 혼자 말하는 것을 받기 시작한다 (턴 사건 처리의 일) */
  watch(room: Room, bot: BotInstance, sessionId: string): void;
  emitNotice(roomId: string, text: string): void;
  emitRoom(room: Room): void;
}

export class Sessions {
  constructor(private readonly port: SessionsPort) {}

  /**
   * 세션을 열고 방 만들기에서 고른 설정을 적용한다.
   *
   * **첫 프롬프트 전이라 모델 변경 비용이 0이다** — 그래서 사용자 입장에서는
   * "만들 때 고른 것"과 같다 (B15).
   */
  async open(
    room: Room,
    bot: BotInstance,
    configValues?: Record<string, string | boolean>,
  ): Promise<void> {
    const conn = this.port.pool.connection(bot.agentId);
    const bt = this.port.runtimes.bot(room.id, bot.id);

    this.port.runtimes.setStatus(room.id, "connecting", bot.id);
    const { sessionId, configOptions } = await conn.newSession(room.cwd, this.mcpFor(room, bot), () =>
      this.port.emitNotice(room.id,
        `${this.port.agent(bot.agentId).label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`,
      ),
    );

    bt.sessionId = sessionId;
    /*
     * ★ **열쇠를 이 세션에 맨다** (2026-10-15). 내줄 때는 세션 id 가 없었다 —
     * `session/new` 의 **인자로** 나가므로 답이 와야 알았다. 매어두면 그
     * 세션이 바뀔 때 **그 열쇠만** 거둘 수 있다.
     */
    this.port.mcp?.tie(`${room.id}:${bot.id}`, sessionId);
    this.pointAt(bot, sessionId);
    bt.roleInjected = false;
    delete bt.rosterSent;
    // 세션을 연 **직후부터** 듣는다 — 명령 목록이 여기서 온다 (A11)
    this.port.watch(room, bot, sessionId);
    // 세션이 들고 있는 값이 답이다 — 사용자가 안 골랐으면 에이전트 기본값이 온다
    if (configOptions.length > 0) this.port.config.note(room, bot, configOptions);

    for (const [configId, value] of Object.entries(configValues ?? {})) {
      try {
        const updated = await conn.setConfigOption(sessionId, configId, value);
        this.port.config.note(room, bot, updated);
        if (typeof value === "string") this.port.config.rememberModel(bot.agentId, configId, value);
      } catch (err) {
        this.port.host.log(`[${bot.agentId}] 설정 적용 실패 (${configId}): ${describe(err)}`);
      }
    }

    await this.port.rooms.saveProps(room, { participants: room.participants });
    this.port.runtimes.setStatus(room.id, "idle", bot.id);
  }

  /**
   * 쓸 수 있는 세션을 확보한다.
   *
   * **저장된 세션에 다시 붙는 것을 먼저 시도한다 (F7).** 에이전트 CLI가 세션을
   * 디스크에 남기므로, VSCode를 껐다 켜도 원래 세션으로 돌아가면 계획·메모리·
   * 도구 이력까지 살아난다. 새로 만들면 대화 텍스트조차 모르는 상태가 된다.
   */
  async ensure(room: Room, bot: BotInstance): Promise<string> {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    if (bt.sessionId) return bt.sessionId;

    const conn = this.port.pool.connection(bot.agentId);

    /*
     * 🔴 **말을 안 건 세션은 이어받으려 하지 않는다** (2026-10-02).
     *
     * 에이전트는 **첫 프롬프트를 받아야** 세션을 디스크에 남긴다
     * (§13.1 실측). 그래서 만들기만 하고 말은 안 건 세션은 **없어진 게
     * 아니라 처음부터 없고**, 이어받기는 반드시 실패한다.
     *
     * ⏪ 아래에 이미 같은 생각으로 막은 줄이 있었는데 **눈금이 한 칸
     * 어긋났다** — «방에 말이 있나» 로 보고 있었다. 그런데 말을 건
     * 것은 **봇마다** 다르다. Claude 가 떠든 방에 Codex 를 불러놓고
     * 안 시켰으면, 방엔 말이 있지만 **그 봇의 세션은 비어 있다.**
     * 그때 사용자가 본 것이 이것이다:
     *
     * ```
     * 아직 이어받을 수 없습니다 — Internal error —
     * no rollout found for thread id 01a0fb40-…
     * ```
     *
     * 우리가 지운 게 아니다. **쓴 적이 없어 써지지 않은 것**을 달라고
     * 한 것이다. 지우는 쪽(`deleteSession`)은 이미 봇 단위로 보고 있었다
     * (`sessionPrompted`) — 이어받는 쪽만 안 보고 있었다.
     */
    if (bot.sessionId && !bot.sessionPrompted) {
      bot.sessionId = null;
    }

    /** 이어받기가 실패했을 때 들고 있는 줄 — **새 세션이 열려야** 적는다 */
    let lostNote: string | undefined;

    if (bot.sessionId) {
      const resumed = await conn.resumeSession(bot.sessionId, room.cwd, this.mcpFor(room, bot));
      if (resumed.ok) {
        bt.sessionId = bot.sessionId;
        // 복구된 세션은 역할을 이미 알고 있다
        bt.roleInjected = true;
        // **이 방이 지금 어떤 모드·모델인지는 복구 응답에만 있다.**
        // 다만 사용자가 고른 값은 우리 기록이 우선이다 — 먼저 되살린다.
        if (resumed.options.length > 0) {
          await this.restoreChoices(room, bot, bot.sessionId, resumed.options);
        }
        this.port.watch(room, bot, bot.sessionId);

        /*
         * ★ **잃었다고 표시해둔 그 세션에 다시 붙었으면 표시를 걷는다.**
         *
         * 🔴 복구 실패는 일시적일 수 있어서 `contextLost`를 디스크에 남긴다.
         * 그런데 나중에 **저절로 붙었을 때** 그걸 지우는 코드가 없었다 —
         * «다시 시도»를 눌렀을 때만(`retryResume`) 지웠다. 그래서 한 번 실패한
         * 방은 **다시 붙은 뒤에도** *"에이전트는 위 대화를 모릅니다"* 를 달고
         * 있었다. 실제로는 알고 있는데.
         *
         * 되먹임 약속도 함께 거둔다 — 세션이 이미 아는 대화를 글로 또 밀어넣으면
         * 돈만 쓴다.
         */
        if (bot.lostSessionId === bot.sessionId || bot.contextLost) {
          const promised = bot.refeedPending === true;
          delete bot.contextLost;
          delete bot.lostSessionId;
          delete bot.refeedPending;
          rollUpLost(room);
          await this.port.rooms.saveProps(room, {
            // 방 값은 **요약**이다 — 봇들에서 굴려 올린 것을 그대로 쓴다
            contextLost: room.contextLost,
            lostSessionId: room.lostSessionId,
            refeedPending: room.refeedPending,
          });
          /*
           * ★ **기록에 안 남긴다** (2026-10-13).
           *
           * 여기가 `noteRoom` 이었다 — 디스크에 적히는 **진짜 메시지**라 다음에
           * 열어도 그 자리에 있다. 그런데 **다시 붙은 것은 일이 아니다** —
           * 원래대로 돌아갔다는 말일 뿐이고, 남겨두면 나중에 읽는 사람은
           * «무슨 일이 있었나» 가 된다. 배너가 사라지는 것이 이미 답이다.
           *
           * 사용자: *"완전 모델 변경, 에이전트 변경, 이름 변경, 완전 새 세션,
           * 봇 추가 이런거 아니면 안나와도 될듯, fix에서 인지 가능하니까"*.
           */
          this.port.emitNotice(room.id,
            promised
              ? "이전 세션에 다시 붙었습니다 — 대화를 글로 옮길 필요가 없어졌습니다."
              : "이전 세션에 다시 붙었습니다.",
          );
          this.port.emitRoom(room);
        }
        return bot.sessionId;
      }
      /*
       * ★ **다른 클라이언트가 쥐고 있으면 새로 열지 않는다** (사용자, 2026-10-20).
       *
       * 🔴 여기서 아래로 흘러가면 «이전 세션을 이어받지 못했습니다. 여기서부터는 새
       * 세션입니다» 를 적고 새 세션을 연다 — 저쪽만 닫으면 **그대로 이어받을 수 있는**
       * 세션을 버리는 꼴이다. 아무것도 안 바꾸고(세션 id · 맥락 표시 그대로) **붙지
       * 못함**으로 올린다. 방을 열 때면 붙는 화면이 까닭과 [다시 시도] 를 세우고, 말을
       * 보낼 때면 그 말이 실패로 남는다 — 어느 쪽이든 다시 하면 원래 세션에 붙는다.
       */
      if (inUse(this.port.agent(bot.agentId), resumed.reason)) {
        throw new Error(
          `다른 곳(앱 · CLI · 다른 창)에서 이 세션을 쓰고 있어 이어받지 못했습니다. ` +
            `거기서 닫은 뒤 다시 시도하세요. — ${resumed.reason}`,
        );
      }
      // 복구 실패는 정상 경로다. 새로 열고 **말해준다** —
      // 기록을 되먹이는 건 아직 안 한다(미구현).
      //
      // 🔴 **잃을 게 있을 때만 말한다.** 에이전트는 첫 프롬프트를 받아야 세션을
      // 디스크에 남긴다(§13.1 실측). 그래서 «만들고 말은 안 건» 방의 세션은
      // 없어진 게 아니라 **처음부터 없었고**, 복구는 반드시 실패한다. 방을 열
      // 때마다 세션을 붙이므로(B1) 그대로 두면 **빈 방을 열 때마다**
      // *"맥락이 빠질 수 있습니다"* 가 쌓인다 — 빠질 맥락이 없는데.
      if (room.messages.some((m) => m.role !== "system")) {
        const known = await conn.listSessions(room.cwd);
        const gone = known !== null && !known.includes(bot.sessionId);
        const head = gone
          ? "이전 세션이 에이전트에서 사라졌습니다."
          : "이전 세션을 이어받지 못했습니다.";
        /*
         * ★ **못 이어받은 자리에서는 안 적는다** (2026-10-13).
         *
         * 🔴 여기서 바로 기록에 박았다. 그런데 바로 아래 `newSession` 이
         * **같은 까닭으로 또 실패할 때** — 로그인이 풀렸으면 둘 다 안 된다 —
         * **새 세션도 없는데 「여기서부터는 새 세션입니다」 가 쌓인다.** 방을
         * 열 때마다 한 줄씩 늘어난다. 실제로 다섯 줄을 받았다:
         *
         * ```
         * 이전 세션을 이어받지 못했습니다. … — Authentication required
         * 이전 세션을 이어받지 못했습니다. … — Authentication required
         * …
         * ```
         *
         * **붙다가 걸린 것은 화면이 말한다** — 붙는 화면과 `fix` 가 «로그인이
         * 필요합니다» 를 봇마다 세워준다(4.5-T). 기록에 남길 것은 **정말로
         * 바뀐 것**뿐이다. 그래서 여기서는 **들고만 있고**, 아래에서 새 세션이
         * 진짜로 열렸을 때 한 번 적는다 — 그때서야 「새 세션」 이 참말이 된다.
         */
        lostNote = `${head} 여기서부터는 새 세션입니다. — ${resumed.reason}`;

        // **화면과 에이전트가 어긋났다.** 사용자가 고를 때까지 들고 있는다.
        bot.contextLost = true;
        bot.lostSessionId = bot.sessionId ?? undefined;
        rollUpLost(room);
        await this.port.rooms.saveProps(room, { contextLost: true, lostSessionId: bot.sessionId });
        this.port.emitRoom(room);
      }
    }

    /*
     * 🔴 **한도를 건다** — 안 그러면 저쪽이 답을 안 할 때 영영 기다린다.
     * 띄우는 값은 `startAgent` 가 이미 치렀으므로 여기는 **세션만** 잰다.
     */
    const { sessionId, configOptions } = await withTimeout(
      conn.newSession(room.cwd, this.mcpFor(room, bot)),
      SESSION_MS,
      `${this.port.agent(bot.agentId).label}의 세션이 ` +
        `${Math.round(SESSION_MS / 1000)}초 안에 열리지 않았습니다.`,
    );
    bt.sessionId = sessionId;
    /*
     * ★ **열쇠를 이 세션에 맨다** (2026-10-15). 내줄 때는 세션 id 가 없었다 —
     * `session/new` 의 **인자로** 나가므로 답이 와야 알았다. 매어두면 그
     * 세션이 바뀔 때 **그 열쇠만** 거둘 수 있다.
     */
    this.port.mcp?.tie(`${room.id}:${bot.id}`, sessionId);
    this.pointAt(bot, sessionId);
    /*
     * ★ **여기가 「새 세션」 이 참말이 되는 자리다** (2026-10-13).
     *
     * 위에서 이어받기가 실패했고, 그 뒤 `newSession` 이 **정말로 열렸을 때**만
     * 한 번 적는다. 중간에 터졌으면 이 줄은 안 쌓인다 — 거기까지 오지도 않고
     * `joinFail` 로 빠지므로 화면이 대신 말한다.
     *
     * 🔴 **왜인지도 같이 적는다** (§0 원칙). 이유가 출력 채널에만 있으면
     * 대부분은 안 열어보고, 그러면 «우리가 끊었나»로 남는다.
     */
    if (lostNote) {
      const note: Message = {
        id: messageId(),
        role: "system",
        text: lostNote,
        deliveredTo: [],
        createdAt: Date.now(),
      };
      this.port.rooms.append(room, note);
      void this.port.rooms.saveNewMessage(room, note);
      this.port.emitRoom(room);
    }
    // 세션이 새로 열렸으므로 역할을 다시 넣어야 한다
    bt.roleInjected = false;
    delete bt.rosterSent;
    // 새 세션이면 에이전트 기본값으로 시작한다 — 고른 것들을 다시 넣어준다
    if (configOptions.length > 0) await this.restoreChoices(room, bot, sessionId, configOptions);
    this.port.watch(room, bot, sessionId);

    await this.port.rooms.saveProps(room, {
      participants: room.participants,
      ...(room.contextLost ? { contextLost: true } : {}),
    });
    return sessionId;
  }

  /**
   * 끊긴 맥락을 어떻게 할지 정한다 (F7).
   *
   * `true`면 **다음 메시지에** 지금까지의 대화를 함께 보낸다. 별도 턴을 쓰지
   * 않으므로 «이어가기»를 눌러도 화면에서는 아무 일도 안 일어난다 — 배너가
   * *"다음 메시지에 함께 전달됩니다"* 로 바뀌는 것이 피드백이다.
   *
   * `false`면 그냥 새 대화처럼 간다. **다시 묻지 않는다.**
   */
  async decideRefeed(roomId: string, accept: boolean, kind?: "log" | "summary"): Promise<void> {
    const room = await this.port.rooms.openRoom(roomId);
    /*
     * ★ **맥락을 잃은 봇들에게만** 건다 (B1).
     *
     * 🔴 방에 하나로 두었더니 **먼저 말을 거는 봇이 남의 되먹임을 먹었다** —
     * 알파가 잃은 맥락이 베타에게 들어가고, 한 번 쓰이면 꺼지므로 정작
     * 알파는 못 받았다. 실측으로 확인한 자리다.
     */
    const lost = room.participants.filter((b) => b.contextLost);
    for (const b of (lost.length > 0 ? lost : room.participants)) {
      delete b.contextLost;
      /*
       * 🔴 **놓는 것과 두고 오는 것은 다르다** (2026-10-07).
       *
       * 사용자가 물었다 — *"대화 도중에 에이전트 바꾸면 이전
       * 에이전트에 물려있던 세션은 자동으로 삭제되나?"*. 안 됐었다.
       *
       * 갈아탈 때는 `cancel` 만 하고 **되돌릴 수 있게** 남겨두었는데,
       * 바로 여기서 `lostSessionId` 를 버린다 — 그 순간부터 **우리는
       * 돌아갈 길이 없는데 세션만 남는** 꼴이 된다. 그래서 버리는
       * 자리에서 같이 지운다 — 방을 나갈 때와 같은 기준이다.
       *
       * ⚠️ **없는 연결을 새로 띄우지는 않는다.** 세션 하나 지우려고
       * 파이썬 서버를 20초 띄우는 것은 바꿔치기다. 갈아탄 직후라면
       * 그 연결은 보통 살아 있다.
       */
      const lostId = b.lostSessionId;
      const lostAgent = b.lostAgentId ?? b.agentId;
      const lostTalk = b.lostPrompted ?? true;
      delete b.lostSessionId;
      delete b.lostAgentId;
      delete b.lostPrompted;
      if (lostId) {
        await this.port.pool.get(lostAgent)
          ?.deleteSession(lostId, lostTalk)
          .catch(() => undefined);
      }
      if (accept) {
        b.refeedPending = true;
        /* 무엇을 넘길지도 같이 정한다 — 안 주면 원문이 기본이다 */
        if (kind) b.refeedKind = kind;
        else delete b.refeedKind;
      } else {
        delete b.refeedPending;
        delete b.refeedKind;
      }
    }
    rollUpLost(room);
    await this.port.rooms.saveProps(room, {
      participants: room.participants,
      contextLost: room.contextLost,
      refeedPending: room.refeedPending,
      lostSessionId: room.lostSessionId,
    });
    this.port.emitRoom(room);
  }

  /**
   * 못 이어받은 세션에 **다시 붙어본다** (F7).
   *
   * 🔴 복구 실패가 늘 영구적인 건 아니다 — 에이전트가 늦게 떴거나 잠깐 바빴던
   * 것뿐일 수 있다. 그래서 실패했다고 바로 갈아타지 않고 옛 id를 들고 있다가
   * 여기서 한 번 더 시도한다. **되면 대화가 통째로 돌아온다.**
   */
  async retryResume(roomId: string): Promise<boolean> {
    const room = await this.port.rooms.openRoom(roomId);
    // 맥락을 잃은 **그 봇**을 찾는다 — 방 값은 요약일 뿐이다
    const bot = room.participants.find((b) => b.lostSessionId) ?? this.port.soleBot(room);
    const lost = bot?.lostSessionId ?? room.lostSessionId;
    if (!bot || !lost) return false;

    const resumed = await this.port.pool.connection(bot.agentId)
      .resumeSession(lost, room.cwd, this.mcpFor(room, bot));
    if (!resumed.ok) {
      this.port.rooms.noteRoom(room, `아직 이어받을 수 없습니다 — ${resumed.reason}`);
      return false;
    }

    const bt = this.port.runtimes.bot(room.id, bot.id);
    bt.sessionId = lost;
    bt.roleInjected = true;
    bot.sessionId = lost;
    bot.sessionPrompted = true;
    // 되살아난 것은 **이 봇**이다 — 다른 봇이 잃은 것까지 걷으면 안 된다
    delete bot.contextLost;
    delete bot.refeedPending;
    /* 이쪽은 **되살린** 것이다 — 지우면 안 된다. 자국만 같이 치운다 */
    delete bot.lostSessionId;
    delete bot.lostAgentId;
    delete bot.lostPrompted;
    rollUpLost(room);

    if (resumed.options.length > 0) await this.restoreChoices(room, bot, lost, resumed.options);
    this.port.watch(room, bot, lost);

    const note: Message = {
      id: messageId(),
      role: "system",
      text: "이전 세션을 다시 이어받았습니다.",
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.port.rooms.append(room, note);
    await this.port.rooms.saveNewMessage(room, note);
    await this.port.rooms.saveProps(room, {
      participants: room.participants,
      contextLost: room.contextLost,
      refeedPending: room.refeedPending,
      lostSessionId: room.lostSessionId,
    });
    this.port.emitRoom(room);
    return true;
  }

  /**
   * 세션을 붙인 직후, **사용자가 고른 것들을 되살린다** (D2·B15).
   *
   * 🔴 저장만 하고 **다시 적용한 적이 없었다.** `bot.agentMode`·`bot.model`에
   * 담아두고 주석에는 *"다음에 열 때 다시 적용할 수 있게"* 라고 써두고선 적용하는
   * 코드가 없었다. 게다가 복구 응답을 그대로 받아 적느라(`noteRoomConfig`)
   * **세션이 말하는 기본값으로 우리 기록까지 덮어썼다** — Sonnet으로 쓰던 방이
   * 창을 껐다 켜면 Opus로 돌아오고, 디스크에서도 지워졌다.
   *
   * 그래서 **덮어쓰기 전에 먼저 적용한다.** 세션이 이미 같은 값이면 아무것도
   * 하지 않는다. 하나를 바꾸면 다른 선택지가 함께 바뀔 수 있으므로(B15)
   * **응답으로 받은 목록을 다음 판단에 쓴다.**
   */
  async restoreChoices(
    room: Room,
    bot: BotInstance,
    sessionId: string,
    options: acp.SessionConfigOption[],
  ): Promise<void> {
    const want = bot.configValues ?? {};
    let now = options;
    /**
     * ★ **사라진 칸을 모아둔다** (2026-09-29).
     *
     * 아래에서 «안 주는 값이면 우기지 않는다» 로 접는데, 접고 **말을 안 했다.**
     * 그래서 CLI 가 올라가며 모델 하나가 목록에서 빠지면 — 이름이 바뀌든
     * 내려가든 실제로 일어난다 — Sonnet 으로 쓰던 방이 창을 껐다 켜면 조용히
     * Opus 가 되어 있었다. 게다가 바로 뒤 `noteRoomConfig` 가 저장값까지
     * 덮으므로 **되돌릴 근거도 남지 않았다.**
     *
     * 접는 것 자체는 맞다 — 세션이 진실이다. 다만 §0 뺄셈 규칙대로,
     * **뺐으면 적는다.**
     */
    const gone: Array<{ id: string; category?: string; was: string; value: string }> = [];

    // **권한을 먼저.** 모델·강도를 바꾸는 사이에도 권한은 지켜져야 한다.
    const order = (o: acp.SessionConfigOption) => (o.category === "mode" ? 0 : 1);
    for (const opt of [...options].sort((a, b) => order(a) - order(b))) {
      const value = want[opt.id];
      if (value === undefined) continue;

      const live = now.find((o) => o.id === opt.id);
      if (!live) continue;

      /*
       * 🔴 **«지금 값과 같다» 고 넘어가면 사라진 걸 못 본다** (2026-10-06).
       *
       * 예전엔 `live.currentValue === value` 이면 바로 `continue` 했다. 고쳐줄
       * 게 없으니 맞는 말 같은데, **사라지는 것과 바뀜는 것은 다르다.**
       * 세션은 여전히 그 모델로 돌고 있으므로 둘은 같은데, 그 모델이
       * **고를 수 있는 목록에서는 빠졌을** 수 있다.
       *
       * 실제로 그렇게 됐다. Codex 의 `~/.codex/models_cache.json` 은 모델마다
       * `visibility` 를 들고 있고 **서버가 내려준다** — `gpt-5.5` 가 닷사이에
       * `list` 에서 `hide` 로 바뀜었다. 우리 핀은 그대로였는데도.
       * 그런데 여기서 넘어가는 바람에 **막음 화면이 안 떠고** 그대로
       * 보내서, 사용자는 채팅창에서 404 를 받았다:
       *
       * ```
       * The model gpt-5.5 does not exist or you do not have access to it.
       * ```
       *
       * 그래서 **아직 고를 수 있나를 먼저 본다.** 같은지는 그 다음이다.
       */
      if (live.type === "select") {
        const offered = live.options.some((e) =>
          "group" in e ? e.options.some((v) => v.value === value) : e.value === value,
        );
        if (!offered) {
          gone.push({
            id: live.id,
            // **무엇이 없어졌나** — 다시 고를 때 «이것이 없어졌습니다» 를 적으려면 필요하다
            value: String(value),
            ...(live.category != null ? { category: live.category } : {}),
            // 이 값은 **이미 목록에 없으므로** 지금 목록에서는 이름을 못 찾는다.
            // 모델이라면 지난 세션에서 받아 적어둔 이름이 남아 있다.
            was: (live.category === "model" ? bot.modelLabel : undefined)
              ?? nameOf(options, live.id, value)
              ?? String(value),
          });
          continue;
        }
      }

      /* 여전히 고를 수 있고 이미 그 값이면 건드릴 것이 없다 */
      if (live.currentValue === value) continue;

      try {
        now = await this.port.pool.connection(bot.agentId).setConfigOption(sessionId, opt.id, value);
      } catch (err) {
        this.port.host.log(`[${bot.agentId}] ${opt.id} 복원 실패: ${describe(err)}`);
      }
    }
    this.port.config.note(room, bot, now);

    // **바뀐 것을 적는다.** 조용히 넘어가면 «왜 얘가 갑자기 딴 소리를 하지»가 된다
    for (const g of gone) {
      const live = now.find((o) => o.id === g.id);
      const label = nameOf(now, g.id, live?.currentValue) ?? String(live?.currentValue ?? "");
      if (!label) continue;
      /*
       * 🔴 **이름이 그대로면 입을 다문다** (2026-09-29).
       *
       * id 만 갈리고 모델은 같은 경우가 있다. 실제로 어댑터 0.81.2 → 0.84.0
       * 에서 `opus[1m]` 이 `opus` 가 되는데 **둘 다 「Opus 5.5」**다. 그대로
       * 두면 모든 방에 이렇게 뜬다:
       *
       *   「Opus 5.5이(가) 더 이상 없어 Opus 5.5(으)로 바뀌었습니다」
       *
       * 읽는 사람에게는 아무 일도 안 일어난 것이고, 그런 줄이 방마다 하나씩
       * 쌓이면 **진짜 변화를 못 알아본다.** 알릴 것이 없으면 안 알린다.
       */
      if (label === g.was) continue;
      const what = (g.category && CONFIG_WORD[g.category]) ?? live?.name ?? g.id;
      this.port.rooms.noteRoom(
        room,
        `${whose(room, bot)}${what} ${g.was}이(가) ` +
          `${this.port.agent(bot.agentId).label}에 더 이상 없어 ${label}(으)로 바뀌었습니다.`,
        "info",
        [bot.id],
      );

      /*
       * ★ **모델이면 알리는 데서 끝내지 않는다 — 고르게 한다** (2026-09-30).
       *
       * 🔴 여기서 접고 남는 것은 «그 판의 기본값» 이고, **그건 계열째 다를 수
       * 있다.** 실측한 것만 둘이다:
       *
       * ```
       * Codex    gpt-6-luna(빠름)  →  gpt-5.6-terra(균형)
       * Claude   sonnet            →  opus
       * ```
       *
       * 우리가 계열을 안 보기 때문이다. 빠른 모델을 쓰려고 고른 방이 조용히
       * 다른 성격으로 넘어간다 — 위 한 줄로는 그게 **얼마나 다른지** 가 안
       * 읽힌다(`6 Luna` 와 `GPT-5.6-Terra` 는 이름만으로 못 잰다).
       *
       * **모델만 그런다.** 권한 모드·사고 강도는 대체돼도 성격이 안 갈린다.
       */
      if (g.category === "model") bot.modelGone = { value: g.value, label: g.was };
    }
  }

  /**
   * 기록이 가리킬 세션을 정한다 (F7).
   *
   * 🔴 **유령으로 진짜를 밀어내지 않는다.** 에이전트는 첫 프롬프트를 받아야
   * 세션을 디스크에 남기므로(§13.1), 말을 안 건 세션 id는 되살릴 수 없다.
   * 그런 id가 기록을 덮으면 **진짜 세션을 가리키던 포인터를 잃는다** —
   * 일시적인 복구 실패 한 번이 영구 손실이 된다. 실제로 그랬다.
   *
   * 그래서 **써본 세션은 써본 세션으로만** 밀어낸다. 새 세션이 프롬프트를
   * 받으면 그때 `notePrompted()`가 기록을 옮긴다.
   */
  private pointAt(bot: BotInstance, sessionId: string): void {
    if (bot.sessionPrompted && bot.sessionId) return;
    bot.sessionId = sessionId;
    bot.sessionPrompted = false;
  }

  /**
   * ★ **이 봇이 쓸 MCP 서버 목록** (v3.0 2-F).
   *
   * 🔴 **세션마다 다른 비밀**을 발급한다. 하나로 돌려쓰면 **봇이 자기 권한
   * 요청을 스스로 승인할 수 있다** — 큐에서 남의 항목을 꺼내는 것을 막을
   * 근거가 사라진다(2-H 의 소유자 검사).
   *
   * 🔴 **포트는 실행마다 바뀐다.** 그래서 «한 번 실어두면 되는» 값이 아니라
   * 세션이 생기거나 다시 붙을 때마다 **지금 주소로** 다시 만드는 값이다.
   *
   * ⚠️ **부르는 자리가 넷이다** — `new`·`resume`·`load`·`fork`. 한 군데만
   * 빠져도 그 길로 선 세션은 **조용히 도구를 잃는다.** 그래서 여기 한 자리에
   * 모으고, `mcpcarry.mts` 가 넷을 다 지킨다.
   */
  mcpFor(room: Room, bot: BotInstance): acp.McpServer[] {
    const server = this.port.mcp;
    const at = server?.current();
    // ★ 무엇을 실어 보냈는지 적는다 — 심사 봇에게 넘길 수 있나가 이걸 본다(⑦-2)
    const bt = this.port.runtimes.bot(room.id, bot.id);
    if (!server || at?.at !== "ready") {
      bt.mcpOffered = false;
      return [];
    }
    bt.mcpOffered = true;
    const owner = `${room.id}:${bot.id}`;
    /*
     * ⏪ **여기서 지난 열쇠를 거두던 것을 물렀다** (사용자, 2026-10-15).
     *
     * 🔴 Antigravity 가 뱉었다: *"The MCP server 'ai-in-one' failed to
     * initialize: … Unauthorized."* — 그쪽은 **한 프로세스가 세션 여럿을
     * 품고** MCP 서버를 이름당 한 번 붙인다. 새 세션을 여느라 열쇠를
     * 바꿔 끼우면, **아직 살아 있는 그 붙임**이 통째로 도구를 잃는다.
     *
     * 지금은 `issue` 가 **최근 몇 개만 남기고** 오래된 것부터 걷는다 —
     * 맵은 안 커지고, 같은 임자의 열쇠는 둘이어도 권한이 똑같다.
     */
    return [{
      type: "http",
      name: OUR_MCP_NAME,
      url: at.url,
      headers: [{ name: "x-aio-secret", value: server.issue(owner) }],
    }];
  }
}
