/**
 * ★ **애드온이 기대는 단 하나의 문** (리팩토링 ①, 2026-10-20).
 *
 * `src/agents/*` 는 core 에서 **이 파일만** import 한다(`src/agents/README.md`).
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
  /** 그 글을 읽어낸 시각(ms) — 못 읽었으면 비운다. 화면은 그때 원문을 보인다 */
  resetsAt?: number,
): QuotaLine | undefined {
  if (!label || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  return {
    label, percent, sense,
    left: sense === "left" ? percent : 100 - percent,
    ...(resets ? { resets } : {}),
    ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

// ── 리셋 시각 읽기 부품 (2026-11-18) ────────────────────────────────────────
//
// 사용자: *"사용량에서는 언제 다시 차는지가 아니라 몇시간 후 이렇게는 못보여주려나"*.
// 글의 **모양**은 애드온마다 다르므로 모양을 읽는 정규식은 애드온에 둔다. 여기는
// 모양과 상관없는 부품만 — 달 이름, 시간대, 연도 없는 날짜를 앞날로 맞추기.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 달 이름 → 0~11. `Oct` · `October` · `11월` 셋 다 받는다. 모르면 `undefined` */
export function monthOf(s: string): number | undefined {
  const ko = /^(\d{1,2})월$/.exec(s.trim());
  if (ko) {
    const n = Number(ko[1]) - 1;
    return n >= 0 && n < 12 ? n : undefined;
  }
  const at = MONTHS.indexOf(s.trim().slice(0, 3).toLowerCase());
  return at >= 0 ? at : undefined;
}

/**
 * 그 시각을 ms 로. `offsetMin` 이 없으면 **이 기계의 시간대**로 본다 — 시간대를 안
 * 적는 CLI 는 제 기계 시계로 적고, 그 기계가 곧 여기다.
 */
export function clockAt(
  y: number, mo: number, d: number, h: number, mi: number, offsetMin?: number,
): number {
  return offsetMin === undefined
    ? new Date(y, mo, d, h, mi).getTime()
    : Date.UTC(y, mo, d, h, mi) - offsetMin * 60_000;
}

/**
 * **연도 없는 리셋 시각을 앞날로** 정한다 — 리셋은 언제나 앞에 있다.
 *
 * 올해 그 시각이 **하루 넘게** 지났으면 내년이다(12월에 받은 «Jan 2»). 하루를
 * 봐주는 까닭은 받은 글이 늦게 그려질 수 있어서다 — 방금 지난 시각은 «이미 다시
 * 찼다» 로 읽혀야지 1년 뒤가 되면 안 된다.
 */
export function ahead(at: (year: number) => number, now: number): number {
  const y = new Date(now).getFullYear();
  const t = at(y);
  return t < now - 86_400_000 ? at(y + 1) : t;
}

/**
 * `Oct 19, 7:20 PM GMT+9` · `Oct 26, 2026, 07:02 UTC` — **«달 일[, 연도], 시:분»** 꼴.
 *
 * Claude 와 Antigravity 가 이 꼴이라 여기 하나 둔다. 시간대를 적었으면 그것을
 * (`UTC` 만 있으면 0), 안 적었으면 이 기계의 시간대를 쓴다. 못 읽으면 `undefined` —
 * 화면은 그때 받은 글을 그대로 보인다.
 */
const MONTH_DAY_CLOCK =
  /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(?:(\d{4}),?\s*)?(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(?:(GMT|UTC)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?)?$/i;

export function readMonthDayClock(text: string, now: number): number | undefined {
  const m = MONTH_DAY_CLOCK.exec(text.trim());
  if (!m) return undefined;
  const mo = monthOf(m[1]!);
  if (mo === undefined) return undefined;
  const d = Number(m[2]);
  let h = Number(m[4]);
  const mi = Number(m[5]);
  const ap = m[6]?.toUpperCase();
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ap === "PM" ? 12 : 0);
  }
  if (d < 1 || d > 31 || h > 23 || mi > 59) return undefined;
  const off = m[7]
    ? (m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10] ?? 0)) : 0)
    : undefined;
  const at = (y: number) => clockAt(y, mo, d, h, mi, off);
  return m[3] ? at(Number(m[3])) : ahead(at, now);
}

/** Windows 는 `npx.cmd` 다 — 셋 다 `npx` 로 꾸러미를 띄우므로 같이 쓴다 */
export function npx(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
