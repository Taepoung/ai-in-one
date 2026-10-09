import * as vscode from "vscode";
import * as path from "node:path";
import { resolveAgents } from "../core/agentCatalog.js";
import { withInstalled, sweepStrays } from "../core/agentInstaller.js";
import { RoomManager } from "../core/roomManager.js";
import { McpServer } from "../core/mcpServer.js";
import { RoomLocks } from "../core/roomLock.js";
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

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const began = Date.now();
  const out = vscode.window.createOutputChannel("AI in One");
  const host = new VscodeHost(out);

  // `globalState`는 용량 제한이 있어 쓰지 않는다. 대화는 파일로 남긴다 (F5).
  const store = new RoomStore(ctx.globalStorageUri.fsPath);
  const storeBegan = Date.now();
  await store.init();
  const storeTook = Date.now() - storeBegan;

  const agentRoot = ctx.globalStorageUri.fsPath;
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
  const mcp = new McpServer({ log: (m) => host.log(m) });

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

  const rooms = new RoomManager({ host, store, agents, mcp, locks });
  // 도구를 건다 — 서버가 만들어진 **뒤**라야 방 매니저가 있다
  mcp.setHandlers(rooms.mcpTools(), (owner, tool, args) => rooms.mcpCall(owner, tool, args));
  // 세우는 것은 방 매니저를 거친다 — 그래야 결과가 화면까지 같은 길로 간다
  void rooms.startMcp();

  // ── 상태 표시줄 — 앱 아이콘이자 배지 (F1·F8) ─────────────────────────
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "aiInOne.open";
  status.tooltip = "AI in One 채팅 열기";
  const paint = () => {
    const unread = rooms.totalUnread();
    status.text = unread > 0 ? `$(comment-discussion) AI ${unread}` : "$(comment-discussion) AI";
    status.show();
  };
  paint();
  rooms.on("metas", paint);

  /*
   * 🔴 **버려진 것을 쓸어담는다** (2026-10-07).
   *
   * F5 나 창 닫기로 확장 호스트가 죽으면 `dispose` 가 못 돈다. Claude·Codex
   * 는 stdin 이 닫히면 알아서 끝나는데 **Antigravity 의 파이썬 서버는
   * 안 끝난다.** 그래서 그쪽만 27개·581MB 가 쌓였다(실측).
   *
   * ⚠️ 기준은 «우리 자리에서 나왔나» 가 아니라 **«부모가 죽었나»** 다 —
   * globalStorage 는 창끼리 나눠 쓰므로 전부 죽이면 **옆 창이 쓰는 것까지
   * 죽인다.** 옆 창의 것은 그 창의 호스트가 부모로 살아 있다.
   *
   * 막지는 않는다 — 못 쓸어담아도 나머지는 돌아가야 한다.
   */
  try {
    const swept = sweepStrays(agentRoot);
    if (swept > 0) out.appendLine(`버려진 에이전트 ${swept}개를 내렸습니다.`);
  } catch { /* 치우기가 켜기를 막으면 안 된다 */ }

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
    out,
    status,
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
    vscode.commands.registerCommand("aiInOne.open", () => show()),
    vscode.commands.registerCommand("aiInOne.newRoom", () => show("new")),
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
