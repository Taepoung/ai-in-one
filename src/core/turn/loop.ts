/**
 * ★ **루프모드** — 사용자가 자리를 비운 동안 봇이 할 일을 이어 가게 한다
 * (사용자, 2026-10-20).
 *
 * 예전 «질문: 알아서 판단»(`answerPolicy: "auto"`)의 자리다. 그때는 매 턴 «묻지 말고
 * 스스로 판단하라» 를 붙이기만 했다. 이제는:
 *
 * ```
 * 방이 조용해진다      도는 봇 · 턴 꼬리 · 큐에 걸린 say · 예약 — 아무것도 없다
 * 2초 기다린다         턴 꼬리(TURN_TAIL_MS 1.5초)를 넘기려고. 그 사이 무언가 생기면 안 보낸다
 * 다시 묻는다          «종료» 를 안 한 루프 봇에게만:
 *                     «사용자가 자리를 비웠습니다. 이어서 할 작업이 있으면 계속하고,
 *                      없으면 «종료» 한 단어로만 답하세요.»
 * 답을 본다            «종료» 면 빠지고, 아니면 다음에 또 묻는다
 * 상한                 한 봇에게 방의 `loopCap` 번까지 (사용자가 정한다 · 0 이면 제한 없음)
 * ```
 *
 * 사용자가 새로 말을 걸면 센 것과 «종료» 를 비운다 — 새 일이 생긴 것이다. 다시 물은
 * 일은 방에 한 줄로 남긴다 — **사용자가 한 말인 척 안 한다**(묻는 말은 깨우기 턴으로
 * 가서 대화에 말풍선으로 안 남는다; 봇의 답은 남는다).
 *
 * 받는 것은 `LoopPort` 가 전부다.
 */
import { describe } from "../acpConnection.js";
import { messageId } from "../ids.js";
import type { BotQueue } from "../mcp/botQueue.js";
import type { Rooms } from "../room/rooms.js";
import type { Runtimes } from "../room/runtimes.js";
import { DEFAULT_LOOP_CAP, isBusy, type BotInstance, type Message, type Room } from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";
import type { Turns } from "./turns.js";

/**
 * 조용해진 뒤 다시 묻기까지 — **턴 꼬리(1.5초)를 넘기는 만큼만**.
 *
 * 대기 중인 것이 정말 없으면 길게 기다릴 까닭이 없다(사용자, 2026-10-20). 다만 턴이
 * 끝나도 늦게 오는 조각을 받으려고 그 턴을 1.5초 붙든다 — 그 사이에 새 턴을 열면 앞
 * 턴의 늦은 조각이 루프 턴에 섞인다. 보내기 직전에 한 번 더 본다.
 */
export const LOOP_SETTLE_MS = 2000;

/** 다시 물을 때 보내는 말 — 우리가 하는 말이라는 꼬리표를 단다 */
export const LOOP_ASK =
  "[ai-in-one 루프] 사용자가 자리를 비웠습니다. 지금까지 맡은 일 중 아직 안 끝난 것이 " +
  "있으면 이어서 하고, 다 끝났으면 «종료» 한 단어로만 답하세요.";

/** «종료» 한 단어인가 — 꾸밈(굵게 · 따옴표 · 마침표 · 빈칸)은 걷고 본다 */
export function saidDone(text: string): boolean {
  return text.replace(/[\s*_`"'«»“”‘’.!。,~\-]/g, "") === "종료";
}

/** 루프층이 받는 것 — 이게 전부다 */
export interface LoopPort {
  readonly host: WorkspaceHost;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  readonly queue: BotQueue;
  readonly turns: Turns;
  /** 내리는 중인가 — 그러면 안 묻는다 */
  isDown(): boolean;
}

export class Loops {
  /** 방마다 기다리는 중인 시계 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 방마다 — 어느 사용자 말부터 센 것인가 · 끝났다고 이미 적었나 */
  private readonly armed = new Map<string, { since?: string; ended?: boolean }>();

  constructor(private readonly port: LoopPort) {}

  /**
   * ★ **방이 조용해졌을 수 있다** — 턴이 끝날 때마다 부른다(`turnDone`). 루프 봇이
   * 없으면 시계를 걷고, 있으면 2초 뒤에 다시 본다(그 사이 또 불리면 처음부터).
   */
  check(room: Room): void {
    const old = this.timers.get(room.id);
    if (old) clearTimeout(old);
    this.timers.delete(room.id);
    if (!room.participants.some(isLoop)) return;
    this.timers.set(room.id, setTimeout(() => {
      this.timers.delete(room.id);
      this.fire(room);
    }, LOOP_SETTLE_MS));
  }

  /** 다 내린다 */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * 도는 봇 · 턴 꼬리 · 큐에 걸린 say · 예약 — **아무것도 없나**.
   *
   * 🔴 보내기 **직전에** 본다. 2초 사이에 사용자가 말을 걸었거나 봇이 다른 봇을
   * 불렀으면 이번엔 건너뛴다 — 그 턴이 끝날 때 다시 불린다.
   */
  private quiet(room: Room): boolean {
    if (this.port.isDown() || room.staged) return false;
    return room.participants.every((b) =>
      isBusy(this.port.runtimes.statusOf(room.id, b.id)) !== true
      && !this.port.runtimes.get(room.id)?.bots.get(b.id)?.turn
      && this.port.queue.waiting(b.id) === 0);
  }

  private fire(room: Room): void {
    const loops = room.participants.filter(isLoop);
    if (loops.length === 0 || !this.quiet(room)) return;

    // 사용자가 새로 말을 걸었으면 처음부터 센다 — 새 일이 생긴 것이다
    const since = [...room.messages].reverse().find((m) => m.role === "user")?.id;
    const arm = this.armed.get(room.id) ?? {};
    if (arm.since !== since) {
      for (const b of room.participants) {
        const bt = this.port.runtimes.bot(room.id, b.id);
        delete bt.loopRounds;
        delete bt.loopDone;
        delete bt.loopAskedAt;
      }
      this.armed.set(room.id, { ...(since ? { since } : {}) });
    }
    const state = this.armed.get(room.id)!;

    // 지난번에 물은 것의 답을 본다 — 그 뒤에 그 봇이 한 마지막 말
    for (const b of loops) {
      const bt = this.port.runtimes.bot(room.id, b.id);
      if (bt.loopAskedAt === undefined) continue;
      const answer = lastSaid(room, b, bt.loopAskedAt);
      if (answer && saidDone(answer.text)) bt.loopDone = true;
      delete bt.loopAskedAt;
    }

    const cap = room.loopCap ?? DEFAULT_LOOP_CAP;
    const capped: BotInstance[] = [];
    for (const b of loops) {
      const bt = this.port.runtimes.bot(room.id, b.id);
      // 0 이면 제한 없음 — 깊이 상한과 같은 규칙
      if (cap > 0 && !bt.loopDone && (bt.loopRounds ?? 0) >= cap) {
        bt.loopDone = true;
        capped.push(b);
      }
    }
    const ask = loops.filter((b) => !this.port.runtimes.bot(room.id, b.id).loopDone);

    if (ask.length === 0) {
      if (state.ended) return;
      state.ended = true;
      this.port.rooms.noteRoom(
        room,
        capped.length > 0
          ? `루프 — ${names(capped)}에게 ${cap}번 다시 물어 멈췄습니다.`
          : "루프 — 모두 «종료» 라고 해 멈췄습니다.",
        "info",
      );
      return;
    }
    state.ended = false;

    this.port.rooms.noteRoom(room, `루프 — ${names(ask)}에게 다시 물었습니다.`, "info", ask.map((b) => b.id));
    for (const b of ask) {
      const bt = this.port.runtimes.bot(room.id, b.id);
      bt.loopRounds = (bt.loopRounds ?? 0) + 1;
      bt.loopAskedAt = Date.now();
      /*
       * **깨우기 턴으로 묻는다** — 이 말은 대화에 사용자의 말풍선으로 안 남는다
       * (`runQueue` 의 `wake`). 남는 것은 위의 한 줄과 봇의 답이다.
       */
      const poke: Message = {
        id: messageId(), role: "system", text: LOOP_ASK, deliveredTo: [b.id], createdAt: Date.now(),
      };
      // 끝나면 `runQueue` 가 «턴이 끝났다» 를 알린다 → 다시 센다
      void this.port.turns.runQueue(room, [poke], b.id, true)
        .catch((err) => this.port.host.log(`[${room.id}] 루프로 다시 묻기 실패: ${describe(err)}`));
    }
  }
}

function isLoop(b: BotInstance): boolean {
  return b.answerPolicy === "auto";
}

function names(bots: readonly BotInstance[]): string {
  return bots.map((b) => b.name).join(" · ");
}

/** 그 봇이 `since` 뒤에 한 마지막 말 */
function lastSaid(room: Room, bot: BotInstance, since: number): Message | undefined {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i]!;
    if (m.createdAt < since) break;
    if (m.role === "agent" && m.authorBotId === bot.id) return m;
  }
  return undefined;
}
