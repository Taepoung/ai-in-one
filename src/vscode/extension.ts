import * as vscode from "vscode";
import * as path from "node:path";
import { resolveAgents } from "../core/agentCatalog.js";
import { withInstalled, sweepStrays } from "../core/agentInstaller.js";
import { RoomManager } from "../core/roomManager.js";
import { McpServer } from "../core/mcpServer.js";
import { RoomLocks } from "../core/roomLock.js";
import { sweepBacklog } from "../core/purgeBacklog.js";
import { RoomStore } from "../core/store.js";
import type { AgentDef } from "../core/types.js";
import { BLOB_SCHEME, BlobDocuments } from "./blobDocuments.js";
import { ChatPanel } from "./chatPanel.js";
import { openImeProbe } from "./imeProbe.js";
import { VscodeHost } from "./vscodeHost.js";

/**
 * **활성화가 오래 걸렸다면 어디서 걸렸는지 알 수 있어야 한다.**
 *
 * VSCode는 확장이 늦게 뜨면 *"10초가 넘었으니 창을 다시 로드하라"* 고만
 * 말해준다 — **누구 탓인지는 안 말해준다.** 그러면 우리는 짐작하게 되고,
 * 짐작으로 고치면 맞았는지도 모른다. 그래서 우리 몴은 우리가 재둔다(§0).
 *
 * 디스크를 만지는 것은 `store.init()` 뿐이므로 그것만 따로 재면 충분하다 —
 * `rooms.json`이 깨졌을 때만 방 파일을 전부 읽어 재조립하기 때문이다.
 */
const SLOW_ACTIVATE_MS = 1000;

/** 켜기를 몇 번까지 다시 해보나 — 때를 타는 실패가 있어서 (2026-10-13) */
const BOOT_TRIES = 3;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const began = Date.now();
  const out = vscode.window.createOutputChannel("AI in One");
  ctx.subscriptions.push(out);

  /*
   * ★ **켜는 중 · 됐다 · 터졌다 — 셋을 가른다** (2026-10-13).
   *
   * 🔴 여태 `activate` 의 **맨 끝**에서 명령을 등록했다. 그 앞에 `store.init()` ·
   * MCP 서버 · 방 락 · 방 매니저가 다 있어서, **어느 하나가 터지거나 느리면
   * 명령이 아예 안 생긴다.** 사용자 눈에 남는 것은 `command 'aiInOne.open'
   * not found` 뿐이고 **왜 안 되는지가 한 글자도 없다.**
   *
   * 그런데 명령만 앞으로 옮기면 **켜는 중에 누른 경우**가 새로 생긴다 —
   * 아직 안 끝난 것을 «못 켰다»로 말하면 그것도 거짓말이다. 그래서 셋이다:
   *
   * ```
   * 켜는 중   눌러둔 것을 **기억했다가** 끝나면 그때 연다
   * 됐다      진짜 창
   * 터졌다    왜인지 + «창을 다시 불러오세요»
   * ```
   */
  let phase: "booting" | "ready" | "failed" = "booting";
  let bootError: unknown;
  let show: ((screen?: "new") => void) | undefined;
  /** 켜는 중에 눌러둔 것 — `false` 는 «안 눌렀다» */
  let wanted: "new" | undefined | false = false;

  /*
   * ★ **켜는 중인 것이 보여야 한다** (2026-10-13).
   *
   * 사용자: *"창이 안뜨니까 너무 답답해"*. 상태 표시줄은 **켜기 전에** 만들어
   * 돌려두고, 켜지면 방 매니저가 이어받아 안 읽은 수를 그린다.
   */
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "aiInOne.open";
  status.text = "$(sync~spin) AI";
  status.tooltip = "AI in One 을 켜는 중입니다…";
  status.show();
  ctx.subscriptions.push(status);

  const open = (screen?: "new"): void => {
    if (phase === "ready" && show) { show(screen); return; }
    if (phase === "booting") {
      // **누른 것을 안 버린다** — 끝나면 그때 연다. 기다리라고만 하면 또 누른다
      wanted = screen;
      void vscode.window.showInformationMessage(
        "AI in One 을 켜는 중입니다 — 준비되면 바로 엽니다.",
      );
      return;
    }
    out.show(true);
    void vscode.window.showErrorMessage(
      `AI in One 을 켜지 못했습니다: ${describeBoot(bootError)} — ` +
        "창을 다시 불러오세요(Ctrl+R).",
    );
  };

  /*
   * ⚠️ 아래 본문에서는 이 둘을 **다시 등록하지 않는다** — 같은 이름을 두 번
   * 등록하면 VSCode 가 거기서 또 터진다.
   */
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aiInOne.open", () => open()),
    vscode.commands.registerCommand("aiInOne.newRoom", () => open("new")),
  );

  /*
   * ★ **세 번까지 다시 해본다** (2026-10-13).
   *
   * 실제로 한 번 안 켜졌고 **창을 다시 불러오니 풀렸다** — 때를 타는 실패다.
   * 사람에게 «다시 불러오세요» 를 시키기 전에 **우리가 먼저 해본다.**
   *
   * 🔴 **반쯤 만든 것은 `boot` 가 치우고 올린다.** 안 치우면 다시 할 때마다
   * 포트와 프로세스가 샌다.
   */
  for (let tries = 1; tries <= BOOT_TRIES; tries++) {
    /*
     * ★ **다시 해보는 중인 것도 보인다** — 상태 표시줄에 «2/3».
     *
     * 안 보이면 사용자는 **같은 자리에 멈춰 있는 줄 안다.** 뭔가 하고 있고
     * 몇 번째인지가 보이면 기다릴 수 있다.
     */
    const nth = tries > 1 ? ` ${tries}/${BOOT_TRIES}` : "";
    status.text = `$(sync~spin) AI${nth}`;
    const step = (what: string) => {
      status.tooltip = `AI in One — ${what}…${nth ? ` (${tries}번째)` : ""}`;
      out.appendLine(`  ${String(Date.now() - began).padStart(5)}ms  ${what}`);
    };
    try {
      show = await boot(ctx, out, began, status, step);
      phase = "ready";
      break;
    } catch (err) {
      bootError = err;
      out.appendLine(`🔴 켜기 ${tries}/${BOOT_TRIES} 실패: ${describeBoot(err)}`);
      if (err instanceof Error && err.stack) out.appendLine(err.stack);
      if (tries < BOOT_TRIES) {
        // 조금 쉬었다 다시 — 디스크가 바쁘거나 옆 창과 부딪힌 것일 수 있다
        status.tooltip = `AI in One — 다시 켜봅니다 (${tries + 1}/${BOOT_TRIES})…`;
        await new Promise((r) => setTimeout(r, 300 * tries));
        continue;
      }
      phase = "failed";
      status.text = "$(error) AI";
      status.tooltip = `AI in One 을 켜지 못했습니다: ${describeBoot(err)}`;
      out.show(true);
      void vscode.window.showErrorMessage(
        `AI in One 을 ${BOOT_TRIES}번 켜봤지만 안 됐습니다: ${describeBoot(err)} — ` +
          "창을 다시 불러오세요(Ctrl+R). 자세한 것은 출력 창에 있습니다.",
      );
    }
  }

  // ★ **켜는 중에 눌러둔 것을 이제 연다** — 기다린 사람을 또 누르게 하지 않는다
  if (phase === "ready" && wanted !== false) open(wanted);
}

/** 오류를 사람이 읽을 한 줄로 — 메시지가 비면 통째로 적는다 */
function describeBoot(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** 실제로 켜는 일 — 터지면 위에서 받아 **보여준다** */
async function boot(
  ctx: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  began: number,
  status: vscode.StatusBarItem,
  /**
   * ★ **지금 어느 칸인지 알린다** (2026-10-13).
   *
   * 사용자: *"어느 단계가 진행중인지, 잘 되고 있는지, 재시도가 되는지 이게
   * 사용자에게 보였으면 해서, 그럼 기다리기 편하잖아"*.
   *
   * 평소엔 40ms 라 스쳐 지나간다. **느려졌을 때가 이게 있을 자리다** —
   * 어디서 걸렸는지가 툴팁과 출력 창에 남아, «왜 안 뜨지» 가 «기록 읽는
   * 데서 걸렸구나» 가 된다. 오늘 23초를 먹은 것도 **그 칸 이름이 있었으면**
   * 바로 보였을 것이다.
   */
  step: (what: string) => void,
): Promise<(screen?: "new") => void> {
  const host = new VscodeHost(out);

  // `globalState`는 용량 제한이 있어 쓰지 않는다. 대화는 파일로 남긴다 (F5).
  const store = new RoomStore(ctx.globalStorageUri.fsPath);
  const storeBegan = Date.now();
  step("기록 읽는 중");
  await store.init();
  const storeTook = Date.now() - storeBegan;

  const agentRoot = ctx.globalStorageUri.fsPath;
  step("에이전트 목록 읽는 중");
  let agents = readAgents(agentRoot);

  /*
   * ★ **봇끼리 말을 걸게 해주는 MCP 서버** (v3.0 2-F).
   *
   * 🔴 **창마다 하나다.** VSCode 는 창마다 확장 호스트가 따로 돌고, 창을
   * 가로질러 하나만 띄우면 **큐가 프로세스 경계를 넘는다** — 그러면 경합
   * 규칙(꺼내기를 먼저 · 세서 쓴다 · 락 없음)이 전부 무너진다.
   *
   * ★ **확장이 켜질 때 같이 켠다.** 방을 열 때 켜면 «언제 켜졌나»가 방마다
   * 달라지고, 되살아난 세션이 **아직 안 선 주소**를 들고 있을 수 있다.
   *
   * ⚠️ **기다리지 않는다.** 포트 하나 여는 일이라 보통 즉시지만, 막히면
   * 확인(자기 주소 쳐보기)이 늘어질 수 있다 — 그 때문에 확장이 늦게 뜨면
   * 안 된다. 서면 그때부터 세션에 실린다.
   */
  /*
   * ⚠️ **도구와 부르는 길은 방 매니저가 안다.** 서버는 통로일 뿐이다 —
   * 큐도 방도 저쪽에 있다. 그래서 늦게 묶는다(아래 `setHandlers`).
   */
  /*
   * ★ **반쯤 만든 것은 치우고 올린다** (2026-10-13).
   *
   * 🔴 켜기를 **다시 해보기** 때문이다. 포트를 잡고(MCP) 자리를 잡고(락)
   * CLI 를 띄우는(방 매니저) 것들이라, 안 치우고 다시 만들면 **판마다
   * 샌다** — 세 번 하면 세 벌이 뜬 채로 남는다.
   */
  const madeHere: Array<() => void> = [];
  const undoAll = () => {
    for (const undo of madeHere.reverse()) {
      try { undo(); } catch { /* 치우다 터져도 나머지는 치운다 */ }
    }
  };
  try {
  step("봇끼리 부르는 길 세우는 중");
  const mcp = new McpServer({ log: (m) => host.log(m) });
  madeHere.push(() => mcp.close());

  // 권한은 **봇에 붙는다**(D2). 전역 설정이 없으므로 여기서 넘길 것도 없다 —
  // 방을 만들 때 봇마다 정하고, 그 뒤엔 권한 설정 시트나 참여자 서랍에서 바꾼다.
  /*
   * ★ **같은 방은 한 창에서만** (v3.0 2-G).
   *
   * 🔴 두 창이 같은 방을 열면 **세션이 어긋난다** — `ensureSession` 이
   * 「사라졌다」와 「남이 쓰는 중이다」를 안 가리고 새 세션으로 덮기 때문이다.
   *
   * 창 이름은 **사람에게 보여줄 글**이다. 폴더 이름이 제일 알아보기 쉽다 —
   * 창 제목은 파일에 따라 계속 바뀐다.
   */
  const locks = new RoomLocks(
    path.join(ctx.globalStorageUri.fsPath, "rooms"),
    vscode.workspace.workspaceFolders?.[0]?.name ?? "다른 창",
    (m) => host.log(m),
  );
  madeHere.push(() => locks.releaseAll());

  step("방을 여는 중");
  const rooms = new RoomManager({ host, store, agents, mcp, locks, agentRoot });
  madeHere.push(() => rooms.dispose());
  // 도구를 건다 — 서버가 만들어진 **뒤**라야 방 매니저가 있다
  mcp.setHandlers(rooms.mcpTools(), (owner, tool, args) => rooms.mcpCall(owner, tool, args));
  // 세우는 것은 방 매니저를 거친다 — 그래야 결과가 화면까지 같은 길로 간다
  void rooms.startMcp();

  /*
   * ── 상태 표시줄 — 앱 아이콘이자 배지 (F1·F8)
   *
   * **만드는 것은 `activate` 가 한다** — 켜는 동안 돌아가는 표시를 보여줘야
   * 해서다. 여기서는 **이어받아** 안 읽은 수를 그린다.
   */
  status.tooltip = "AI in One 채팅 열기";
  const paint = () => {
    const unread = rooms.totalUnread();
    status.text = unread > 0 ? `$(comment-discussion) AI ${unread}` : "$(comment-discussion) AI";
    status.show();
  };
  paint();
  rooms.on("metas", paint);

  /*
   * 🔴 **버려진 것을 쓸어담는다** (2026-10-07) — 그런데 **켜기 길에서 비켰다**
   * (2026-10-13).
   *
   * F5 나 창 닫기로 확장 호스트가 죽으면 `dispose` 가 못 돈다. Claude·Codex
   * 는 stdin 이 닫히면 알아서 끝나는데 **Antigravity 의 파이썬 서버는
   * 안 끝난다.** 그래서 그쪽만 27개·581MB 가 쌓였다(실측).
   *
   * 🔴 **그런데 그 청소가 창을 막고 있었다.** 프로세스 목록을 얻으려고
   * PowerShell 을 **동기로** 돌리는데, 이 기계에서 재보니:
   *
   * ```
   * powershell -Command 1          3,658ms   ← 아무것도 안 해도
   * Get-CimInstance Win32_Process  40,000ms  ← 타임아웃
   * sweepStrays() 한 판        23,000~30,000ms
   * ```
   *
   * 확장 호스트는 **한 가닥**이라 그동안 창도 안 뜨고 명령도 안 생기고
   * **옆 확장까지 같이 선다.** 사용자가 본 `command 'aiInOne.open' not
   * found` 가 그것이다.
   *
   * ★ **청소는 켜기의 조건이 아니다.** 창이 먼저 뜨고, 청소는 **뒤에서**
   * 한다. 못 치워도 다음에 켤 때 또 한다.
   *
   * ⚠️ **순서는 지킨다** — 지우는 길이 없는 에이전트는 우리가 파일을
   * 지우는데(`purgeFiles`), 저쪽 프로세스가 들고 있으면 `EPERM` 이다.
   * **버려진 것을 내린 다음**이라야 지울 수 있다.
   */
  const housekeeping = (async () => {
    /*
     * ★ **출력 창에만 적는다 — 사용자에게는 안 알린다** (2026-10-13).
     *
     * 뒷정리는 몇 초씩 걸리지만 **사용자가 할 일이 없다** — 막지도 않고
     * 고를 것도 없다. 보이는 자리(툴팁·알림)는 **기다리는 사람**을 위한
     * 것이지, 뒤에서 도는 집안일을 중계하는 자리가 아니다. 한때 툴팁을
     * «뒷정리 중» 으로 덮었는데, 그동안 «채팅 열기» 가 안 보였다.
     *
     * 출력 창은 다르다 — **고장 났을 때 읽는 자리**다. 시작과 끝을 적어두면
     * «시작만 있고 끝이 없다» 로 멈춘 것을 알 수 있고, 걸린 시각이 남는다.
     * 오늘 23초를 먹은 것을 못 찾은 까닭이 그 줄이 없어서였다.
     */
    const tidyBegan = Date.now();
    out.appendLine("뒷정리 시작 — 버려진 에이전트와 밀린 파일.");
    try {
      const swept = await sweepStrays(agentRoot);
      if (swept > 0) out.appendLine(`버려진 에이전트 ${swept}개를 내렸습니다.`);
    } catch { /* 치우기가 켜기를 막으면 안 된다 */ }
    try {
      const left = store.getAppState().purgeBacklog ?? [];
      if (left.length > 0) {
        const { done, keep } = sweepBacklog(left, agents, (m) => out.appendLine(m));
        if (done > 0) out.appendLine(`밀려 있던 세션 ${done}개의 파일을 치웠습니다.`);
        if (keep.length !== left.length) void store.patchAppState({ purgeBacklog: keep });
      }
    } catch { /* 치우기가 켜기를 막으면 안 된다 */ }
    out.appendLine(`뒷정리 끝 (${Date.now() - tidyBegan}ms).`);
  })();
  // 창이 닫혀도 돌던 청소는 끝까지 간다 — 다만 **아무도 안 기다린다**
  void housekeeping;

  /*
   * ★ **창이 여럿이어도 같이 움직인다** (2026-10-07).
   *
   * 사용자: *"저장소는 공유하고 영향도 공유하게 하자 어짜피 개인이 쓸거니까"*.
   * `globalStorage` 는 OS 사용자 프로필 아래라 **한 사람 몫**이고, 그 사람의
   * 창들은 같은 자리를 본다.
   *
   * 전엔 에이전트 목록을 **켜질 때 한 번** 읽고 말았다. 그래서 A 창에서 받으면
   * B 창의 방은 **«아직 받지 않았습니다»** 를 계속 말했다 — 오늘 고친 연결 객체
   * 문제와 같은 종류인데 층만 한 칸 위다.
   *
   * ⚠️ **깊이 보지 않는다.** `node_modules` 까지 뒤지면 445MB 를 감시하게 된다.
   * 받고 지우면 **자리(폴더) 자체가 생기고 없어지므로** 한 칸이면 된다.
   */
  const watch = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(agentRoot, "agents")), "*"),
  );
  const reread = (): void => {
    agents = readAgents(agentRoot);
    rooms.setAgents(agents);
    ChatPanel.repaintAgents();
  };
  watch.onDidCreate(reread);
  watch.onDidDelete(reread);
  ctx.subscriptions.push(watch);

  const show = (screen?: "new") =>
    ChatPanel.show(
      ctx, rooms, store,
      () => agents,
      (t) => host.setAskTarget(t),
      () => { agents = readAgents(agentRoot); rooms.setAgents(agents); },
      screen,
    );

  ctx.subscriptions.push(
    // 변경 전/후를 디스크 없이 보여주기 위한 가상 문서 (E3)
    vscode.workspace.registerTextDocumentContentProvider(
      BLOB_SCHEME,
      new BlobDocuments(store),
    ),
    { dispose: () => rooms.dispose() },
    // 포트를 놓는다 — 창이 닫히면 이 창의 서버도 같이 내려간다
    { dispose: () => mcp.close() },
    // 들고 있던 자리를 놓는다 — 안 놓으면 다음에 열 때 **내 죽은 pid** 가 막는다
    { dispose: () => locks.releaseAll() },
    // `aiInOne.open`·`newRoom` 은 **맨 위에서 이미 등록했다** — 여기서 또 하면 터진다
    // v2.0 선결 과제를 재는 시험판 — 답이 나오면 지운다
    vscode.commands.registerCommand("aiInOne.imeProbe", () => openImeProbe(ctx)),
    vscode.commands.registerCommand("aiInOne.attachSelection", async () => {
      if (!(await show().attachSelection())) {
        void vscode.window.showInformationMessage(
          "AI in One: 채팅방을 열고 코드를 선택한 뒤 다시 시도하세요.",
        );
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aiInOne.agents")) return;
      // 에이전트 정의가 바뀌면 다음에 여는 방부터 반영된다. 이미 뜬 프로세스는 그대로 둔다 —
      // 대화 중에 CLI를 갈아끼우면 세션이 끊긴다.
      agents = readAgents(agentRoot);
      rooms.setAgents(agents);
      out.appendLine("에이전트 설정이 바뀌었습니다. 새로 만드는 방부터 적용됩니다.");
    }),
  );

  const took = Date.now() - began;
  out.appendLine(
    `활성화 ${took}ms (기록 읽기 ${storeTook}ms · 방 ${rooms.listMetas().length}개)`,
  );
  // 느렸으면 **눈에 보이는 곳에도** — 출력 창을 열어볼 생각을 하려면
  // 먼저 «느렸다»를 알아야 한다. 빠를 때는 조용하다.
  if (took >= SLOW_ACTIVATE_MS) {
    out.appendLine(
      `⚠ 활성화가 느렸습니다. 디스크가 바쁘거나 기록이 많을 수 있습니다.`,
    );
  }
  /*
   * ★ **여기까지 왔으면 치울 일이 없다.** 아래부터는 `ctx.subscriptions` 가
   * 들고 있으므로 창이 닫힐 때 같이 내려간다.
   */
  madeHere.length = 0;
  return show;
  } catch (err) {
    undoAll();
    throw err;
  }
}

export function deactivate(): void {
  // `ctx.subscriptions`가 RoomManager를 정리한다. CLI 프로세스도 거기서 함께 내려간다.
}

/**
 * 설정을 읽고, **받아둔 것이 있으면 그쪽으로** 돌린다.
 *
 * `withInstalled` 는 받아둔 에이전트만 고친다 — 안 받았거나 `pkg` 가
 * 없으면 적힌 대로(`npx -y …`) 둔다. 그래서 **받기 전에도 멀줦히 돌고**
 * 받은 뒤에만 우리 자리를 쓴다(`docs/INSTALL.md`).
 */
function readAgents(root: string): AgentDef[] {
  const overrides = vscode.workspace
    .getConfiguration("aiInOne")
    .get<Record<string, Partial<AgentDef>>>("agents", {});
  return resolveAgents(overrides).map((a) => withInstalled(a, root));
}
