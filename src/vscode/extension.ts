import * as vscode from "vscode";
import { resolveAgents } from "../core/agentCatalog.js";
import { RoomManager } from "../core/roomManager.js";
import { RoomStore } from "../core/store.js";
import type { AgentDef } from "../core/types.js";
import { BLOB_SCHEME, BlobDocuments } from "./blobDocuments.js";
import { ChatPanel } from "./chatPanel.js";
import { VscodeHost } from "./vscodeHost.js";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel("AI in One");
  const host = new VscodeHost(out);

  // `globalState`는 용량 제한이 있어 쓰지 않는다. 대화는 파일로 남긴다 (F5).
  const store = new RoomStore(ctx.globalStorageUri.fsPath);
  await store.init();

  let agents = readAgents();
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

  const show = (screen?: "new") =>
    ChatPanel.show(ctx, rooms, store, () => agents, (t) => host.setAskTarget(t), screen);

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
      agents = readAgents();
      out.appendLine("에이전트 설정이 바뀌었습니다. 새로 만드는 방부터 적용됩니다.");
    }),
  );
}

export function deactivate(): void {
  // `ctx.subscriptions`가 RoomManager를 정리한다. CLI 프로세스도 거기서 함께 내려간다.
}

function readAgents(): AgentDef[] {
  const overrides = vscode.workspace
    .getConfiguration("aiInOne")
    .get<Record<string, Partial<AgentDef>>>("agents", {});
  return resolveAgents(overrides);
}
