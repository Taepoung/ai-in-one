import * as vscode from "vscode";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../core/types.js";
import type { WorkspaceHost } from "../core/workspaceHost.js";

/**
 * 사용자에게 물어보는 두 요청을 채팅 화면으로 넘기는 통로.
 *
 * 패널이 붙으면 인라인 카드로(D1·D4), 닫혀 있으면 네이티브 모달로 간다 —
 * **패널을 닫아도 에이전트는 계속 일하므로** 물어볼 곳이 없으면 안 된다.
 */
export interface AskTarget {
  permission(req: PermissionRequest): Promise<PermissionDecision>;
}

export class VscodeHost implements WorkspaceHost {
  private target: AskTarget | null = null;

  constructor(private readonly out: vscode.OutputChannel) {}

  /** 채팅 패널이 열리면 자기를 등록한다. 닫히면 `null`로 되돌린다 */
  setAskTarget(target: AskTarget | null): void {
    this.target = target;
  }

  /**
   * **디스크가 아니라 열려 있는 문서를 먼저 읽는다.**
   *
   * ACP가 파일 읽기를 클라이언트에 맡긴 이유가 이것 — 저장하지 않은 편집 내용을
   * 에이전트가 보게 하려는 것이다. 디스크를 읽으면 사용자가 방금 고친 걸 놓친다.
   */
  async readTextFile(
    path: string,
    opts?: { line?: number; limit?: number },
  ): Promise<string> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    const text = open
      ? open.getText()
      : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));

    if (opts?.line === undefined && opts?.limit === undefined) return text;

    // ACP의 `line`은 1부터 센다.
    const lines = text.split(/\r?\n/);
    const from = Math.max(0, (opts.line ?? 1) - 1);
    const to = opts.limit === undefined ? lines.length : from + opts.limit;
    return lines.slice(from, to).join("\n");
  }

  /**
   * 문서가 열려 있으면 **편집으로** 쓴다.
   *
   * 디스크에 직접 쓰면 에디터에 열린 내용과 어긋나 *"파일이 변경되었습니다"*
   * 충돌이 뜬다. 편집으로 넣으면 실행 취소도 사용자 손에 남는다.
   */
  async writeTextFile(path: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);

    if (open) {
      const edit = new vscode.WorkspaceEdit();
      const whole = new vscode.Range(
        open.positionAt(0),
        open.positionAt(open.getText().length),
      );
      edit.replace(uri, whole, content);
      await vscode.workspace.applyEdit(edit);
      return;
    }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    if (this.target) return this.target.permission(req);

    // 패널이 닫혀 있다. 모달이라도 띄운다 — 조용히 취소하면 에이전트가 멈춘 이유를 모른다.
    const picked = await vscode.window.showInformationMessage(
      req.title,
      { modal: true, detail: "AI in One — 에이전트가 권한을 요청합니다." },
      ...req.options.map((o) => o.name),
    );
    const option = req.options.find((o) => o.name === picked);
    return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
  }


  log(message: string): void {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  hasWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  }

  defaultCwd(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      // 워크스페이스가 없으면 에이전트는 홈에서 돈다. 방 만들 때 바꿀 수 있다 (B9).
      process.env.HOME ??
      process.env.USERPROFILE ??
      process.cwd()
    );
  }
}
