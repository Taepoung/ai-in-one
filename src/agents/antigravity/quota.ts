/**
 * **Antigravity 의 `/usage` 를 뜯는다** — 이 애드온만의 일이다 (2026-10-20).
 *
 * 한도가 **모델 묶음마다** 따로 온다 (2026-10-19 실측):
 *
 * ```
 * ### Quota Limits
 * - **Gemini Models**
 *   *(Models within this group: Gemini Flash, Gemini Pro)*
 *   - **Weekly Limit Remaining:** 100% remaining (resets Oct 26, 2026, 07:02 UTC)
 * - **Claude and GPT models**
 *   - **Weekly Limit Remaining:** 100% remaining (resets Oct 26, 2026, 07:02 UTC)
 * ```
 *
 * ★ 안쪽 이름은 둘 다 «Weekly Limit Remaining» 이라 **그것만으로는 안 갈린다** —
 * 바로 위 묶음 머리를 앞에 붙인다. 수는 **«남은 양»** 이다.
 */
import { quotaLine, readMonthDayClock, type QuotaLine } from "../../core/agent-api.js";

/** `- **이름**` 한 줄짜리 — 수가 없는 묶음 머리 */
const GROUP = /^-\s*\*\*(.+?)\*\*\s*$/;
const LINE = /^-\s*\*\*(.+?):\*\*\s*(\d+(?:\.\d+)?)%\s*remaining\b(?:\s*\(resets\s+([^)]+)\))?/i;

export function parseAntigravityQuota(text: string, now = Date.now()): QuotaLine[] {
  const out: QuotaLine[] = [];
  let group = "";
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    const head = GROUP.exec(t);
    if (head) { group = head[1]!.trim(); continue; }
    const m = LINE.exec(t);
    if (!m) continue;
    const inner = m[1]!.trim();
    const resets = m[3]?.trim();
    // `Oct 26, 2026, 07:02 UTC` — 연도와 시간대가 다 있다
    const at = resets ? readMonthDayClock(resets, now) : undefined;
    const line = quotaLine(group ? `${group} · ${inner}` : inner, Number(m[2]), "left", resets, at);
    if (line) out.push(line);
  }
  return out;
}
