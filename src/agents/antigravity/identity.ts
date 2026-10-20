/**
 * **이 도구 호출이 어느 MCP 서버의 것인가 — Antigravity** (2026-10-20).
 *
 * Antigravity 는 `_meta.mcp` 에 따로 담는다 (2026-10-08 실측 · PIN §G7):
 *
 * ```
 * _meta.mcp = { server: "ai-in-one", tool: "say" }
 * name      = null                     ← 이름은 비어 온다
 * ```
 *
 * 🔴 **`_meta` 만 본다.** `rawInput` 은 모델이 써 넣는 자리라 믿지 않는다.
 */
import { mcpPair, type McpWho, type ToolCallShape } from "../../core/agent-api.js";

export function antigravityMcpIdentity(tc: ToolCallShape): McpWho | undefined {
  return mcpPair(tc._meta?.["mcp"]);
}
