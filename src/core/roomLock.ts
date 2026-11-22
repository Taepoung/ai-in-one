import * as fs from "node:fs";
import * as path from "node:path";

/**
 * **같은 방은 한 창에서만 연다** (v3.0 2-G · 4-12-1).
 *
 * 🔴 **왜 막나.** `ensureSession` 은 「세션이 사라졌다」와 「남이 쓰는 중이다」를
 * **안 가린다** — 둘 다 «못 붙었다»로 읽고 새 세션을 열어 `bot.sessionId` 를
 * 덮는다. 그러면 **먼저 쓰던 창의 세션이 고아가 된다**: 그쪽 화면은 멀쩡해
 * 보이는데 다음 말이 엉뚱한 세션으로 가고, 옛 세션은 아무도 안 닫는다.
 *
 * 실제로 Codex 가 그대로 보여준다 —
 * *"This Codex session is in use by another Codex client"*.
 * 🔴 **그 문구로 가리는 길은 안 쓴다** — 에이전트마다 말이 다르고, 판이
 * 올라가면 또 달라진다. 우리가 아는 사실(«내가 열었다»)로 가른다.
 *
 * ★ **빠져나갈 단추를 안 둔다.** «그래도 열기» 를 주면 그 순간 위의 고아
 * 세션이 생기고, 사용자는 **무엇이 잘못됐는지 모른 채** 두 화면이 어긋나는
 * 것만 본다. 껐다 켜면 풀리므로(아래) 막혀도 길이 없진 않다.
 *
 * ```
 * 파일      rooms/<id>.open   { pid, 창, 연 시각 }
 * 얻는다    그 방을 열 때
 * 빼앗는다  pid 가 죽었으면  → **껐다 켜면 저절로 풀린다**
 * 푼다      목록으로 나올 때 · 방 나가기 · 확장이 내려갈 때
 * ```
 */

export interface LockNote {
  /** 들고 있는 프로세스. **죽었으면 빼앗는다** */
  pid: number;
  /** 사람이 읽을 창 이름 — «어디서 열려 있나»를 말해주려고 */
  window: string;
  at: number;
  /**
   * ★ **어느 창인지 — 다시 불러와도 같은 값** (사용자, 2026-11-22: *"아마 reload하면서
   * 생기는 문제일 수도"*). 열린 폴더(워크스페이스)의 주소다. VS Code 는 한 폴더를 두
   * 창에 안 연다 — 같으면 **내 창의 앞 판**이다. 폴더 없는 창은 없다(가릴 수 없다).
   */
  key?: string;
}

export type LockResult =
  | { ok: true }
  /** 남이 쓰는 중 — `note` 로 «어디서» 를 말해준다 */
  | { ok: false; held: LockNote };

export class RoomLocks {
  /** 이 창이 들고 있는 것들 — 내릴 때 다 푼다 */
  private readonly mine = new Set<string>();

  constructor(
    private readonly roomsDir: string,
    /** 이 창의 이름. 사람에게 보여줄 글이다 */
    private readonly window: string,
    private readonly log: (m: string) => void,
    /** 다시 불러와도 같은 이 창의 열쇠(`LockNote.key`) — 없으면 앞 판을 못 알아본다 */
    private readonly key?: string,
  ) {}

  /**
   * ★ **막은 것이 내 창의 앞 판인가** — 창을 다시 불러오면 옛 확장 호스트가 내려가는 몇
   * 초 동안 **산 채로** 자리를 들고 있다. 그 사이에 방을 누르면 «다른 창» 으로 막혔다.
   */
  myEarlierSelf(held: LockNote): boolean {
    return this.key !== undefined && held.key === this.key && held.pid !== process.pid;
  }

  private pathOf(roomId: string): string {
    return path.join(this.roomsDir, `${roomId}.open`);
  }

  /**
   * **잡는다.** 이미 내 것이면 그대로 성공이다.
   *
   * ⚠️ **동기로 쓴다.** 방을 여는 길 한가운데라 `await` 를 끼우면 그 사이에
   * 다른 창이 들어올 수 있다 — «읽고 나서 쓴다» 사이가 벌어지는 만큼 둘이
   * 같이 잡는다. 파일 하나 쓰는 일이라 동기가 더 싸기도 하다.
   */
  take(roomId: string, overEarlierSelf = false): LockResult {
    if (this.mine.has(roomId)) return { ok: true };

    const held = this.read(roomId);
    if (held && held.pid !== process.pid && alive(held.pid)) {
      if (!(overEarlierSelf && this.myEarlierSelf(held))) return { ok: false, held };
      this.log(`[${roomId}] 이 창의 앞 판(pid ${held.pid})이 아직 안 내려갔지만 자리를 넘겨받습니다`);
    }
    if (held && held.pid !== process.pid) {
      // 죽은 창이 들고 있던 것 — 빼앗는다. **껐다 켜면 저절로 풀리는 길**이다
      this.log(`[${roomId}] 죽은 창(pid ${held.pid})의 자리를 넘겨받습니다`);
    }

    const note: LockNote = {
      pid: process.pid, window: this.window, at: Date.now(),
      ...(this.key !== undefined ? { key: this.key } : {}),
    };
    try {
      /*
       * 🔴 **원자적으로 쓰지 않아도 된다.** 둘이 동시에 쓰면 뒤엣것이 이기는데,
       * 그 둘은 이미 «앞의 것이 죽었다»를 본 뒤다 — 누가 이기든 산 창 하나다.
       * 막아야 하는 것은 **산 창 둘**이고 그건 위의 `alive` 가 거른다.
       */
      fs.writeFileSync(this.pathOf(roomId), JSON.stringify(note), "utf8");
    } catch (err) {
      /*
       * ★ **못 써도 막지 않는다.** 디스크가 읽기 전용이거나 권한이 없을 수
       * 있는데, 그때 방이 안 열리면 **락이 없을 때보다 나빠진다.** 락은
       * 사고를 줄이는 것이지 쓰기 위한 조건이 아니다.
       */
      this.log(`[${roomId}] 자리를 적지 못했습니다 — ${describe(err)}`);
    }
    this.mine.add(roomId);
    return { ok: true };
  }

  /** **놓는다.** 내 것이 아니면 안 건드린다 */
  release(roomId: string): void {
    if (!this.mine.delete(roomId)) return;
    const held = this.read(roomId);
    // 내가 적은 것일 때만 지운다 — 빼앗긴 뒤라면 남의 것이다
    if (held && held.pid !== process.pid) return;
    try { fs.rmSync(this.pathOf(roomId), { force: true }); } catch { /* 이미 없다 */ }
  }

  /** 확장이 내려갈 때 — 들고 있던 것을 다 놓는다 */
  releaseAll(): void {
    for (const id of [...this.mine]) this.release(id);
  }

  /** 지금 내가 들고 있나 */
  holds(roomId: string): boolean {
    return this.mine.has(roomId);
  }

  /**
   * ★ **남이 «산 채로» 들고 있나** (2026-10-14).
   *
   * 「기록만 읽기」가 쓴다. 그 길은 자물쇠를 **안 잡고** 여는데(붙이지 않으니
   * 잡을 이유가 없다), 그러면 **옆 창이 지금 쓰는 중인 방**도 읽게 된다 —
   * 디스크에 `streaming: true` 로 남아 있는 것을 보고 「끊겼다」 고 읽는다.
   *
   * 죽은 창이 들고 있는 것은 **없는 것으로 친다** — 그건 진짜로 끊긴 것이다.
   */
  heldByOther(roomId: string): LockNote | undefined {
    const held = this.read(roomId);
    if (!held || held.pid === process.pid) return undefined;
    return alive(held.pid) ? held : undefined;
  }

  private read(roomId: string): LockNote | undefined {
    try {
      const raw = fs.readFileSync(this.pathOf(roomId), "utf8");
      const note = JSON.parse(raw) as LockNote;
      return typeof note?.pid === "number" ? note : undefined;
    } catch {
      // 없거나 깨졌다 — 둘 다 «아무도 안 들고 있다» 로 읽는다
      return undefined;
    }
  }
}

/**
 * 그 프로세스가 살아 있나.
 *
 * `kill(pid, 0)` 은 **신호를 안 보내고 존재만 묻는다.** 남의 프로세스라
 * 권한이 없으면 `EPERM` 이 나는데, 그것도 **살아 있다는 뜻**이다.
 */
/**
 * ★ **그 프로세스가 살아 있나** — 죽었으면 자리를 빼앗는다.
 *
 * 받는 자리(`agentInstaller.holdInstall`)도 같은 판단을 쓴다. 「죽은 창이
 * 들고 있던 것은 빼앗는다」가 **같은 규칙**이어야 하기 때문이다 — 한쪽만
 * 안 빼앗으면 껐다 켜도 안 풀리는 자리가 생긴다.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
