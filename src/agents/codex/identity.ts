/**
 * **이 도구 호출이 어느 MCP 서버의 것인가 — Codex** (2026-10-20).
 *
 * Codex 는 도구의 **입력 자체**에 담는다 (2026-10-08 실측):
 *
 * ```
 * rawInput = { server: "ai-in-one", tool: "say", arguments: {…} }
 * ```
 *
 * ⚠️ 셋 중 유일하게 **모델이 써 넣는 자리**를 믿는다 — Codex 에는 다른 자리가
 * 없다. 그래도 위험이 작은 까닭: **Codex 는 MCP 도구를 애초에 안 묻는다**
 * (권한 요청이 안 온다). 그래서 이 판정은 자동 승인보다 **활동 줄에 우리 이름을
 * 다는 데** 쓰인다. 그리고 코어가 한 번 더 본다 — 도구 이름이 우리 셋 중 하나일
 * 때만 «우리 것» 이다.
 */
import { mcpPair, type McpWho, type ToolCallShape } from "../../core/agent-api.js";

export function codexMcpIdentity(tc: ToolCallShape): McpWho | undefined {
  return mcpPair(tc.rawInput);
}
