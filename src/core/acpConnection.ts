import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import type {
  AgentDef,
  PermissionDecision,
  PermissionRequest,
} from "./types.js";
import type { WorkspaceHost } from "./workspaceHost.js";

/**
 * 에이전트가 턴 중에 흘려보내는 것들.
 *
 * 턴의 종료는 여기 없다 — `prompt()`의 반환값이 알려준다.
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thought"; delta: string }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      kind?: string;
      status: string;
      paths: string[];
      /** 실제로 돌린 명령 (있으면). `Bash` 같은 제목만으로는 못 판단한다 */
      command?: string;
      /**
       * 그 도구가 **뱉은 것** (`content[]`의 `type: "content"`).
       *
       * 명령만 보이고 결과가 안 보이면 반쪽이다 — 테스트가 통과했는지
       * 실패했는지는 여기 있다.
       */
      output?: string;
    }
  /** 파일 변경 전/후 전문 (E2~E4). `tool_call.content[]`의 `type: "diff"` */
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  /** 컨텍스트 점유·비용 (B14). `usage_update` */
  | { type: "usage"; used: number; size: number; cost?: { amount: number; currency: string } }
  /** 실행 가능한 슬래시 명령. C9의 압축을 여기서 찾는다 */
  | { type: "commands"; names: string[] }
  /** 에이전트가 모드를 바꿨다 (`current_mode_update`) */
  | { type: "mode"; modeId: string }
  /** 설정이 갱신됐다 (`config_option_update`) — 우리가 안 시킨 변경도 온다 */
  | { type: "config"; options: acp.SessionConfigOption[] }
  /**
   * 계획 (`plan` · `plan_update`).
   *
   * 🔴 계획 모드의 **알맹이**인데 여태 통째로 버리고 있었다 — 에이전트가
   * 계획을 세워 보내도 화면에 아무것도 안 나왔다.
   */
  | {
      type: "plan";
      planId: string;
      entries?: Array<{ text: string; status: string }>;
      markdown?: string;
    }
  | { type: "planRemoved"; planId: string }
  /** 우리가 아직 안 만든 종류. **버리지 않고 알린다** */
  | { type: "unknown"; kind: string }
  /**
   * 에이전트가 컨텍스트를 압축했다 (C11). `compaction_update`.
   *
   * **우리가 시킨 것만 오는 게 아니다** — 컨텍스트가 차면 에이전트가 스스로
   * 한다. 그 시점부터 **에이전트가 아는 것과 우리 기록이 갈린다.**
   */
  | {
      type: "compaction";
      id: string;
      status: string;
      /**
       * 에이전트가 남긴 요약 (있으면).
       *
       * 🔴 **이걸 버리면 «요약»이라는 선택지 자체가 사라진다.** 우리는 모델이
       * 없어서 대화를 요약할 수 없고, 요약을 시키려면 에이전트 턴을 써야 한다 —
       * 그런데 세션이 죽은 뒤에는 시킬 상대가 없다. **살아 있을 때 받아 두는 게
       * 유일한 길이고, 에이전트가 이미 공짜로 준다.**
       */
      summary?: string;
      /**
       * 요약이 스트리밍으로 올 때의 조각 (`compaction_summary_chunk`).
       *
       * 🔴 **이걸 안 받으면 요약을 통째로 놓친다.** 조각으로 보내는 에이전트는
       * 마지막 `compaction_update`에서 `summary`를 **생략**하는데(패치 의미론:
       * 생략 = 그대로 둠), 그러면 우리가 읽을 자리가 비어 있다.
       */
      summaryDelta?: string;
    };

/**
 * 복구 결과. **실패하면 이유를 함께 준다** (§0 원칙).
 *
 * 🔴 예전에는 `null`만 돌려주고 이유는 출력 채널에만 적었다. 그래서 방에는
 * *"이어받지 못했습니다"* 라고만 뜨고 **왜인지는 로그를 열어야** 알 수 있었다 —
 * 대부분은 안 연다.
 */
export type ResumeResult =
  | { ok: true; options: acp.SessionConfigOption[] }
  | { ok: false; reason: string };

/**
 * 분기 결과 (v1.1). 실패해도 **끝이 아니다** — 폴백이 있으므로
 * 부르는 쪽이 이유를 보고 결정한다.
 */
export type ForkResult =
  | { ok: true; sessionId: string; options: acp.SessionConfigOption[] }
  | { ok: false; reason: string };

export interface NewSessionResult {
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
}

/** 이보다 오래 걸리면 "처음이라 오래 걸린다"고 알려준다 */
const SLOW_START_MS = 4000;

/**
 * CLI 프로세스 하나 = ACP 연결 하나.
 *
 * 한 에이전트의 모든 방이 이 연결을 공유하고, 방마다 별도의 ACP 세션을 갖는다(A4·B1).
 * 프로세스를 방마다 띄우면 메모리와 기동 시간이 낭비된다.
 *
 * **SDK의 `ActiveSession` 래퍼를 쓰지 않는다.** 그건 `session/new`로 만든 세션에만
 * 붙일 수 있어서(내부 `attachSession`이 private) **복구한 세션(F7)을 다룰 수 없다.**
 * 대신 `session/update`를 sessionId로 직접 라우팅한다 — 새 세션과 복구 세션을
 * 똑같이 다루게 된다.
 */
/**
 * **승인 하나가 어떻게 끝났나** (D3).
 *
 * `toolCallId` 가 있으면 그 활동에 접어 넣고(`ToolActivity.decision`),
 * 없으면 대화에 한 줄로 남긴다 — **어느 쪽이든 버리지는 않는다.**
 */
export interface DecisionNote {
  toolCallId?: string;
  title: string;
  /** `✓` 허용 · `✕` 거절 · `·` 모르는 종류 */
  mark: string;
  label: string;
  /** 사람이 아니라 봇이 정했으면 그 이름 (§4.2.2) */
  by?: string;
}

export class AcpConnection {
  private proc?: ChildProcessWithoutNullStreams;
  private conn?: acp.ClientConnection;
  private starting?: Promise<void>;
  private stderr = "";
  /** initialize 응답. 에이전트가 무엇을 지원하는지 판단하는 근거 */
  private init?: acp.InitializeResponse;
  /**
   * 지금 `session/load`로 **기록을 다시 받고 있는** 세션들.
   *
   * 그 동안 오는 `session/update`는 새 소식이 아니라 **재생**이다.
   */
  private readonly replaying = new Set<string>();
  /** sessionId → 그 방의 이벤트 소비자 */
  private readonly listeners = new Map<string, (ev: AgentEvent) => void>();
  /** 받을 사람이 붙기 전에 온 이벤트들 (A11) */
  private readonly pending = new Map<string, AgentEvent[]>();

  /**
   * 🔴 **`readonly` 이었다 — 받아도 못 알아보는 지름이였다** (2026-10-07).
   *
   * 연결은 에이전트당 하나를 만들어 쌓아둔다. 그런데 정의를 **처음
   * 만들 때 값으로 쥐고 안 놓았다.** 방을 먼저 열어 «아직 받지
   * 않았습니다» 를 본 뒤에 받으면, 목록은 갈아끼워도(`setAgents`)
   * **이 객체는 그때 그 말을 그대로 들고 있어** 영영 같은 소리를 한다.
   * 사용자가 봉착한 것도 바로 그것이다.
   */
  constructor(
    public agent: AgentDef,
    private readonly host: WorkspaceHost,
    /** 질문 정책도 방 단위다 (D5). 권한과 같은 이유로 sessionId를 넘겨 되묻는다 */
    /**
     * 프로세스가 죽었을 때 (A5).
     *
     * **그냥 죽게 두면 다음 전송이 죽은 세션 id로 나간다.** 방마다
     * 보관 중인 sessionId를 무효화해야 다음 턴에 재접속한다.
     */
    private readonly onCrash?: (reason: string) => void,
    /** 권한·질문의 결과를 방 기록으로 남긴다 (D3) */
    private readonly onDecision?: (sessionId: string, note: DecisionNote) => void,
    /**
     * 자동 승인이 아니면 **누구에게 물을지**를 정해 답을 받아온다 (D2).
     *
     * 연결은 에이전트 단위라 방도 봇도 모른다. **대상(`Approver`)을 아는 건
     * 방을 쥐고 있는 쪽**이므로 그쪽에 맡긴다 — 사용자일 수도, v2.0에서는
     * 같은 방의 다른 봇일 수도 있다.
     */
    private readonly askApprover?: (
      sessionId: string,
      req: PermissionRequest,
    ) => Promise<PermissionDecision>,
  ) {}

  /**
   * 쓸 준비가 됐는가.
   *
   * 🔴 **`initialize` 응답까지 와야 «떠 있다»고 할 수 있다.** `this.conn`은
   * `initialize`를 보내기 **전에** 채워지는데, 그 사이에 다른 호출이
   * `ensureStarted()`에서 «이미 떠 있네» 하고 빠져나가면 **`init`이 빈 채로
   * capability를 읽는다.** 그러면 `session/resume`을 지원하는 에이전트인데도
   * *"복구를 지원하지 않습니다"* 가 되어 **멀쩡한 세션을 버리고 새로 연다.**
   *
   * 앱을 켜자마자 설정 미리 받기(`warmConfigs`)와 방 열기(`bindSession`)가
   * 동시에 도는 구조라 이 창이 실제로 열린다.
   */
  get isRunning(): boolean {
    return this.conn !== undefined && this.init !== undefined && !this.conn.signal.aborted;
  }

  // ── 수명 ──────────────────────────────────────────────────────────────

  /**
   * 여러 방이 동시에 첫 메시지를 보내도 프로세스는 하나만 뜨도록 합류시킨다.
   *
   * `onSlowStart`는 기동이 오래 끌 때 한 번 불린다 — `npx`로 CLI를 처음 받으면
   * **수십 초**가 걸릴 수 있는데, 그동안 `연결 중…`만 떠 있으면 멈춘 줄 안다.
   */
  /**
   * ★ **안 떠 있으면 새 정의로 갈아끼운다.** 바꿨으면 `true`.
   *
   * ⚠️ **떠 있으면 손대지 않는다.** 대화 중에 CLI 를 갈아끼우면
   * 세션이 끊긴다 — 그건 받고 지우는 쪽이 `dropConnection` 으로
   * 명시적으로 할 일이지, 목록이 바뀜다고 조용히 할 일은 아니다.
   */
  retarget(next: AgentDef): boolean {
    if (this.proc || this.starting) return false;
    this.agent = next;
    return true;
  }

  async ensureStarted(onSlowStart?: () => void): Promise<void> {
    if (this.isRunning) return;
    /*
     * ★ **안 받은 에이전트는 여기서 막는다** (2026-10-01).
     *
     * 화면이 이미 막고 있지만 **입구가 거기뿐이 아니다** — 설정 교체,
     * 이어받기, 백그라운드 조회가 다 이 길로 온다. 막을 거면 **띄우는 자리
     * 하나에서** 막아야 새는 데가 없다.
     */
    if (this.agent.unavailable) throw new Error(this.agent.unavailable);
    if (!this.starting) {
      const slow = onSlowStart
        ? setTimeout(onSlowStart, SLOW_START_MS)
        : undefined;
      this.starting = this.start().finally(() => {
        clearTimeout(slow);
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    /*
     * ★ **셸을 거칠 때는 공백 든 경로를 따옴표로 묶는다** (2026-09-28).
     *
     * 🔴 `shell: true` 는 인자를 **그냥 이어 붙여** 명령줄로 만든다. 그래서
     * 공백이 든 경로는 **거기서 쪼개진다** — `C:\Program Files\x\agent.exe` 가
     * `C:\Program` 으로 잘리고, 화면에는 «CLI가 설치되어 있는지 확인하세요»가
     * 뜬다. 진짜 원인과 한참 먼 말이라 **사용자가 찾을 수가 없다.**
     *
     * 기본 에이전트는 `npx` + 패키지 이름이라 공백이 없어서 안 드러났다. 그런데
     * `command`·`args` 는 **사용자 설정**(`aiInOne.agents`)이고, CLI 가 가장 흔히
     * 사는 자리가 하필 `C:\Program Files` 다.
     *
     * 테스트를 저장소(«Taein Yoon» — 공백이 있다)로 옮기자마자 **스무 개가
     * 한꺼번에 터져서** 드러났다. 임시 폴더에는 공백이 없었다.
     *
     * ⚠️ 따옴표가 **이미 든 인자**는 건드리지 않는다. 그런 인자를 다시 감싸면
     * 더 망가지므로, 그때는 사용자가 제 손으로 묶은 것으로 보고 맡긴다.
     */
    const viaShell = process.platform === "win32";
    const quote = (s: string): string =>
      viaShell && /\s/.test(s) && !s.includes('"') ? `"${s}"` : s;

    const proc = spawn(quote(this.agent.command), this.agent.args.map(quote), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.host.defaultCwd(),
      env: { ...process.env, ...this.agent.env },
      // Windows에서 npx.cmd는 셸을 거쳐야 실행된다
      shell: viaShell,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;
    this.stderr = "";

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      // 기동 실패 진단용으로 마지막 부분만 들고 있는다
      this.stderr = (this.stderr + chunk).slice(-4000);
      this.host.log(`[${this.agent.id}] ${chunk.trimEnd()}`);
    });

    proc.on("error", (err) => {
      this.host.log(`[${this.agent.id}] 실행 실패: ${err.message}`);
    });

    // 우리가 내린 게 아니라 **죽은** 경우만 알린다 (A5)
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.conn = undefined;
      this.init = undefined;
      this.listeners.clear();
      const how = signal ? `신호 ${signal}` : `종료 코드 ${code}`;
      this.host.log(`[${this.agent.id}] 프로세스가 끝났습니다 (${how})`);
      // 🔴 **진짜 이유는 stderr에 있다.** 종료 코드만으로는 «왜 죽었나»를
      // 알 수 없다 — 토큰 만료, 메모리 부족, 설정 오류가 전부 코드 1이다.
      const tail = this.stderr.trimEnd().split("\n").slice(-3).join(" / ").slice(-300);
      this.onCrash?.(tail ? `${how} — ${tail}` : how);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );

    this.conn = acp
      .client({ name: "ai-in-one" })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
        content: await this.host.readTextFile(ctx.params.path, {
          line: ctx.params.line ?? undefined,
          limit: ctx.params.limit ?? undefined,
        }),
      }))
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        await this.host.writeTextFile(ctx.params.path, ctx.params.content);
        return {};
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.decidePermission(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.dispatch(ctx.params);
      })
      .connect(stream);

    this.conn.closed.then(() => {
      this.host.log(`[${this.agent.id}] 연결이 닫혔습니다.`);
      this.conn = undefined;
      this.listeners.clear();
    });

    try {
      this.init = await this.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          /*
           * 🔴 **elicitation 을 일부러 광고하지 않는다** (2026-09-21 실측).
           *
           * 광고하면 Claude Code 가 폼을 띄워 온다. 그런데 **안 광고하면 그냥
           * 글로 묻는다** — 그것도 더 깔끔하게. 거절하는 것과 다르다:
           * 거절하면 «답변이 아직 안 왔네요»라는 어정쩡한 상태를 보고하고,
           * 없으면 처음부터 자기 평소 길로 간다.
           *
           * 우리는 **메신저**다. 묻고 답하는 것이 이 제품의 본래 모양이고,
           * 폼은 그 위에 얹은 다른 문법이었다. 자세한 근거는 ROADMAP §D4.
           */
          // 🔴 **이걸 안 보내면 압축 알림이 아예 안 온다** (C11).
          //
          // 에이전트는 컨텍스트가 차면 **스스로 압축한다.** 그 사실을 모르면
          // 우리 트랜스크립트는 전체인데 에이전트가 아는 건 요약본인 상태가
          // 조용히 계속된다 — 사용자는 앞부분을 상대가 기억한다고 믿는다.
          session: { compaction: {} },
        },
      });
    } catch (err) {
      this.dispose();
      throw new Error(
        `${this.agent.label}을(를) 시작하지 못했습니다. ${startupHint(this.stderr)}\n` +
          `${describe(err)}${this.stderr ? `\n\n${this.stderr}` : ""}`,
      );
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.pending.clear();
    this.conn?.close();
    this.conn = undefined;
    // 먼저 떼어낸다 — 우리가 내린 종료를 크래시로 알리면 안 된다 (A5)
    const proc = this.proc;
    this.proc = undefined;
    this.init = undefined;
    if (proc) killTree(proc);
  }

  // ── 세션 ──────────────────────────────────────────────────────────────

  /**
   * 새 세션. 방 하나가 세션 하나를 소유한다.
   *
   * 로그인이 안 되어 있으면 여기서 `auth_required`가 떨어진다 — 사용자가 해당 CLI로
   * 직접 로그인해야 한다는 뜻이고, 그게 구독을 쓰는 방식이다(§0 P3).
   */
  async newSession(cwd: string, onSlowStart?: () => void): Promise<NewSessionResult> {
    await this.ensureStarted(onSlowStart);
    try {
      const res = await this.conn!.agent.request(acp.methods.agent.session.new, {
        cwd,
        // 필수 필드다. MCP 서버 설정은 백로그이므로 지금은 빈 목록.
        mcpServers: [],
      });
      return { sessionId: res.sessionId, configOptions: res.configOptions ?? [] };
    } catch (err) {
      if (describe(err).toLowerCase().includes("auth")) {
        /*
         * ⏪ **«터미널에서 해당 CLI 로» 를 무른다** (2026-10-06).
         *
         * 그렇게 적어두었는데 사용자가 F5 로 밟고 말했다 — Antigravity 는
         * 터미널에서 칠 CLI 가 사용자 기계에 **없다.** 그리고 이젠 그럴
         * 까닭도 없다 — 우리가 받아둔 것을 **로봇 화면의 «로그인» 이
         * 띄워준다.** 할 수 없는 것을 시키면 시키는 말이 아니라 **막힌 방**이 된다.
         */
        throw new Error(
          `${this.agent.label}에 로그인이 필요합니다. ` +
            `목록 화면 위의 로봇 아이콘에서 «로그인» 을 누르세요.`,
        );
      }
      throw err;
    }
  }

  /**
   * 에이전트가 프롬프트로 받아줄 수 있는 것 (I5).
   *
   * ACP 스펙이 못 박는다 — *"The Client MUST adapt its interface according to
   * PromptCapabilities"*. 광고하지 않은 종류를 보내면 조용히 무시되거나 실패한다.
   *
   * 아직 연결 전이면 **전부 허용으로 답한다** — 방 만들기 화면에서 CLI를 띄우지
   * 않으려는 것이다. 실제로 보낼 때 다시 확인한다.
   */
  promptCapabilities(): { image: boolean; audio: boolean; embeddedContext: boolean } {
    const p = this.init?.agentCapabilities?.promptCapabilities;
    if (!p) return { image: true, audio: true, embeddedContext: true };
    return {
      image: p.image === true,
      audio: p.audio === true,
      embeddedContext: p.embeddedContext === true,
    };
  }

  /**
   * 저장된 세션에 다시 붙는다 (F7). **못 붙으면 `null`,** 붙었으면 그 세션의
   * 설정 선택지(없으면 빈 배열).
   *
   * **에이전트 CLI는 자기 세션을 디스크에 남긴다.** 그래서 VSCode를 껐다 켜도
   * 기록을 되먹일 게 아니라 원래 세션으로 돌아가면 된다 — 그래야 대화 텍스트뿐
   * 아니라 **계획·메모리·도구 이력까지** 되살아난다.
   *
   * `resume`을 먼저 쓴다. 트랜스크립트는 이미 우리가 갖고 있으므로 히스토리를
   * 다시 받을 이유가 없다. `load`밖에 없으면 받아서 버린다.
   *
   * 🔴 **응답의 `configOptions`를 버리면 안 된다.** 이 방이 지금 어떤 모드·모델로
   * 돌고 있는지는 **여기서만** 알 수 있다. 버리고 나면 화면은 에이전트 기본값을
   * 보여주게 되고, 계획 모드로 해둔 방이 «Manual»로 보인다.
   */
  /**
   * 에이전트가 들고 있는 세션 id들. 물어볼 수 없으면 `null`.
   *
   * **«없어졌다»와 «복구에 실패했다»는 사용자에게 다른 말이다.** 전자는
   * 어쩔 수 없는 일이고 후자는 다시 해볼 만한 일이다. 목록을 받을 수 있으면
   * 둘을 구분해서 말해줄 수 있다.
   */
  async listSessions(cwd: string): Promise<string[] | null> {
    await this.ensureStarted();
    if (!this.init?.agentCapabilities?.sessionCapabilities?.list) return null;
    try {
      const res = await this.conn!.agent.request(acp.methods.agent.session.list, { cwd });
      return (res?.sessions ?? []).map((s) => String(s.sessionId));
    } catch (err) {
      this.host.log(`[${this.agent.id}] 세션 목록 조회 실패: ${describe(err)}`);
      return null;
    }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
  ): Promise<ResumeResult> {
    await this.ensureStarted();
    const caps = this.init?.agentCapabilities;
    const ctx = this.conn!.agent;
    try {
      if (caps?.sessionCapabilities?.resume) {
        const res = await ctx.request(acp.methods.agent.session.resume, { sessionId, cwd });
        return { ok: true, options: res?.configOptions ?? [] };
      }
      if (caps?.loadSession) {
        /*
         * 🔴 **`session/load`는 대화를 통째로 다시 흘려보낸다.**
         *
         * 스펙이 그렇게 정한다 — *"streaming the entire conversation via
         * session/update"*. `resume`이 그걸 **안 하는 것**이 둘의 차이다.
         *
         * 그런데 우리는 그 대화를 이미 디스크에 갖고 있다. 그대로 받으면
         * **방에 대화가 한 벌 더 쌓인다** — 실제로 마지막 말풍선에
         * `알겠습니다알겠습니다알겠습니다`가 붙는 걸 봤다.
         *
         * 그래서 **재생되는 동안은 버린다.** 버퍼에 쌓인 것까지 비운다 —
         * 리스너가 늦게 붙으면 그게 나중에 쏟아지기 때문이다.
         *
         * 숨기는 게 아니다(§0). 우리가 이미 보여주고 있는 바로 그 대화다.
         */
        this.replaying.add(sessionId);
        try {
          // `session/load`는 응답을 안 줘도 되는 메서드라(`| void`) 타입이 `{}`다.
          // 주면 `configOptions`가 들어 있다.
          const res = (await ctx.request(acp.methods.agent.session.load, { sessionId, cwd })) as
            | acp.LoadSessionResponse
            | undefined;
          return { ok: true, options: res?.configOptions ?? [] };
        } finally {
          /*
           * 🔴 **응답이 왔다고 재생이 끝난 게 아니다.**
           *
           * JSON-RPC 응답과 그 사이 알림은 **도착 순서가 보장되지 않는다**
           * (`runQueue`의 턴 꼬리와 같은 문제). 여기서 바로 풀면 늦게 도착한
           * 재생분이 그대로 통과해 대화가 한 벌 더 쌓인다.
           *
           * 그래서 **다음 프롬프트까지** 들고 있는다(`prompt`가 푼다). 그때부터는
           * 분명히 새 말이다. 버퍼에 쌓인 것도 같이 비운다 — 리스너가 늦게
           * 붙으면 그게 나중에 쏟아지기 때문이다.
           */
          this.pending.delete(sessionId);
        }
      }
      return { ok: false, reason: `${this.agent.label}이(가) 세션 복구를 지원하지 않습니다` };
    } catch (err) {
      // 에이전트가 세션을 지웠거나 만료됐을 수 있다. 예외가 아니라 정상 경로다.
      const reason = describe(err);
      this.host.log(`[${this.agent.id}] 세션 복구 실패, 새로 시작합니다: ${reason}`);
      return { ok: false, reason };
    }
  }

  /**
   * 이 에이전트가 **세션을 갈라줄 수 있나** (v1.1).
   *
   * `session/fork`는 **UNSTABLE**이고, 스펙이 *"only available if the agent
   * advertises the `session.fork` capability"* 라고 못 박는다. 광고 없이 부르면
   * 메서드 없음으로 떨어지거나 — 더 나쁘면 — 조용히 빈 응답이 온다.
   *
   * 그래서 **물어보고 없으면 폴백으로 간다.** 폴백은 새 세션 + 기록 재주입이라
   * 비싸지만, **모르는 채 실패하는 것보다는 낫다.**
   */
  canFork(): boolean {
    return this.forkSupport() === "yes";
  }

  /**
   * 분기를 할 수 있나 — **«모른다»를 «안 된다»와 가른다.**
   *
   * 화면이 *"상태를 잃습니다"* 라고 미리 경고하려면 이 구별이 필요하다.
   * 아직 프로세스를 안 띄운 상태에서 `false`를 돌려주면 **멀줦한 에이전트를
   * 못 한다고 모함**하게 된다. 방을 열면 이미 떠 있으므로 보통은 알 수 있다.
   */
  forkSupport(): "yes" | "no" | "unknown" {
    if (!this.init) return "unknown";
    const fork = this.init.agentCapabilities?.sessionCapabilities?.fork;
    return fork !== undefined && fork !== null ? "yes" : "no";
  }

  /**
   * 세션을 갈라 **독립된 새 세션**을 만든다 (v1.1).
   *
   * 원본은 그대로 남고 둘은 각자 살아간다. 되먹이기와 달리 대화 텍스트뿐 아니라
   * **계획·메모리·도구 이력까지** 복제된다 — 글로 다시 읽히는 폴백과 가장 크게
   * 갈리는 지점이다.
   *
   * 🔴 **지금 상태에서만 갈라진다.** `ForkSessionRequest`에는 «어느 메시지
   * 지점에서»가 **없다** — `sessionId`·`cwd`·`mcpServers`뿐이다. 그래서 과거
   * 지점 분기는 이 길로 못 가고 폴백을 써야 한다(`roomManager.forkSession`).
   *
   * ★ **갈라놓고 바로 말을 걸 수 없다 — resume을 해야 한다.**
   *
   * 실제 Claude 어댑터로 재본 결과(§13.2), `session/fork`는 새 세션을 **디스크에만**
   * 만들고 프로세스에 붙여주지는 않는다. 그 상태로 `session/prompt`를 보내면
   * *"Session not found"* 로 떨어진다 — **부모가 멀쩡히 살아 있어도** 그렇다.
   * 응답도 `{ sessionId }` 하나뿐이라 설정 목록조차 안 온다.
   *
   * 처음엔 이걸 «부모를 닫으면 분기가 깨진다»로 잘못 읽었다. 부모를 살려둔 채
   * 다시 재보고서야 원인이 **붙이지 않은 것**임이 드러났다. 그래서 여기서
   * **갈라내고 곧바로 붙여서** 돌려준다 — 부르는 쪽이 이 사정을 알 이유가 없다.
   */
  async forkSession(sessionId: string, cwd: string): Promise<ForkResult> {
    await this.ensureStarted();
    if (!this.canFork()) {
      return { ok: false, reason: `${this.agent.label}이(가) 세션 분기를 지원하지 않습니다` };
    }

    let forked: string;
    try {
      const res = (await this.conn!.agent.request(acp.methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: [],
      })) as { sessionId?: string } | undefined;

      // 세션 id가 없으면 갈라진 게 아니다. **받은 것처럼 굴지 않는다** —
      // 빈 응답을 성공으로 읽으면 방이 아무것도 아닌 id를 가리키게 된다.
      if (!res?.sessionId) {
        return { ok: false, reason: "에이전트가 분기된 세션 id를 돌려주지 않았습니다" };
      }
      forked = res.sessionId;
    } catch (err) {
      const reason = describe(err);
      this.host.log(`[${this.agent.id}] 세션 분기 실패: ${reason}`);
      return { ok: false, reason };
    }

    // **붙여야 쓸 수 있다.** 여기서 실패하면 분기는 디스크에 남지만 말을 걸 수
    // 없으므로 실패로 친다 — 폴백이 맡는 편이 낫다.
    const attached = await this.resumeSession(forked, cwd);
    if (!attached.ok) {
      return { ok: false, reason: `분기는 만들었지만 붙이지 못했습니다 — ${attached.reason}` };
    }
    return { ok: true, sessionId: forked, options: attached.options };
  }

  /** 프롬프트를 보내고 턴이 끝날 때까지 기다린다. 스트리밍은 리스너로 나간다 */
  async prompt(
    sessionId: string,
    prompt: string | acp.ContentBlock[],
  ): Promise<acp.PromptResponse> {
    // **여기부터는 새 말이다.** 재생 억제를 푸는 유일하게 확실한 지점이다.
    this.replaying.delete(sessionId);
    const blocks: acp.ContentBlock[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    return this.conn!.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: blocks,
    });
  }

  /** 진행 중인 턴을 중단한다 (C6) */
  async cancel(sessionId: string): Promise<void> {
    if (!this.conn) return;
    await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  /**
   * 세션을 놓는다. 리소스만 해제하고 **에이전트 쪽 기록은 남긴다.**
   *
   * 방을 나가는 게 아니라 단순히 안 쓰게 될 때 쓴다 (예: 설정 조회용 임시 세션).
   */
  async closeSession(sessionId: string): Promise<void> {
    this.listeners.delete(sessionId);
    if (!this.conn || !this.init?.agentCapabilities?.sessionCapabilities?.close) return;
    try {
      await this.conn.agent.request(acp.methods.agent.session.close, { sessionId });
    } catch (err) {
      this.host.log(`[${this.agent.id}] 세션 해제 실패: ${describe(err)}`);
    }
  }

  /**
   * 세션을 **에이전트에서 지운다** (B6 나가기).
   *
   * `session/close`는 *"frees up any resources"* 일 뿐이라 **CLI 디스크에는 대화가
   * 그대로 남는다.** 사용자가 방을 지웠는데 에이전트 쪽에 기록이 쌓이면 기대와 어긋난다.
   *
   * @param hasContent 대화가 오간 적이 있는지. 실제 CLI로 확인한 결과, 에이전트는
   *   **첫 프롬프트를 받아야** 세션을 프로젝트 디렉터리에 기록한다. 따라서 빈 세션에
   *   `delete`를 부르면 실패하고, 애초에 지울 것도 없다.
   */
  async deleteSession(sessionId: string, hasContent: boolean): Promise<void> {
    const caps = this.init?.agentCapabilities?.sessionCapabilities;

    // **빈 세션은 지울 게 없다.** 에이전트는 첫 프롬프트를 받아야 세션 파일을 쓰므로,
    // 대화가 없는 세션에 `delete`를 부르면 *"not found in any project directory"* 로
    // 실패한다. 게다가 실패한 `delete`가 세션을 망가뜨려 뒤이은 `close`까지 깨진다.
    if (!hasContent || !caps?.delete) {
      await this.closeSession(sessionId);
      return;
    }

    this.listeners.delete(sessionId);
    if (!this.conn) return;
    try {
      await this.conn.agent.request(acp.methods.agent.session.delete, { sessionId });
    } catch (err) {
      this.host.log(`[${this.agent.id}] 세션 삭제 실패: ${describe(err)}`);
      // 여기서 close로 폴백하지 않는다 — 실패한 delete 뒤의 close도 실패한다.
      // 프로세스가 끝날 때 정리된다.
    }
    this.purge(sessionId);
  }

  /**
   * ★ **ACP delete 가 못 치운 것을 그 CLI 가 치우게 한다** (2026-10-01).
   *
   * 🔴 Codex 는 세션을 **파일과 sqlite 인덱스 둘**에 두는데 ACP 의
   * `session/delete` 는 파일만 지운다. 그래서 방을 나갈 때마다 붕 뜬 행이
   * 쌓이고, 확장 목록엔 뜨는데 열면 *"file does not exist"* 가 난다.
   *
   * sqlite 를 우리가 직접 만지지 않는다 — **남의 제품 스키마**라 바뀌면 조용히
   * 깨진다. 대신 그 CLI 의 지우기 명령을 부른다(`AgentDef.purgeSession`).
   *
   * **기다리지 않고 실패도 삼킨다.** 이건 뒷정리지 나가기의 조건이 아니다 —
   * `codex` 가 PATH 에 없거나 느리다고 방 나가기가 막히면 안 된다. 어댑터가
   * 살아 있는 채로 불러도 되는 것은 실측으로 확인했다(`codexdelete.mts` ③).
   *
   * ⚠️ **삼키는 것과 못 보는 것은 다르다** (2026-10-01).
   *
   * 처음엔 `stdio: "ignore"` 에 `error` 만 들었다. 그러면 **명령이 돌았는데
   * 1 로 죽는 경우를 통째로 못 본다.** `error` 는 띄우기 자체가 안 될 때만
   * 온다. 하필 그게 **제일 있을법한 고장**이다 — 저쪽 CLI 가 `--force` 를
   * 갈아끼우거나 `delete` 를 옮기면 띄우기는 되고 종료코드만 바뀜다.
   *
   * 그러면 사용자는 **몇 달 뒤 목록이 유령으로 차고나서** 알게 된다. 이미
   * 한 번 걷은 길이다. 그래서 **막지는 않되 남긴다** — 종료코드와 stderr 를
   * 받아 로그로 흘린다. 나가기는 여전히 기다리지 않는다.
   */
  private purge(sessionId: string): void {
    const p = this.agent.purgeSession;
    if (!p) return;
    const args = p.args.map((a) => a.replace("{id}", sessionId));
    try {
      const child = spawn(p.command, args, {
        /*
         * stderr 만 받는다. 저쪽이 왜 거절했는지는 거기에 있고, 받아두지
         * 않으면 «안 됐다» 만 알고 **왜인지를 모른다.** 읽는 손을 반드시
         * 달아둔다 — 파이프를 열고 안 읽으면 저쪽이 막힌다.
         */
        stdio: ["ignore", "ignore", "pipe"],
        // Windows 에서 `codex` 는 `.cmd` 라 shell 없이는 `ENOENT` 다
        shell: process.platform === "win32",
        detached: false,
        /*
         * **에이전트의 환경변수를 그대로 물린다.** 그 CLI 가 어디를 보고 세션을
         * 찾는지는 환경이 정한다(`CODEX_HOME` 같은 것). 어댑터를 띄울 때 준
         * 환경을 여기서 빼면 **딴 곳을 뒤지게 된다** — 지울 것을 못 찾거나,
         * 더 나쁘게는 엉뚱한 데서 찾는다.
         */
        ...(this.agent.env ? { env: { ...process.env, ...this.agent.env } } : {}),
      });
      let said = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (c: string) => { said = (said + c).slice(-500); });

      child.on("error", (e) =>
        this.host.log(`[${this.agent.id}] 세션 뒷정리를 못 했습니다: ${describe(e)}`));
      /*
       * ★ **띄우기는 됐는데 거절당한 경우.** 여기가 없으면 저쪽 CLI 가
       * 플래그를 바꿔도 우리는 모른다 — 세션이 다시 쌀이기 시작하는데
       * 아무 말도 안 남는다.
       */
      child.on("exit", (code) => {
        if (code === 0 || code === null) return;
        this.host.log(
          `[${this.agent.id}] 세션 뒷정리가 ${code} 로 끝났습니다 ` +
            `(${p.command} ${args.join(" ")})${said ? `: ${said.trim()}` : ""}`);
      });
    } catch (err) {
      this.host.log(`[${this.agent.id}] 세션 뒷정리를 못 했습니다: ${describe(err)}`);
    }
  }

  // ── 이벤트 ────────────────────────────────────────────────────────────

  /**
   * 그 세션의 이벤트를 받는다. **붙기 전에 온 것도 받는다.**
   *
   * 🔴 `session/new`가 돌아오기도 전에 `available_commands_update`가 오는 경우가
   * 있다 — 세션 id를 알아야 붙일 수 있으니 **우리가 늦을 수밖에 없다.** 그냥
   * 버리면 압축 버튼이 첫 턴 전에는 안 보이는 식으로 조용히 빈다.
   */
  listen(sessionId: string, onEvent: (ev: AgentEvent) => void): void {
    this.listeners.set(sessionId, onEvent);
    const waiting = this.pending.get(sessionId);
    if (!waiting) return;
    this.pending.delete(sessionId);
    for (const ev of waiting) onEvent(ev);
  }

  unlisten(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.pending.delete(sessionId);
  }

  private dispatch(note: acp.SessionNotification): void {
    let events = translate(note.update);
    // 재생 중이면 이미 우리가 갖고 있는 대화다 — `resumeSession` 참조
    if (this.replaying.has(note.sessionId)) {
      const kept = events.filter((ev) => !this.isReplayed(ev));
      // **조용히 버리지 않는다**(§0). 화면에 안 띄울 뿐 무엇을 버렸는지는 남긴다.
      if (kept.length !== events.length) {
        this.host.log(
          `[${this.agent.id}] session/load 재생분 ${events.length - kept.length}건을 버렸습니다 ` +
            `(이미 방에 있는 대화입니다)`,
        );
      }
      events = kept;
    }
    const emit = this.listeners.get(note.sessionId);
    if (emit) {
      for (const ev of events) emit(ev);
      return;
    }

    // 아직 받을 사람이 없다 — 들고 있다가 붙는 순간 넘긴다.
    // **무한정 쌓지는 않는다**: 아무도 안 붙는 세션이면 메모리만 먹는다.
    const buf = this.pending.get(note.sessionId) ?? [];
    buf.push(...events);
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    this.pending.set(note.sessionId, buf);
  }

  /**
   * 재생분인가 — **내용은 버리고 상태는 받는다.**
   *
   * `session/load`가 다시 흘려보내는 건 «이미 있었던 일»이다. 말·생각·도구·계획은
   * 우리 디스크에 그대로 있으므로 받으면 **한 벌 더 쌓인다.**
   *
   * 반면 명령 목록·사용량·모드·설정은 «지금 상태»라 몇 번을 받아도 같다.
   * 오히려 붙자마자 오는 것들이라(A11) 버리면 압축 버튼이 안 뜬다. 그래서 통과시킨다.
   */
  private isReplayed(ev: AgentEvent): boolean {
    switch (ev.type) {
      case "commands":
      case "usage":
      case "mode":
      case "config":
        return false;
      default:
        return true;
    }
  }

  // ── 세션 설정 ──────────────────────────────────────────────────────────

  /**
   * 모델 등 선택지를 미리 받아온다 (B15).
   *
   * 방 만들기 화면에서 **목록이 처음부터 다 보이도록** 조회용 세션을 열어 읽고 닫는다.
   * `session/new`는 프롬프트를 보내지 않으므로 **토큰 소모가 0**이다.
   */
  async probeConfigOptions(cwd: string): Promise<acp.SessionConfigOption[]> {
    const { sessionId, configOptions } = await this.newSession(cwd);
    // 프롬프트를 안 보냈으므로 **CLI 디스크에 아예 기록되지 않는다.**
    // 해제만 하면 된다 — 지울 것도 없다.
    await this.closeSession(sessionId);
    return configOptions;
  }

  /** 설정을 바꾼다. 응답에 전체 옵션이 다시 온다 — 하나가 다른 것에 영향을 주기 때문 */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SessionConfigOption[]> {
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value };
    const res = await this.conn!.agent.request(
      acp.methods.agent.session.setConfigOption,
      params,
    );
    return res.configOptions;
  }

  // ── 권한 ──────────────────────────────────────────────────────────────

  /**
   * 권한 요청을 사용자(또는 대상)에게 넘긴다 (D1·D2).
   *
   * **우리가 자동 승인을 판단하지 않는다.** 무엇을 자동으로 넘길지는 **에이전트
   * 모드**가 정한다 — 사용자가 방 만들 때 에이전트가 준 목록에서 고른 값이다.
   * 그 모드에서 자동으로 넘어가는 건 애초에 요청이 오지 않고, **여기 온 건
   * 에이전트가 «물어봐야 한다»고 판단한 것**이므로 그대로 물어본다.
   *
   * 자동으로 넘어간 것도 흔적은 남는다 — 활동 기록(C3)이 따로 쌓인다.
   */
  private async decidePermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const req: PermissionRequest = {
      ...(params.toolCall.toolCallId ? { toolCallId: String(params.toolCall.toolCallId) } : {}),
      title: params.toolCall.title ?? "도구 사용",
      readOnly: isReadOnly(params.toolCall.kind),
      ...describeToolCall(params.toolCall),
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    };

    // 누구에게 물을지는 방을 아는 쪽이 정한다. 없으면 사용자에게.
    const decision = this.askApprover
      ? await this.askApprover(params.sessionId, req)
      : await this.host.requestPermission(req);

    /*
     * ★ **표시는 «답했나»가 아니라 «어느 쪽인가»다** (D3).
     *
     * 🔴 예전에는 고른 게 있으면 무조건 `✓` 였다. 그래서 **거절을 골라도
     * «✓ 위험한 것 — 이번만 거절»** 로 찍혔다 — 표시는 «답하긴 했다»는
     * 뜻이었지만 사람은 `✓` 를 **«허용»으로 읽는다.** 나중에 기록을 훑으며
     * *"이게 통과했었나"* 를 볼 때 정확히 거꾸로 읽히는 자리다.
     *
     * 방향은 `kind` 가 말해준다(`allow_*` · `reject_*`). 모르면 중립으로 둔다 —
     * 지어내지 않는다.
     */
    const picked =
      decision.outcome === "selected"
        ? req.options.find((o) => o.optionId === decision.optionId)
        : undefined;
    const mark = !picked
      ? "✕"
      : /^allow/i.test(picked.kind)
        ? "✓"
        : /^reject|^deny/i.test(picked.kind)
          ? "✕"
          : "·";
    this.onDecision?.(params.sessionId, {
      toolCallId: req.toolCallId,
      title: req.title,
      mark: picked ? mark : "✕",
      label: picked ? picked.name : "거부했습니다",
    });

    return decision.outcome === "selected"
      ? { outcome: { outcome: "selected", optionId: decision.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
}

/**
 * 승인 카드에 **무엇을 승인하는지** 채워 넣는다 (D1).
 *
 * ACP는 `rawInput`(실제 인자) · `content`(diff) · `locations`(파일)를 다 주는데
 * 제목만 남기면 `rm -rf /`와 `ls`가 똑같이 *"터미널 명령"* 으로 보인다.
 */
function describeToolCall(
  tc: acp.ToolCallUpdate,
): Pick<PermissionRequest, "kind" | "paths" | "command" | "diff"> {
  const out: Pick<PermissionRequest, "kind" | "paths" | "command" | "diff"> = {};

  if (tc.kind) out.kind = tc.kind;

  const paths = (tc.locations ?? []).map((l) => l.path).filter(Boolean);
  if (paths.length > 0) out.paths = paths;

  const command = commandOf(tc.rawInput);
  if (command) out.command = command;

  const diff = (tc.content ?? []).find((c) => c?.type === "diff");
  if (diff?.type === "diff") {
    out.diff = { path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText };
  }
  return out;
}

/**
 * 도구 호출에서 **실제로 실행한 것**을 꺼낸다.
 *
 * 🔴 `title`만으로는 부족하다 — `Bash`라고만 적혀 오면 `ls`인지 `rm -rf`인지
 * 알 수가 없다. **사람이 판단할 수 없는 걸 기록이라고 부를 수는 없다.**
 *
 * 에이전트마다 인자 모양이 달라 **아는 열쇠만** 집는다. 통째로 펼치면
 * 파일 전문이 쏟아질 수 있다.
 */
function commandOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  for (const key of ["command", "cmd", "script"]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * 도구가 뱉은 글 (`content[]`의 `type: "content"`).
 *
 * **길면 자른다.** 명령 결과는 수천 줄이 되기도 하는데, 그걸 통째로
 * 트랜스크립트에 넣으면 방 파일이 불어나고 화면도 감당하지 못한다.
 * 자를 때는 **자랐다고 적어서** 조용히 사라지지 않게 한다.
 *
 * diff는 여기서 빼낸다 — 그건 과정이 아니라 **결과**라 카드로 따로 남는다(E2).
 */
const TOOL_OUTPUT_MAX = 2000;

/**
 * ★ **시작 실패의 «짐작»을 한 줄로** (2026-09-28).
 *
 * 🔴 여기 있던 말이 늘 «CLI가 설치되어 있고 로그인되어 있는지 확인하세요» 였다.
 * 그런데 어느 날 **위쪽 npm 배포가 깨져** 어댑터를 못 받았을 때도 같은 말이
 * 떴다 — 사용자는 멀쩡한 CLI 를 붙들고 한참을 헤맨다. 원인을 **모르면서 하나로
 * 단정하는** 문구는 진단을 방해한다.
 *
 * 그래서 stderr 에 **또렷한 자국이 있을 때만** 그쪽을 가리키고, 없으면
 * «확인해 보세요»로 열어 둔다. 어느 쪽이든 stderr 원문은 아래에 그대로 붙는다.
 */
export function startupHint(stderr: string): string {
  if (/npm error (code E404|404)/i.test(stderr)) {
    return "어댑터 패키지를 내려받지 못했습니다 — 배포가 깨졌거나 네트워크 문제입니다.";
  }
  if (/E(AI_AGAIN|NOTFOUND|CONNRESET)|getaddrinfo|ETIMEDOUT/i.test(stderr)) {
    return "네트워크에 닿지 못했습니다.";
  }
  if (/not logged in|unauthorized|authentication/i.test(stderr)) {
    return "로그인이 필요합니다.";
  }
  return "CLI 설치와 로그인을 확인해 보세요.";
}

function outputOf(content: readonly acp.ToolCallContent[]): string | undefined {
  const parts: string[] = [];
  for (const c of content) {
    if (c?.type !== "content") continue;
    if (c.content.type === "text") parts.push(c.content.text);
  }
  const text = parts.join("\n").trimEnd();
  if (!text) return undefined;
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  const cut = text.length - TOOL_OUTPUT_MAX;
  return `${text.slice(0, TOOL_OUTPUT_MAX)}\n…[${cut.toLocaleString()}자 더]`;
}

/** ACP 업데이트 하나를 우리 이벤트 0~N개로 번역한다 */
function translate(update: acp.SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text"
        ? [{ type: "text", delta: update.content.text }]
        : [];

    case "agent_thought_chunk":
      return update.content.type === "text"
        ? [{ type: "thought", delta: update.content.text }]
        : [];

    case "tool_call":
    case "tool_call_update": {
      const locations = ("locations" in update && update.locations) || [];
      const out: AgentEvent[] = [
        {
          type: "tool",
          toolCallId: update.toolCallId,
          title: ("title" in update && update.title) || "",
          ...("kind" in update && update.kind ? { kind: update.kind } : {}),
          status: ("status" in update && update.status) || "pending",
          paths: locations.map((l) => l.path).filter(Boolean),
          // **무엇을 실행했나** (C3). `Bash`만으로는 아무것도 못 판단한다.
          ...(() => {
            const cmd = "rawInput" in update ? commandOf(update.rawInput) : undefined;
            return cmd ? { command: cmd } : {};
          })(),
          // **무엇이 나왔나.** 들어간 것만 보이면 반쪽이다.
          ...(() => {
            const out = outputOf(("content" in update && update.content) || []);
            return out ? { output: out } : {};
          })(),
        },
      ];
      // 파일 변경은 도구 사용의 부산물이 아니라 **결과**다. 따로 흘려보낸다.
      for (const part of ("content" in update && update.content) || []) {
        if (part?.type === "diff") {
          out.push({
            type: "diff",
            path: part.path,
            oldText: part.oldText ?? null,
            newText: part.newText,
          });
        }
      }
      return out;
    }

    case "compaction_summary_chunk":
      return update.content.type === "text"
        ? [
            {
              type: "compaction",
              id: update.compactionId,
              status: "in_progress",
              summaryDelta: update.content.text,
            },
          ]
        : [];

    case "compaction_update": {
      const summary = (update.summary ?? [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      return [
        {
          type: "compaction",
          id: update.compactionId,
          status: String(update.status),
          ...(summary ? { summary } : {}),
        },
      ];
    }

    case "usage_update":
      return [
        {
          type: "usage",
          used: update.used,
          size: update.size,
          ...(update.cost ? { cost: update.cost } : {}),
        },
      ];

    case "available_commands_update":
      return [{ type: "commands", names: update.availableCommands.map((c) => c.name) }];

    default:
      return [];
  }
}

/**
 * 폼 스키마를 셸이 그릴 수 있는 형태로 추린다 (D4).
 *
 * **모르는 타입은 버리지 않고 `unsupported`로 넘긴다.** 스펙이 확장 가능하므로
 * (`_` 접두어는 구현별 확장) 새 타입이 와도 렌더러가 죽지 않아야 한다.
 */



/**
 * 부작용이 없는 도구인지 (D2의 `reads` 정책 기준).
 *
 * **`fetch`는 읽기가 아니다.** 워크스페이스 파일을 읽는 것과 인터넷에 나가는 건
 * 다르다 — 데이터가 밖으로 나가는 경로이고, 가져온 내용이 그대로 프롬프트에
 * 들어와 인젝션 통로가 되기도 한다. 자동 승인 대상에서 뺀다.
 *
 * `think`도 뺀다. 도구로 표시되지만 승인을 물을 일이 아니고, 혹시 온다면
 * 우리가 모르는 무언가다.
 */
function isReadOnly(kind: string | null | undefined): boolean {
  return kind === "read" || kind === "search";
}

/**
 * 오류를 사람이 읽을 글로 (§0 P5 — **CLI가 준 걸 숨기지 않는다**).
 *
 * 🔴 `err.message`만 쓰면 «Internal error»가 뜬다. JSON-RPC는 껍데기에
 * 일반 문구를 두고 **쓸모 있는 말은 `data`에** 넣기 때문이다. 실제로 겪은 것들:
 *
 * ```
 * {"code":-32603,"message":"Internal error",
 *  "data":{"message":"You've hit your usage limit. Upgrade to Plus…"}}   ← Codex 사용량
 * {"code":-32603,"message":"Internal error",
 *  "data":{"details":"Session not found"}}                              ← Claude 세션
 * ```
 *
 * 둘 다 화면에는 «Internal error»로 떴을 것이다. **왜 안 되는지를 아는 건
 * 에이전트뿐인데, 그걸 우리가 지워버리면 사용자는 물어볼 곳이 없다.**
 */
export function describe(err: unknown): string {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return JSON.stringify(err);

  const e = err as { message?: unknown; data?: unknown };
  const head = typeof e.message === "string" ? e.message : "";
  const deep = detailOf(e.data);

  // 안쪽이 더 구체적이면 그걸 앞세운다. 껍데기는 대개 «Internal error»다.
  if (deep && deep !== head) return head ? `${head} — ${deep}` : deep;
  return head || JSON.stringify(err);
}

/** JSON-RPC `data`에서 쓸 만한 한 줄을 꺼낸다. 모양이 제각각이라 몇 군데를 본다 */
function detailOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  for (const key of ["message", "details", "detail", "error", "reason"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // 아는 열쇠가 없으면 **통째로 보여준다** — 버리는 것보다 낫다
  const text = JSON.stringify(data);
  return text === "{}" ? "" : text.slice(0, 400);
}

/**
 * 프로세스를 **자식까지** 끝낸다.
 *
 * 🔴 Windows에서는 `npx.cmd`를 띄우려고 셸을 거치기 때문에(`shell: true`) 우리가
 * 손에 쥔 건 `cmd.exe`다. `kill()`은 그 셸만 죽이고 **정작 CLI는 살아남아**
 * 창을 닫을 때마다 에이전트 프로세스가 하나씩 쌓인다. `taskkill /T`로 트리째 끝낸다.
 */
function killTree(proc: ChildProcessWithoutNullStreams): void {
  // 🔴 **파이프를 안 닫으면 프로세스를 죽여도 핸들이 남는다.** stdio를 웹
  // 스트림으로 감싸 쓰고 있어서(`ndJsonStream`) 그쪽이 계속 붙들고 있다.
  // 확장 호스트가 안 끝나거나 테스트가 안 빠져나오는 형태로 드러난다.
  for (const pipe of [proc.stdin, proc.stdout, proc.stderr]) {
    pipe.removeAllListeners();
    // 닫는 도중에 나는 소리는 무시한다 — **우리가 내린 종료다.**
    // 핸들러가 없으면 스트림 오류가 «처리 안 된 예외»로 튀어 확장을 죽인다.
    pipe.on("error", () => {});
    pipe.destroy();
  }
  proc.removeAllListeners("exit");
  proc.unref();

  if (process.platform === "win32" && proc.pid !== undefined) {
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      }).unref();
      return;
    } catch {
      // taskkill을 못 쓰면 아래 기본 경로로 — 셸만이라도 정리한다
    }
  }
  proc.kill();
}
