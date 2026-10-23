/**
 * ★ **연결 풀** — 에이전트마다 CLI 프로세스 하나 (리팩토링 ⑧ L1, 2026-10-20).
 *
 * 에이전트당 프로세스 하나, 방마다 세션 하나(A4·B1) — 여기는 앞의 것이다. CLI 가
 * 뜨는 **유일한 자리**가 `connection` 이다.
 *
 * 받는 것은 `PoolPort` 가 전부다. 연결은 에이전트 단위라 방도 봇도 모른다 —
 * 방 쪽 일(죽었을 때 · 결정 기록 · 누구에게 물을지)은 **갈고리**로 받아 연결에 꽂는다.
 */
import { AcpConnection } from "../acpConnection.js";
import type { RoomStore } from "../store.js";
import { withTimeout } from "../time.js";
import type { AgentDef } from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";

type Hooks = ConstructorParameters<typeof AcpConnection>;

/** 연결 풀이 받는 것 — 이게 전부다 */
export interface PoolPort {
  readonly host: WorkspaceHost;
  /** 앱 상태(치우다 만 세션 목록)를 적는 곳 */
  readonly disk: RoomStore;
  /** 그 에이전트의 정의 — 모르면 던진다 */
  agent(agentId: string): AgentDef;
  /** 내리는 중인가 — 그러면 새로 안 띄운다 */
  isDown(): boolean;
  /** 프로세스가 죽었다 */
  onCrash(agentId: string, reason: string): void;
  recordDecision: NonNullable<Hooks[3]>;
  askApprover: NonNullable<Hooks[4]>;
  emitNotice(roomId: string, text: string): void;
}

/**
 * ★ **붙는 데 걸 한도 — 둘로 가른다** (2026-10-13).
 *
 * 🔴 **여태 하나도 없었다.** `ensureStarted` 도 `newSession` 도 끝을 안 둬서,
 * 저쪽이 답을 안 하면 **영영 기다린다** — 붙는 화면에 「여는 중…」이 선 채로
 * 멈추고, 실패 신호가 안 오니 [다시 시도] 도 안 생긴다. 오늘 다섯 자리에서
 * 고친 것과 같은 종류다: *끝이 안 난다.*
 *
 * 둘을 따로 재는 까닭은 **단위가 다르기 때문**이다 — CLI 는 **에이전트마다
 * 하나**고 같은 에이전트의 봇들이 그 하나를 같이 쓴다. 세션은 봇마다다.
 *
 * ```
 * 실측            띄우기            세션
 * Claude            375ms           962ms
 * Codex             585ms         1,662ms
 * Antigravity    12,505ms         5,056ms   ← 398MB 네이티브 서버
 * ```
 *
 * 제일 느린 것에 서너 배 여유를 뒀다. 넘겼다는 것은 그 자체로 «뭔가
 * 잘못됐다» 는 신호고, 그때는 **다시 해볼 길**을 주는 것이 할 일이다.
 */
export const START_MS = 60_000;

export class AgentPool {
  private readonly conns = new Map<string, AcpConnection>();

  constructor(private readonly port: PoolPort) {}

  /** 떠 있으면 본다 — **안 띄운다** */
  get(agentId: string): AcpConnection | undefined {
    return this.conns.get(agentId);
  }

  values(): IterableIterator<AcpConnection> {
    return this.conns.values();
  }

  /**
   * 목록이 바뀌었다 — 떠 있는 것은 **새 정의만 쥔다** (`retarget` 이 대화 중 갈아끼우기는
   * 거절한다).
   */
  retarget(list: readonly AgentDef[]): void {
    for (const [id, conn] of this.conns) {
      const next = list.find((a) => a.id === id);
      if (next) conn.retarget(next);
    }
  }

  /**
   * ★ **CLI 가 떠 있나 — 띄워야 하면 띄운다** (2026-10-13).
   *
   * `newSession` 안에서 같이 일어나던 것을 **앞으로 뺀다.** 둘을 가르는
   * 까닭은 둘이고, 둘 다 사용자가 보는 것에 관한 것이다:
   *
   * ```
   * 단위가 다르다   CLI 는 **에이전트마다** 하나 — 같은 에이전트의 봇들이 공유한다
   * 걸리는 데가 다르다  Antigravity 는 띄우는 데 12.5초, 세션은 5초다
   * ```
   *
   * 합쳐두면 화면이 「여는 중…」 한 줄밖에 못 말한다. 갈라두면 **어디서
   * 걸렸는지** 보이고, 다시 해볼 때도 **필요한 쪽만** 다시 한다.
   *
   * ⚠️ **겹쳐 불러도 공짜다.** `ensureStarted` 가 이미 «떠 있으면 바로
   * 돌아오고, 뜨는 중이면 그 약속을 같이 기다린다» 로 되어 있다 — 봇 셋이
   * 다 Antigravity 라도 **CLI 는 하나만 뜬다.**
   */
  async start(roomId: string, agentId: string): Promise<void> {
    const label = this.port.agent(agentId).label;
    await withTimeout(
      this.connection(agentId).ensureStarted(() =>
        // `npx`로 CLI를 처음 받으면 수십 초가 걸린다. 멈춘 줄 알지 않게 알린다.
        this.port.emitNotice(roomId, `${label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`),
      ),
      START_MS,
      `${label}이(가) ${Math.round(START_MS / 1000)}초 안에 뜨지 않았습니다.`,
    );
  }

  /**
   * **치우다 만 세션 파일을 적어둔다** (2026-10-12).
   *
   * 🔴 저쪽 프로세스가 아직 들고 있어 안 지워진다. 다음에 켤 때 **버려진
   * 프로세스를 죽인 뒤에** 치운다(`sweepBacklog`).
   *
   * ⚠️ **«그 집에 남는 것» 을 쓸지 않는다** — 같은 집을 보는 다른 ACP
   * 클라이언트가 있을 수 있고, 그러면 남이 만든 세션까지 지운다.
   * 우리가 지우려다 못 지운 것만 적는다.
   */
  private rememberPurge(agentId: string, sessionId: string): void {
    const prev = this.port.disk.getAppState().purgeBacklog ?? [];
    if (prev.some((x) => x.agentId === agentId && x.sessionId === sessionId)) return;
    void this.port.disk.patchAppState({
      purgeBacklog: [...prev, { agentId, sessionId, at: Date.now() }],
    });
  }

  connection(agentId: string): AcpConnection {
    /*
     * 🔴 **내린 뒤에는 새로 안 만든다** (v3.0 1-E).
     *
     * 여기가 CLI 가 뜨는 **유일한 자리**다. `dispose()` 가 연결을 다 내린
     * 뒤에도 **도중이던 호출**이 이 자리에 닿을 수 있는데, 그때 하나를
     * 새로 만들면 끄려던 참에 CLI 가 하나 더 뜬다.
     */
    if (this.port.isDown()) throw new Error("이미 내려가는 중입니다");
    let conn = this.conns.get(agentId);
    /*
     * ★ **스스로 내려간 연결은 버리고 새로 만든다** (사용자, 2026-10-23: *"Antigravity
     * 로그인 시 … 로그인에 실패했습니다 — Antigravity 연결이 이미 내려갔습니다"*).
     *
     * 🔴 첫 띄우기가 실패하면(시작 인사에서 오류) 연결이 **스스로** 내려간다. 그런데 여기서
     * 그 죽은 연결을 계속 내줘서, 창을 다시 띄울 때까지 로그인을 포함한 **모든 호출**이
     * «이미 내려갔습니다» 로 끝났다. 처음 까는 환경에서 잘 걸린다 — Antigravity 는 첫
     * 띄우기가 12초가 넘고, 로그인 전이면 시작부터 실패하기 쉽다.
     *
     * 우리가 내린 것(`drop` · `disposeAll`)은 이미 지도에서 빠지므로 여기 안 걸린다.
     */
    if (conn?.isClosed) {
      this.conns.delete(agentId);
      conn = undefined;
    }
    if (!conn) {
      conn = new AcpConnection(
        this.port.agent(agentId),
        this.port.host,
        (reason) => this.port.onCrash(agentId, reason),
        (sessionId, note) => this.port.recordDecision(sessionId, note),
        (sessionId, req) => this.port.askApprover(sessionId, req),
        (agentId, sessionId) => this.rememberPurge(agentId, sessionId),
      );
      this.conns.set(agentId, conn);
    }
    return conn;
  }

  /**
   * ★ **그 에이전트의 CLI 를 내린다** (2026-10-02).
   *
   * 로그아웃했는데 프로세스가 그대로 떠 있으면 **옆 계정으로 계속
   * 돌아간다** — 계정을 바�려는 사람 입장엔 «바�는데 옇 것으로
   * 답한다» 가 된다.
   *
   * ⚠️ **세션 id 는 안 건드린다.** 사용자: *"세션은 유지되어야한다"*.
   * 다음에 방을 열 때 먼저 이어받아 보고, 새 계정으로 되면 그대로
   * 이어진다. 안 되면 **이미 있는 끕김 흐름**이 받아준다(대화 넘겨서 /
   * 요약만 / 기록만 두고). 여기서 지워버리면 고를 거리를 없애는 셌이다.
   */
  drop(agentId: string): boolean {
    const conn = this.conns.get(agentId);
    if (!conn) return false;
    conn.dispose();
    this.conns.delete(agentId);
    return true;
  }

  /** 쓰이지 않는 CLI 프로세스를 정리한다 (B6) */
  disposeUnused(inUse: ReadonlySet<string>): void {
    for (const [agentId, conn] of this.conns) {
      if (inUse.has(agentId)) continue;
      conn.dispose();
      this.conns.delete(agentId);
    }
  }

  /** 다 내린다 (`RoomManager.dispose`) */
  disposeAll(): void {
    for (const conn of this.conns.values()) conn.dispose();
    this.conns.clear();
  }
}
