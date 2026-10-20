/**
 * **이 도구 호출이 어느 MCP 서버의 것인가 — Claude** (2026-10-20).
 *
 * Claude 는 **도구 이름 하나에** 서버와 도구를 담는다 (2026-10-08 실측):
 *
 * ```
 * name = "mcp__ai-in-one__say"
 * ```
 *
 * 🔴 **이름만 본다.** `rawInput` 은 모델이 써 넣는 도구 인자라, 거기에
 * `{server:"ai-in-one"}` 가 실려 와도 믿지 않는다 — 그 판정이 자동 승인을
 * 정하므로, 제 자리가 아닌 데서 꺼내면 남의 도구가 지나갈 길이 열린다.
 *
 * 서버 이름에 `__` 가 들어가면 못 가르므로 **처음 둘만** 쪼갠다 — 도구 이름에
 * `__` 가 있어도 안 잘린다.
 */
import type { McpWho, ToolCallShape } from "../../core/agent-api.js";

export function claudeMcpIdentity(tc: ToolCallShape): McpWho | undefined {
  const name = typeof tc.name === "string" ? tc.name : "";
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const at = rest.indexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return undefined;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}
