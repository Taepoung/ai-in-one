import * as vscode from "vscode";
import type { RoomStore } from "../core/store.js";
import { baseName } from "../core/types.js";

/** 가상 문서 스킴. blob 해시를 경로로 받는다 */
export const BLOB_SCHEME = "ai-in-one-blob";

/**
 * 변경 전/후 전문을 **디스크를 건드리지 않고** 에디터에 띄운다 (E3).
 *
 * 임시 파일을 만들면 지울 책임이 생기고, 사용자 워크스페이스에 쓰레기가 남는다.
 * blob에 이미 전문이 있으므로 읽기 전용 가상 문서로 보여주면 된다.
 *
 * URI 모양: `ai-in-one-blob:/<sha256>/<보여줄 파일 이름>`
 * — 뒤에 이름을 붙여야 **에디터 탭 제목과 문법 강조**가 제대로 잡힌다.
 */
export class BlobDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: RoomStore) {}

  static uri(sha256: string | undefined, path: string, label: string): vscode.Uri {
    const name = baseName(path) || "file";
    // 해시가 없으면 (새로 만든 파일의 «이전») 빈 문서가 된다
    return vscode.Uri.from({
      scheme: BLOB_SCHEME,
      path: `/${sha256 ?? "empty"}/${name}`,
      query: label,
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const sha = uri.path.split("/")[1];
    if (!sha || sha === "empty") return "";
    return (await this.store.getBlobText(sha)) ?? "";
  }
}
