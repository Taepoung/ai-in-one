/**
 * ★ **방에 붙이기** — 방을 열 때 봇들의 세션을 붙인다 (리팩토링 ⑩, 2026-10-20).
 *
 * ```
 * enterRoom    그 방의 자물쇠를 잡는다 — 다른 창이 열고 있으면 막는다
 * bindSession  세션이 없는 봇들을 한꺼번에 붙인다 (같은 방을 두 번 안 붙인다)
 * joinOne      봇 하나: CLI 띄우기 → 세션 열기 — 단계와 실패를 봇마다 알린다
 * retryJoin    「다시 시도」
 * releaseRoom  도는 턴이 없으면 자물쇠를 놓는다
 * ```
 *
 * 세션층의 손님이다 — 일은 `pool.start` 와 `sessions.ensure` 가 하고, 여기는 차례 ·
 * 화면 알림 · 창 사이 자물쇠를 맡는다. 받는 것은 `JoinPort` 가 전부다.
 */
import { describe } from "../acpConnection.js";
import type { Rooms } from "../room/rooms.js";
import type { Runtimes } from "../room/runtimes.js";
import type { RoomLocks } from "../roomLock.js";
import { isBusy, type BotInstance, type JoinFail, type JoinStep, type Room } from "../types.js";
import type { AgentPool } from "./pool.js";
import type { Sessions } from "./sessions.js";

/**
 * 오류 한 줄에서 **고치는 길**을 읽어낸다 (2026-10-13).
 *
 * ⚠️ **글자로 가른다.** ACP 는 오류에 종류를 안 싣는다 — `newSession` 이
 * auth 를 이미 우리 말로 바꿔두고(«…에 로그인이 필요합니다»), 안 받은
 * 에이전트는 `withInstalled` 가 «아직 받지 않았습니다» 로 바꿔둔다. 그
 * 두 자리가 **우리가 쓴 글**이라 여기서 알아볼 수 있다.
 *
 * 🔴 모르면 `other` 다 — 그쪽이 **[다시 시도]** 를 다는 쪽이라, 잘못 맞혀도
 * 사용자가 할 수 있는 일이 남는다. 거꾸로 `auth` 로 잘못 몰면 **로그인하라고
 * 보내놓고 아무것도 안 고쳐진다.**
 */
function whyJoin(say: string): JoinFail {
  if (say.includes("받지 않았습니다") || say.includes("알 수 없는 에이전트")) return "gone";
  if (say.includes("로그인")) return "auth";
  return "other";
}

/** 붙이기층이 받는 것 — 이게 전부다 */
export interface JoinPort {
  /** 창 사이 자물쇠 — 없으면 이 창 혼자다 */
  readonly locks: RoomLocks | undefined;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  readonly pool: AgentPool;
  readonly sessions: Sessions;
  emitRoom(room: Room): void;
  emitJoinStep(roomId: string, botId: string, step: JoinStep): void;
  emitJoinFail(roomId: string, botId: string, why: JoinFail, line: string): void;
  emitJoinDone(roomId: string): void;
}

export class Joins {
  /** 세션을 붙이는 중인 방들. 방을 빠르게 오가도 CLI를 두 번 부르지 않는다 */
  private readonly sessionFlight = new Map<string, Promise<void>>();

  constructor(private readonly port: JoinPort) {}

  /**
   * ★ **방에 들어간다 — 자리를 잡고** (v3.0 2-G).
   *
   * 🔴 **남이 쓰는 중이면 막는다.** `ensureSession` 은 「세션이 사라졌다」와
   * 「남이 쓰는 중이다」를 **안 가려서**, 둘 다 «못 붙었다»로 읽고 새 세션을
   * 열어 `bot.sessionId` 를 덮는다 — **먼저 쓰던 창의 세션이 고아가 된다.**
   *
   * ★ **빠져나갈 단추를 안 둔다.** «그래도 열기» 를 주면 그 순간 그 고아
   * 세션이 생기고, 사용자는 무엇이 잘못됐는지 모른 채 두 화면이 어긋나는
   * 것만 본다. **껐다 켜면 저절로 풀리는 것**이 출구다.
   */
  async enterRoom(roomId: string): Promise<{ ok: true; room: Room } | { ok: false; why: string }> {
    const got = this.port.locks?.take(roomId) ?? { ok: true as const };
    if (!got.ok) {
      return {
        ok: false,
        why: `이 방은 «${got.held.window}» 에서 열려 있습니다. ` +
          `같은 방을 두 곳에서 열면 세션이 어긋나므로 막습니다 — 그쪽 창을 닫고 다시 열어보세요.`,
      };
    }
    return { ok: true, room: await this.port.rooms.openRoom(roomId) };
  }

  /**
   * **자리를 놓는다** — 목록으로 나왔을 때.
   *
   * 🔴 **도는 중이면 안 놓는다.** 방을 나와도 봇은 계속 일하고(§4.3), 그
   * 세션은 여전히 이 창 것이다 — 여기서 놓으면 옆 창이 들어와 같은 세션을
   * 집는다. 조용해지면 `closeIdle` 쪽에서 놓는다.
   */
  releaseRoom(roomId: string): void {
    if (!this.port.locks?.holds(roomId)) return;
    if (isBusy(this.port.runtimes.statusOf(roomId)) === true) return;
    this.port.locks.release(roomId);
  }

  /**
   * 보고 있는 방의 세션을 붙인다 (B1).
   *
   * **«방 하나 = 세션 하나»가 계속 참이어야 한다.** 방을 만들 때는 열어 두는데
   * 창을 껐다 켜면 그 연결이 사라지고, 예전에는 **첫 전송 때까지** 안 붙었다.
   * 그 사이가 거짓말하는 구간이었다 — 목록의 모델, 시트의 권한 모드가 전부
   * «이 방의 값»이 아니라 에이전트 기본값이었고, 로그인이 풀린 것도 첫 메시지를
   * 보내고 나서야 알았다.
   *
   * **목록을 훑는 것만으로는 안 붙인다.** 보고 있는 방 하나뿐이라 세션 수는
   * 예전과 같다 — 시점만 당겼다.
   *
   * 화면을 막지 않는다. 실패는 방 오류로 알리고, 다음 전송이 다시 시도한다.
   */
  bindSession(room: Room): Promise<void> {
    // **참여자 전부**를 붙인다 — 단체방에서는 봇마다 세션이 하나씩이다(B1).
    const need = room.participants.filter(
      (b) => !this.port.runtimes.bot(room.id, b.id).sessionId,
    );
    if (need.length === 0) {
      // 붙일 것이 없으면 **그 자리에서 끝난 것**이다 — 화면을 세워두지 않는다
      this.port.emitJoinDone(room.id);
      return Promise.resolve();
    }

    const running = this.sessionFlight.get(room.id);
    if (running) return running;

    for (const b of need) this.port.runtimes.setStatus(room.id, "connecting", b.id);
    /*
     * ★ **봇마다 따로 받는다** (2026-10-13).
     *
     * 🔴 여기가 `Promise.all` 하나에 `catch` 하나였다. 봇 셋 중 하나가
     * 터지면 **누가 터졌는지가 거기서 사라지고**, 나머지가 멀쩡히 붙었는지도
     * 알 수 없었다. 화면은 «세션에 붙지 못했습니다» 한 줄만 받았다.
     *
     * 그리고 그 한 줄이 **말풍선으로** 남았다 — 대화 기록에 박혀서 다음에
     * 열어도 그대로 있다. 세션이 붙고 말고는 **우리 사정**이지 대화가 아니다.
     */
    const work = Promise.all(need.map((b) => this.joinOne(room, b)))
      .then(() => {
        // 붙고 나면 화면이 들고 있는 값이 낡았다 — 이 방의 진짜 값으로 갈아준다
        this.port.emitRoom(room);
        this.port.emitJoinDone(room.id);
      })
      .finally(() => this.sessionFlight.delete(room.id));

    this.sessionFlight.set(room.id, work);
    return work;
  }

  /**
   * 한 봇을 방에 붙인다 — **터져도 나머지를 안 끈다** (2026-10-13).
   *
   * 까닭을 갈라 알려주는 것이 여기서 하는 일의 절반이다. 화면이 달 단추가
   * 종류마다 다르기 때문이다(`JoinFail`).
   */
  private async joinOne(room: Room, bot: BotInstance): Promise<void> {
    const bt = this.port.runtimes.bot(room.id, bot.id);
    try {
      /*
       * ★ **두 칸을 따로 밟는다** (2026-10-13).
       *
       * 이미 붙어 있으면 둘 다 건너뛴다 — `ensureSession` 첫 줄이 그렇고,
       * `ensureStarted` 도 «떠 있으면 바로 돌아온다». 그래서 **두 번째 방부터는
       * ① 이 그냥 지나가고**, 화면도 그걸 그대로 보여준다.
       */
      if (!bt.sessionId) {
        this.port.emitJoinStep(room.id, bot.id, "start");
        await this.port.pool.start(room.id, bot.agentId);
        this.port.emitJoinStep(room.id, bot.id, "session");
      }
      await this.port.sessions.ensure(room, bot);
      this.port.runtimes.setStatus(room.id, "idle", bot.id);
    } catch (err) {
      const why = describe(err);
      this.port.runtimes.setStatus(room.id, "error", bot.id);
      this.port.emitJoinFail(room.id, bot.id, whyJoin(why), why);
    }
  }

  /**
   * ★ **못 붙은 봇을 다시 붙여본다** — 화면의 [다시 시도] (2026-10-13).
   *
   * 자동으로 되풀이하지 않는다. 「몇 초마다」 라는 숫자가 하나 생기는데 그
   * 숫자는 아무도 고를 수 없다 — MCP 쪽과 같은 규칙이다.
   */
  async retryJoin(roomId: string, botId: string): Promise<void> {
    const room = await this.port.rooms.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;
    this.port.runtimes.setStatus(room.id, "connecting", bot.id);
    await this.joinOne(room, bot);
    this.port.emitRoom(room);
  }
}
