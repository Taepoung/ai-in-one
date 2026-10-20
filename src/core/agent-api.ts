/**
 * ★ **애드온이 기대는 단 하나의 문** (리팩토링 ①, 2026-10-20).
 *
 * `src/agents/*` 는 core 에서 **이 파일만** import 한다(`docs/REFACTOR.md` §2).
 * 그래서 core 안쪽을 어떻게 옮기든 애드온은 안 흔들리고, 애드온이 core 의
 * 무엇에 기대는지가 **여기 한 화면**으로 보인다.
 *
 * 지금은 `AgentDef` 하나와 `npx()` 뿐이다. 버릇을 애드온으로 옮기는 걸음마다
 * 칸이 하나씩 는다 — 늘 때도 **선언으로 되는 것은 선언으로** 둔다(§3.1).
 */
export type { AgentDef, QuotaLine, ToolCallShape, McpWho } from "./types.js";
import type { McpWho, QuotaLine } from "./types.js";

/**
 * 객체에서 `server`·`tool` 두 문자열을 꺼낸다 — 하나라도 비면 **안 쓴다**.
 * 신원을 `{server, tool}` 꼴로 담아 보내는 에이전트들이 같이 쓴다.
 */
export function mcpPair(v: unknown): McpWho | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const server = o["server"];
  const tool = o["tool"];
  if (typeof server !== "string" || typeof tool !== "string") return undefined;
  if (!server || !tool) return undefined;
  return { server, tool };
}

/**
 * ★ **잔량 한 줄을 공통 꼴로 만든다** — 애드온의 파서가 이걸로 내놓는다 (2026-10-20).
 *
 * 꼴의 규칙은 **코어가 정한다**: 수는 0~100 이고, `left` 는 언제나 «남은 양» 이다.
 * 애드온이 저마다 `100 - percent` 를 계산하면 언젠가 하나가 틀린다 — 그래서 여기서
 * 한 번만 한다. 말이 안 되는 수면 `undefined` 를 돌려 **안 줍게** 한다.
 */
export function quotaLine(
  label: string,
  percent: number,
  sense: "used" | "left",
  resets?: string,
): QuotaLine | undefined {
  if (!label || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  return {
    label, percent, sense,
    left: sense === "left" ? percent : 100 - percent,
    ...(resets ? { resets } : {}),
  };
}

/** Windows 는 `npx.cmd` 다 — 셋 다 `npx` 로 꾸러미를 띄우므로 같이 쓴다 */
export function npx(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
