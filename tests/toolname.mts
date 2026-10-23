/**
 * **알약에 쓸 도구 이름 — Claude** (사용자, 2026-10-23: *"search로만 나와야하는데 길게 나옴"*).
 *
 * 어댑터 0.90 은 `title` 에 미리보기(명령 전체, `Search "…"`)를 싣고 이름은 따로 준다 —
 * 첫 이벤트는 `name`, 갱신은 `_meta.claudeCode.toolName`. 둘 다에서 꺼내는지 잰다.
 */
import { claudeToolName } from "../src/agents/claude/identity.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

console.log("\n[★ Claude 도구 이름]");
ok(claudeToolName({ _meta: { claudeCode: { toolName: "WebSearch" } } }) === "WebSearch", "★ _meta 에서");
ok(claudeToolName({ name: "Bash" }) === "Bash", "★ name 에서");
ok(claudeToolName({ name: "mcp__github__create_issue" }) === "create_issue", "★ 남의 MCP 도구는 도구 이름만");
ok(claudeToolName({ _meta: { claudeCode: "이상한 값" } }) === undefined, "모양이 다르면 모른다");
ok(claudeToolName({}) === undefined, "없으면 모른다");
ok(DEFAULT_AGENTS.find((a) => a.id === "claude")?.toolName === claudeToolName, "★ Claude 애드온에 꽂혀 있다");
console.log("\n전부 통과");
