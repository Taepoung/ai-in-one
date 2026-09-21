import type {
  PermissionDecision,
  PermissionRequest,
} from "./types.js";

/**
 * core가 셸(에디터)에게 요구하는 능력.
 *
 * ACP의 클라이언트 측 메서드와 1:1로 대응한다. ACP가 파일 읽기/쓰기를
 * 에이전트가 아니라 클라이언트에게 맡긴 이유가 바로 이것 — 에디터의
 * **저장되지 않은 버퍼**를 에이전트에게 보여주기 위해서다. VSCode 구현체는
 * 디스크가 아니라 열려 있는 문서를 우선 읽는다.
 */
export interface WorkspaceHost {
  /** 절대 경로. line/limit이 있으면 해당 구간만 */
  readTextFile(
    path: string,
    opts?: { line?: number; limit?: number },
  ): Promise<string>;

  writeTextFile(path: string, content: string): Promise<void>;

  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;


  /** 진단/로그용. 사용자에게 보이는 채널 */
  log(message: string): void;

  /**
   * 기본 작업 디렉터리.
   *
   * **언제나 값을 준다** — 워크스페이스가 없으면 홈으로 떨어진다. 에이전트를
   * 띄우려면 cwd가 필요하기 때문이다. 그래서 «정한 폴더»인지 «어쩔 수 없는
   * 기본값»인지는 `hasWorkspace()`로 따로 물어야 한다.
   */
  defaultCwd(): string;

  /** 폴더가 실제로 열려 있는가 (B9) */
  hasWorkspace(): boolean;
}
