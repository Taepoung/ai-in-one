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
export type { AgentDef } from "./types.js";

/** Windows 는 `npx.cmd` 다 — 셋 다 `npx` 로 꾸러미를 띄우므로 같이 쓴다 */
export function npx(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
