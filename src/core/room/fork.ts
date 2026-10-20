/**
 * ★ **분기** — 대화를 갈라 새 방을 만든다 (리팩토링 ⑨, 2026-10-20).
 *
 * 세션층의 **손님**이다 — 세션을 갈라 달라(`forkSession`)고 하고, 안 되면 새 세션을
 * 열어 글로 넘긴다(`freshFork`). 받는 것은 `ForkPort` 가 전부다 — 아래층 넷(방 저장 ·
 * 봇 상태 · 연결 풀 · 세션)과 디스크, 갈고리 하나(`watch`).
 */
import type * as acp from "@agentclientprotocol/sdk";

import { messageId } from "../ids.js";
import type { Runtimes } from "./runtimes.js";
import { rollUpLost, type Rooms } from "./rooms.js";
import type { AgentPool } from "../session/pool.js";
import type { Sessions } from "../session/sessions.js";
import type { RoomStore } from "../store.js";
import {
  ASK_USER,
  inBotView,
  isBusy,
  type AgentDef,
  type BotInstance,
  type ForkFallback,
  type Message,
  type Room,
  type RoomMeta,
} from "../types.js";

/**
 * 갈라낸 세션 하나 (v1.1).
 *
 * **`native`가 핵심이다.** 에이전트가 복제해준 것이면 계획·메모리까지 따라오고,
 * 폴백이면 글만 따라온다 — 사용자에게 다르게 말해야 하는 차이라 숨기지 않는다.
 */
export interface ForkedSession {
  sessionId: string;
  /** 에이전트의 `session/fork`로 갈랐나. 아니면 새 세션이다 */
  native: boolean;
  options: acp.SessionConfigOption[];
  /** 폴백으로 간 이유. 네이티브면 없다 */
  reason?: string;
}

/** 분기 옵션 — 화면이 준다 */
export type ForkOptions = {
  atMessageId?: string;
  title?: string;
  fallback?: ForkFallback;
  /**
   * ★ **이 봇만 가른다** (v2.1 · §5).
   *
   * 🔴 로드맵은 «1:1 뷰에서는 분기 비활성»이라고 적어뒀다 — *"단체방 전체가
   * fork되나, 그 봇만 분리되나"* 하는 모호함 때문이었다. 그런데 모호함을
   * 없애는 길은 **막는 것만이 아니라 뜻을 정해주는 것**도 있다:
   *
   * ```
   * 단체방에서 분기   방 전체가 갈라진다  (여태 하던 것)
   * 뷰에서 분기       그 봇만 갈라진다    (여기)
   * ```
   *
   * ★ **뷰가 곧 «그 봇이 아는 전부»**라(§5) 그걸 그대로 가르면 **정확히 그
   * 맥락의 1:1 방**이 나온다 — 물려받는 대화도 그 봇이 본 것만이다.
   * 남의 줄기를 끌고 가면 새 방의 첫 화면이 **그 봇은 본 적 없는 말**로
   * 채워진다.
   */
  botId?: string;
};

/** 분기층이 받는 것 — 이게 전부다 */
export interface ForkPort {
  /** 새 방을 만드는 곳 */
  readonly disk: RoomStore;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  readonly pool: AgentPool;
  readonly sessions: Sessions;
  /** 그 에이전트의 정의 — 모르면 던진다 */
  agent(agentId: string): AgentDef;
  /** 세션이 열렸다 — 혼자 말하는 것을 받기 시작한다 */
  watch(room: Room, bot: BotInstance, sessionId: string): void;
  emitRoom(room: Room): void;
  emitNotice(roomId: string, text: string): void;
}

export class Forks {
  constructor(private readonly port: ForkPort) {}

  /**
   * 대화를 그 지점에서 갈라 **새 방**을 만든다 (v1.1).
   *
   * 원본은 손대지 않는다. *"이 방향으로 가보고 아니면 되돌아오기"* 가 목적이므로
   * 갈라진 뒤의 두 방은 서로를 모른 채 각자 살아간다.
   *
   * ⚠️ **파일은 갈라지지 않는다** (D1). 두 방이 같은 워크스페이스를 보므로 분기
   * 방에서 고친 코드는 원본 쪽에도 그대로 반영된다. 격리하지 않고 **알린다** —
   * 코드까지 가르려면 git worktree가 필요하고 그건 백로그다.
   *
   * @param atMessageId 여기까지 물려받는다. 없으면 **지금까지 전부**.
   */
  async forkRoom(
    roomId: string,
    opts: ForkOptions = {},
  ): Promise<Room> {
    const parent = await this.port.rooms.openRoom(roomId);

    const only = opts.botId
      ? parent.participants.find((b) => b.id === opts.botId)
      : undefined;
    if (opts.botId && !only) throw new Error("분기할 봇을 찾을 수 없습니다.");

    /*
     * **진행 중인 턴이 있으면 안 된다** (D4). 반쯤 온 응답을 물려받으면 분기가
     * 원본과 다른 지점에서 시작하고, 원본 쪽 턴이 끝나며 덧쓰는 것도 놓친다.
     *
     * ★ 봇 하나만 가를 때는 **그 봇만 본다** — 옆 봇이 도는 것은 이 분기와
     * 상관이 없고(그 말은 이 봇 뷰에 안 들어온다), 막으면 «남이 일하는 동안
     * 내 갈래를 못 딴다»가 된다.
     */
    if (isBusy(only ? this.port.runtimes.statusOf(roomId, only.id) : this.port.runtimes.statusOf(roomId))) {
      throw new Error("진행 중인 턴이 끝난 뒤에 분기할 수 있습니다.");
    }

    if (parent.participants.length === 0) throw new Error("분기할 봇이 없습니다.");

    // 🔴 **이걸 먼저 본다.** 빈 방은 `cut`이 -1이라 지점 검사에 먼저 걸리는데,
    // 그러면 *"분기할 지점을 찾을 수 없습니다"* 라고 말하게 된다 — 지점을 고른 적도
    // 없는 사람에겐 뜻 모를 소리다. 없는 건 지점이 아니라 **대화**다.
    // 봇 하나를 가를 때는 **그 봇이 본 것**으로 따진다 — 방에 대화가 있어도
    // 그 봇과는 한 마디도 안 나눴을 수 있다
    const mine = (m: Message) => (only ? inBotView(m, only.id) : true);
    if (!parent.messages.some((m) => m.role !== "system" && mine(m))) {
      throw new Error(
        only ? `${only.name}와(과) 나눈 대화가 아직 없습니다.` : "아직 나눌 대화가 없습니다.",
      );
    }

    const cut =
      opts.atMessageId === undefined
        ? parent.messages.length - 1
        : parent.messages.findIndex((m) => m.id === opts.atMessageId);
    if (cut < 0) throw new Error("분기할 지점을 찾을 수 없습니다.");

    const inherited = parent.messages.slice(0, cut + 1).filter(mine);
    // 시스템 메시지는 우리 안내다 — 그것만 물려받는 건 분기가 아니라 새 방이다
    if (!inherited.some((m) => m.role !== "system")) {
      throw new Error(
        only ? `${only.name}와(과) 나눈 대화가 아직 없습니다.` : "아직 나눌 대화가 없습니다.",
      );
    }

    /*
     * ★ **참여 봇 전부를 가른다** (v2.0).
     *
     * 분기는 «이 대화를 여기서 두 갈래로»라는 뜻이다. 한 봇만 갈라내면
     * 새 방은 나머지 봇을 잃은 채로 시작하고, 그것은 분기가 아니라 이사다.
     *
     * **병렬로** 가른다 — 세션끼리 무관하고, 봇이 셋이면 순차는 세 배 기다린다.
     * 한 봇이 폴백으로 떨어져도 나머지는 네이티브로 간다(§4.4 «성공분만»).
     */
    const atTail = cut === parent.messages.length - 1;
    const split = only ? [only] : parent.participants;
    const forks = await Promise.all(
      split.map(async (b) => ({
        bot: b,
        forked: await this.forkSession(parent, b, atTail),
      })),
    );
    /*
     * 폴백일 때만 선택이 의미가 있다. 화면이 미리 물어봤으면 그걸 쓰고,
     * **예상 못 한 실패**라 못 물어봤으면 `refeed`로 둔다 — 그쪽이 분기의
     * 목적에 가깝고, 실제 토큰은 **다음 메시지를 보낼 때까지** 안 든다.
     * 방의 배너에서 그 전에 따로 끌 수 있다.
     */
    return this.createRoomFromFork(
      parent, forks, cut,
      opts.title ?? (only ? `${parent.title} — ${only.name}` : undefined),
      opts.fallback ?? "refeed",
      only?.id,
    );
  }

  /**
   * **세션만** 가른다. 방은 만들지 않는다.
   *
   * ★ 방 생성과 나눠둔 이유는 실험실의 LAB-1(KV 캐시 리프레시)이다 — 거기서는
   * 세션만 갈라 한 번 쓰고 버리므로 방이 없어야 한다. 여기서 안 나누면 나중에
   * 다시 뜯어야 한다.
   *
   * ★ **끝에서 가르는 것과 과거 지점에서 가르는 것은 길이 다르다.**
   *
   * ACP `session/fork`에는 «어느 메시지 지점에서»가 **없다** — 세션을 **지금
   * 상태 그대로** 복제할 뿐이다. 그래서 과거 지점 분기는 네이티브로 갈 수 없고,
   * 새 세션을 열어 **물려받은 데까지만** 글로 다시 읽히는 폴백을 쓴다.
   *
   * 폴백이 손해인 건 분명하다(계획·메모리·도구 이력이 안 따라온다). 그래도
   * **되는 척하는 것보다 낫다** — 네이티브로 과거 지점을 가르면 잘라낸 뒤의
   * 대화까지 에이전트가 기억한 채로 시작한다. 화면에는 없는데 상대는 아는,
   * D2가 경계한 바로 그 상태다.
   */
  async forkSession(room: Room, bot: BotInstance, atTail: boolean): Promise<ForkedSession> {
    const conn = this.port.pool.connection(bot.agentId);

    // 가르려면 **붙어 있어야** 한다. 창을 껐다 켠 직후일 수 있다.
    const live = atTail ? await this.port.sessions.ensure(room, bot).catch(() => undefined) : undefined;

    if (live && atTail) {
      /*
       * 🔴 **지금 붙어 있는 세션이 «대화를 나눈 그 세션»인가.**
       *
       * 두 가지가 어긋날 수 있다:
       *
       *   1. 말을 안 건 세션 — 에이전트는 성공한 첫 프롬프트를 받아야 세션을
       *      디스크에 남긴다(§13.1). 갈라도 물려받을 게 없다.
       *   2. **복구에 실패해 새로 연 세션** — 이게 고약하다. `bot.sessionId`는
       *      «유령이 진짜를 밀어내지 않는다»는 규칙(`pointAt`) 때문에 여전히
       *      **잃어버린 진짜 세션**을 가리키는데, 런타임은 방금 연 **빈 세션**을
       *      들고 있다. 그 빈 것을 갈라놓고 *"계획과 파일 기억까지 물려받았습니다"*
       *      라고 말하면 **거짓말**이다 — 사용자는 상대가 다 안다고 믿고 대화한다.
       *
       * 그래서 **둘이 같은 것일 때만** 네이티브로 간다. 아니면 폴백이다:
       * 글로 옮기는 건 비싸지만, 비어 있는 걸 물려받았다고 하는 것보다 낫다.
       */
      if (!bot.sessionPrompted) {
        return await this.freshFork(room, bot, "원본이 아직 에이전트와 대화한 적이 없습니다");
      }
      if (live !== bot.sessionId) {
        return await this.freshFork(
          room,
          bot,
          "원본의 세션이 끊겨 지금은 빈 세션에 붙어 있습니다 — 복제해도 물려받을 것이 없습니다",
        );
      }
      const res = await conn.forkSession(live, room.cwd, this.port.sessions.mcpFor(room, bot));
      if (res.ok) return { sessionId: res.sessionId, native: true, options: res.options };
      return await this.freshFork(room, bot, res.reason);
    }
    return await this.freshFork(
      room,
      bot,
      atTail
        ? "원본 세션에 붙지 못했습니다"
        : "ACP의 세션 분기에는 «어느 지점에서»가 없어 과거 지점은 복제할 수 없습니다",
    );
  }

  /** 폴백 — 새 세션을 열고 **왜 그랬는지** 들고 나온다 */
  private async freshFork(
    room: Room,
    bot: BotInstance,
    reason: string,
  ): Promise<ForkedSession> {
    const conn = this.port.pool.connection(bot.agentId);
    const { sessionId, configOptions } = await conn.newSession(room.cwd, this.port.sessions.mcpFor(room, bot), () =>
      this.port.emitNotice(room.id,
        `${this.port.agent(bot.agentId).label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`,
      ),
    );
    return { sessionId, native: false, options: configOptions, reason };
  }

  /**
   * **분기를 다시 해본다** (v1.1 보완).
   *
   * 네이티브 분기가 실패하면 우리는 `session/new`로 폴백하고 «글만 옮긴다»고
   * 적어둔다. 그런데 그 실패는 **일시적일 수 있다** — 에이전트가 잠깐 바빴거나
   * 막 뜨는 중이었을 수도 있다. 세션 복구 실패(F7)에 «다시 시도»를 둔 것과
   * 똑같은 이유로, 여기에도 한 번 더 해볼 길이 있어야 한다.
   *
   * 되면 **계획과 파일 기억까지 돌아온다.** 되먹임은 글자만 옮기지만 분기는
   * 세션을 복제하기 때문이다.
   *
   * 🔴 **원본이 그 뒤로 더 말했으면 안 한다.** `session/fork`는 «어느 지점에서»를
   * 못 받으므로 **지금 상태**를 복제한다 — 원본이 세 턴을 더 돌았다면 다시
   * 분기한 세션은 그 세 턴까지 알고 있다. 사용자가 고른 지점이 아니다.
   * 그럴 때는 조용히 다른 것을 주지 않고 **안 된다고 말한다**(§0).
   */
  async retryFork(roomId: string): Promise<{ ok: boolean; reason?: string }> {
    const room = await this.port.rooms.openRoom(roomId);
    if (!room.forkedFromRoomId) return { ok: false, reason: "분기된 방이 아닙니다." };

    const failed = room.participants.filter((b) => b.forkFallback);
    if (failed.length === 0) return { ok: false, reason: "다시 할 분기가 없습니다." };
    if (isBusy(this.port.runtimes.statusOf(roomId))) {
      return { ok: false, reason: "응답이 끝난 뒤에 다시 시도할 수 있습니다." };
    }

    let parent: Room;
    try {
      parent = await this.port.rooms.openRoom(room.forkedFromRoomId);
    } catch {
      return { ok: false, reason: "원본 방이 없어졌습니다." };
    }

    // 원본이 더 말했으면 **지금 분기해도 그 지점이 아니다**
    const tail = [...parent.messages].reverse().find((m) => m.role !== "system");
    if (tail && tail.id !== room.forkedAtMessageId) {
      return {
        ok: false,
        reason:
          "원본이 그 뒤로 더 대화해서 다시 분기할 수 없습니다. " +
          "세션 분기는 **지금 상태를 통째로 복제**하는 것이라, " +
          "여기서 다시 하면 이 방에 안 보이는 원본의 뒤 대화까지 알게 됩니다. " +
          "그때 지점을 원하면 «대화 넘겨서 시작»이 유일한 길입니다.",
      };
    }

    let won = 0;
    for (const bot of failed) {
      // 원본 쪽 짝을 이름으로 찾는다 — 분기할 때 이름을 그대로 물려줬다
      const origin = parent.participants.find((b) => b.name === bot.name);
      const live = origin
        ? (this.port.runtimes.get(parent.id)?.bots.get(origin.id)?.sessionId ?? origin.sessionId)
        : undefined;
      if (!origin || !live) continue;

      const got = await this.port.pool.connection(origin.agentId).forkSession(live, room.cwd, this.port.sessions.mcpFor(room, origin));
      if (!got.ok) continue;

      // 폴백으로 열었던 세션은 **빈 것**이라 지울 것도 없다 — 놓기만 한다
      const bt = this.port.runtimes.bot(room.id, bot.id);
      if (bt.sessionId) {
        await this.port.pool.get(bot.agentId)?.closeSession(bt.sessionId).catch(() => undefined);
      }
      bt.sessionId = got.sessionId;
      // 네이티브로 갈라낸 세션은 역할을 이미 알고 있다
      bt.roleInjected = true;
      bot.sessionId = got.sessionId;
      bot.sessionPrompted = true;
      delete bot.forkFallback;
      this.port.watch(room, bot, got.sessionId);
      if (got.options.length > 0) await this.port.sessions.restoreChoices(room, bot, got.sessionId, got.options);
      won++;
    }

    if (won === 0) return { ok: false, reason: "다시 해봐도 갈라지지 않았습니다." };

    const left = room.participants.filter((b) => b.forkFallback);
    /*
     * 되살아난 봇은 **계획·기억까지 돌아왔으므로** 되먹임이 필요 없다.
     * 🔴 방 값 하나를 지우면 **아직 폴백인 봇의 약속까지** 같이 지워진다.
     */
    for (const b of room.participants) {
      if (!b.forkFallback) delete b.refeedPending;
    }

    this.port.rooms.noteRoom(
      room,
      left.length === 0
        ? "다시 분기했습니다 — 계획과 파일 기억까지 물려받았습니다."
        : `${failed
            .filter((b) => !b.forkFallback)
            .map((b) => b.name)
            .join("·")}는 다시 분기했습니다. ` +
            `${left.map((b) => b.name).join("·")}는 여전히 글로만 옮깁니다.`,
      "info",
    );
    rollUpLost(room);
    await this.port.rooms.saveProps(room, {
      participants: room.participants,
      refeedPending: room.refeedPending,
    });
    this.port.emitRoom(room);
    return { ok: true };
  }

  /**
   * 갈라낸 세션에 **방을 만들어 붙인다** (v1.1).
   *
   * 분기 방은 «평범한 새 방»이다 (D2) — 특별한 모드도 지속 상태도 없다.
   * 물려받은 메시지가 끝나는 자리를 `forkedAtMessageId`로 적어두면, 화면이
   * 거기에 구분선 하나를 끼운다. 그게 전부다.
   */
  private async createRoomFromFork(
    parent: Room,
    forks: Array<{ bot: BotInstance; forked: ForkedSession }>,
    cut: number,
    title: string | undefined,
    fallback: ForkFallback,
    /** 그 봇만 가르는 경우 — 물려받는 대화도 **그 봇이 본 것**만이다 (v2.1) */
    onlyBotId?: string,
  ): Promise<Room> {
    const now = Date.now();
    const at = parent.messages[cut]!;

    /*
     * **메시지 id를 그대로 물려받는다.**
     *
     * 방마다 파일이 따로라 겹쳐도 부딪히지 않고, 대신 `forkedAtMessageId` 하나가
     * **두 방 모두에서** 유효해진다 — 분기 지점으로 점프할 때 짝을 따로 만들 필요가 없다.
     *
     * 진행 중이던 흔적은 지운다. 물려받은 건 이미 끝난 대화다.
     */
    const messages: Message[] = parent.messages
      .slice(0, cut + 1)
      /*
       * ★ **그 봇이 본 것만** (v2.1 · §5).
       *
       * 🔴 남의 줄기를 끌고 가면 새 방의 첫 화면이 **그 봇은 본 적 없는 말**로
       * 채워진다 — «화면엔 보이는데 봇은 모른다»(§4.1.1의 위험)를 **분기가
       * 새로 만들어내는** 셈이다.
       */
      .filter((m) => (onlyBotId ? inBotView(m, onlyBotId) : true))
      .map((m) => {
        const copy: Message = structuredClone(m);
        delete copy.streaming;
        return copy;
      });

    const room: Room = {
      id: `room-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: title?.trim() || this.nextForkTitle(parent.title),
      // 봇은 전부 **새 것**이다 — 세션이 다르고 설정도 여기서부터 따로 간다
      participants: forks.map(({ bot, forked }, n) => ({
        ...structuredClone(bot),
        id: `${bot.agentId}-${now.toString(36)}-${n}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId: forked.sessionId,
        /*
         * **갈라낸 세션은 «말 걸기 전»에도 디스크에 남는다** (§13.2 실측).
         *
         * `session/new`로 연 세션은 성공한 첫 프롬프트를 받아야 남지만(§13.1),
         * 분기는 **이미 내용이 있는 세션의 복제**라 곱바로 남는다.
         *
         * ⚠ 처음엔 «모르니까 보수적으로» false로 둥는데, **그게 손해였다.**
         * 이 값이 false면 `pointAt`의 보호가 풀려 일시적인 복구 실패 한 번에
         * 진짜 분기 세션 포인터를 유령이 덮어쓴다 — v1.0에서 한 번 당한 사고다.
         *
         * 폴백으로 만든 것(`session/new`)은 여전히 false다. 그건 진짜로 비어 있다.
         */
        sessionPrompted: forked.native,
        // 폴백이면 **다시 해볼 수 있게** 이유를 들고 있는다
        ...(forked.native ? {} : { forkFallback: forked.reason }),
      })),
      cwd: parent.cwd,
      messages,
      unread: 0,
      /*
       * 마지막까지 읽은 상태로 연다 — 물려받은 건 이미 읽은 대화다.
       *
       * ★ 봇 하나만 가르면 **분기 지점 메시지가 그 봇 뷰에 없을 수 있다**
       * (남에게 간 말에서 갈랐을 때). 그러면 여기가 **새 방에 없는 id** 를
       * 가리켜 «안 읽음»이 어긋난다 — 실제로 물려받은 마지막 것을 쓴다.
       */
      lastReadMessageId: messages.at(-1)?.id ?? at.id,
      forkedFromRoomId: parent.id,
      forkedAtMessageId: at.id,
      /*
       * 폴백이면 에이전트가 백지다. **사용자가 고른 대로** — 글로 옮기거나 백지로.
       *
       * 🔴 여기 있는 것은 **요약**이다. 진짜 약속은 아래에서 **폴백한 봇에게만**
       * 건다. 방에 하나로 두었더니 네이티브로 갈라져 **이미 계획·기억을
       * 물려받은 봇에게도** 지난 대화가 통째로 다시 들어갔다 — 토큰만 쓰고
       * 맥락은 두 겹이 된다.
       */
      ...(forks.every((f) => f.forked.native) || fallback === "fresh"
        ? {}
        : { refeedPending: true }),
      createdAt: now,
      lastActivityAt: now,
    };

    /*
     * ★ **심사자 지목도 새 id 로 옮긴다** (v3.0 3-P).
     *
     * 🔴 봇은 전부 **새 것**인데 `structuredClone` 은 `approver.botId` 까지
     * 그대로 베낀다 — 가리키는 곳이 **부모 방의 봇**이라 분기한 방에서는
     * 심사가 통째로 안 듣는다. 조용히 사용자에게 되돌아오므로 **화면만
     * 보고는 모른다.**
     *
     * 봇 하나만 가른 경우에는 지목한 상대가 새 방에 아예 없다 — 그때는
     * 사용자로 되돌린다.
     */
    const moved = new Map(forks.map(({ bot }, n) => [bot.id, room.participants[n]!.id]));
    for (const b of room.participants) {
      if (b.approver?.kind !== "bot") continue;
      const landed = moved.get(b.approver.botId);
      b.approver = landed ? { kind: "bot", botId: landed } : ASK_USER;
    }

    await this.port.disk.createRoom(room);
    this.port.rooms.open.set(room.id, room);

    for (const [n, { forked }] of forks.entries()) {
      const fresh = room.participants[n]!;
      // ★ **폴백한 봇에게만** 되먹임 약속 — 네이티브는 이미 다 물려받았다
      if (fallback !== "fresh" && !forked.native) fresh.refeedPending = true;
      const bt = this.port.runtimes.bot(room.id, fresh.id);
      bt.sessionId = forked.sessionId;
      // 네이티브 분기는 역할을 이미 알고 있다 — 원본이 들은 것을 그대로 물려받았다
      bt.roleInjected = forked.native;
      this.port.watch(room, fresh, forked.sessionId);
      if (forked.options.length > 0) {
        await this.port.sessions.restoreChoices(room, fresh, forked.sessionId, forked.options);
      }
    }

    /*
     * **어떻게 갈라졌는지 말해준다** (§0 원칙).
     *
     * 네이티브면 계획·메모리까지 따라왔고, 폴백이면 글만 따라온다 — 사용자가
     * 기대를 맞출 수 있어야 하는 차이다. 조용히 지나가면 «왜 얘는 아까 얘기를
     * 모르지»가 된다.
     */
    const note: Message = {
      id: messageId(),
      role: "system",
      /*
       * 🔴 **폴백은 «새 세션»이 아니라 «상태를 잃었다»가 핵심이다.**
       *
       * 예전 문구는 *"새 세션으로 시작합니다"* 였는데, 그건 **우리 사정**이지
       * 사용자에게 달라지는 것이 아니다. 실제로 달라지는 건 이쪽이다:
       * 네이티브면 에이전트가 세운 **계획과 읽은 파일 기억**까지 따라오고,
       * 폴백이면 **대화 글자만** 따라온다. 그걸 안 적으면 사용자는 상대가
       * 아까 읽은 파일을 기억한다고 믿은 채로 대화한다.
       *
       * 그래서 폴백은 **무엇을 잃었는지 먼저**, 이유는 그다음이다.
       */
      /*
       * 봇이 여럿이면 **섞일 수 있다** — Claude는 네이티브로 갈라지고
       * Gemini는 폴백으로 떨어지는 식이다. 그럴 때 **잔치를 이름으로 짚는다** —
       * «일부는 잃었습니다»만 써두면 누구에게 다시 설명해야 하는지 모른다.
       */
      text: (() => {
        const lost = forks.filter((f) => !f.forked.native);
        if (lost.length === 0) {
          return "원본 세션을 갈라 시작했습니다 — 대화뿐 아니라 계획과 파일 기억까지 물려받았습니다.";
        }
        // 봇이 하나면 이름을 안 붙인다 — 군더더기다. 조사도 그에 따라 갈린다.
        const subject =
          forks.length === 1
            ? "계획과 파일 기억은"
            : `${lost.map((f) => f.bot.name).join("·")}는 계획과 파일 기억을`;
        const why = lost[0]!.forked.reason;
        return fallback === "refeed"
          ? `⚠ ${subject} 물려받지 못했습니다 — 위 대화를 글로만 옮깁니다. ` +
            `(${why}) 다음 메시지에 함께 전달됩니다.`
          : `⚠ ${subject} 물려받지 못했습니다 — 위 기록만 남기고 백지에서 시작합니다. ` +
            `(${why}) 에이전트는 위 대화를 모릅니다.`;
      })(),
      ...(forks.every((f) => f.forked.native) ? {} : { mark: "error" as const }),
      deliveredTo: [],
      createdAt: now,
    };
    this.port.rooms.append(room, note);
    await this.port.rooms.saveNewMessage(room, note);

    this.port.rooms.emitMetas();
    return room;
  }

  /**
   * 분기 방의 기본 제목 — `원본 (2)`, 그다음은 `(3)`.
   *
   * 분기의 분기도 형제로 센다(D4). `논의 (2)`에서 또 가르면 `논의 (2) (2)`가 아니라
   * `논의 (3)`이다 — 꼬리표가 겹치면 목록에서 읽을 수 없게 된다.
   */
  private nextForkTitle(parentTitle: string): string {
    const base = parentTitle.replace(/\s*\(\d+\)\s*$/, "").trim() || parentTitle;
    const taken = new Set(this.port.rooms.listMetas().map((m) => m.title));
    for (let n = 2; ; n++) {
      const name = `${base} (${n})`;
      if (!taken.has(name)) return name;
    }
  }

  /** 이 방에서 갈라져 나간 방들 (D3·분기 목록) */
  childrenOf(roomId: string): RoomMeta[] {
    return this.port.rooms.listMetas().filter((m) => m.forkedFromRoomId === roomId);
  }
}
