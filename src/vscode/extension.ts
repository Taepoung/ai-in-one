import * as vscode from "vscode";
import { resolveAgents } from "../core/agentCatalog.js";
import { withInstalled, sweepStrays } from "../core/agentInstaller.js";
import { RoomManager } from "../core/roomManager.js";
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
  // 권한은 **봇에 붙는다**(D2). 전역 설정이 없으므로 여기서 넘길 것도 없다 —
  // 방을 만들 때 봇마다 정하고, 그 뒤엔 자율 모드 버튼이나 참여자 서랍에서 바꾼다.
  const rooms = new RoomManager({ host, store, agents });

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
