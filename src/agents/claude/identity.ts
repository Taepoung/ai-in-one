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

/**
 * **도구 이름 — Claude** (사용자, 2026-10-23: *"search로만 나와야하는데 길게 나옴"*).
 *
 * 어댑터 0.90 은 `title` 에 미리보기(명령 전체, `Search "…"`)를 싣고 이름은 따로 준다 —
 * 첫 이벤트는 `name`, 갱신은 `_meta.claudeCode.toolName`. 남의 MCP 도구
 * (`mcp__서버__도구`) 는 도구 이름만 — 서버 이름은 알약에서 군더더기다.
 */
export function claudeToolName(tc: ToolCallShape): string | undefined {
  const meta = tc._meta?.["claudeCode"];
  const fromMeta = meta && typeof meta === "object" ? (meta as { toolName?: unknown }).toolName : undefined;
  const name = typeof fromMeta === "string" ? fromMeta : typeof tc.name === "string" ? tc.name : "";
  if (!name) return undefined;
  const mcp = claudeMcpIdentity({ name });
  /*
   * ★ **Chrome 도구는 «Chrome» 을 앞에 붙인다** (2026-11-19). 서버 이름을 떼면
   * `navigate`·`computer`·`find` 만 남는데, 그래서는 **사용자의 브라우저를 만졌다**
   * 는 것이 안 보인다. 꼬리의 `_mcp` 는 군더더기라 뗀다(`tabs_create_mcp`).
   */
  if (mcp?.server === "claude-in-chrome") return `Chrome ${mcp.tool.replace(/_mcp$/, "")}`;
  return mcp?.tool ?? name;
}
