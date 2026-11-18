/**
 * **Codex 의 `/status` 를 뜯는다** — 이 애드온만의 일이다 (2026-10-20).
 *
 * `/usage` 가 아니라 `/status` 다. 한도는 모델 · 폴더 · 승인 모드 · 세션 줄과
 * **섞여** 온다 (2026-10-19 실측):
 *
 * ```
 * **Model:** gpt-5.6-terra[medium]
 * **Token usage:** data not available yet
 * **codex Weekly limit:** 100% left (resets 16:02 on 11월 18일)     ← 무료는 이 한 줄
 * ```
 *
 * 유료 계정은 줄이 늘어난다 (2026-10-20 실측):
 *
 * ```
 * **codex 5h limit:** 100% left (resets 03:23 on 10월 21일)
 * **codex Weekly limit:** 100% left (resets 22:23 on 10월 27일)
 * **codex Credits:** 0
 * ```
 *
 * ★ 수는 **«남은 양»**(`left`)이다. 한도 줄만 집는다 — 수가 없는 줄
 * («data not available yet»)은 안 줍는다. **계정 종류는 안 본다** — 줄 모양만 보므로
 * 한도가 늘거나 줄어도 그대로 따라간다. 크레딧은 퍼센트가 아니라 막대가 안 된다
 * (받은 글에는 그대로 남는다).
 */
import { ahead, clockAt, monthOf, quotaLine, type QuotaLine } from "../../core/agent-api.js";

const LINE = /^\*\*(.+?):\*\*\s*(\d+(?:\.\d+)?)%\s*left\b(?:\s*\(resets\s+([^)]+)\))?/i;

/**
 * `16:02 on 11월 18일` — **시:분 on 날짜** 꼴 (2026-11-18).
 *
 * 날짜 쪽은 기계의 말에 따라 `11월 18일` · `18 Nov` · `Nov 18` 로 갈린다 — 셋 다
 * 받는다. 시간대를 안 적는다: Codex 는 **제 기계 시계로** 적고 그 기계가 곧 여기다.
 * 날짜가 아예 없으면(`16:02`) 다음에 오는 그 시각이다.
 */
const CLOCK = /^(\d{1,2}):(\d{2})(?:\s+on\s+(.+))?$/i;

export function codexResetAt(text: string, now: number): number | undefined {
  const m = CLOCK.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return undefined;
  const date = m[3]?.trim();
  if (!date) {
    const d = new Date(now);
    const today = clockAt(d.getFullYear(), d.getMonth(), d.getDate(), h, mi);
    return today >= now ? today : today + 86_400_000;
  }
  const md =
    /^(\d{1,2}월)\s*(\d{1,2})일$/.exec(date) ??          // 11월 18일
    /^([A-Za-z]+)\.?\s+(\d{1,2})$/.exec(date);            // Nov 18
  const dm = md ? undefined : /^(\d{1,2})\s+([A-Za-z]+)\.?$/.exec(date);  // 18 Nov
  const monthName = md ? md[1]! : dm?.[2];
  const day = Number(md ? md[2] : dm?.[1]);
  const mo = monthName ? monthOf(monthName) : undefined;
  if (mo === undefined || !(day >= 1 && day <= 31)) return undefined;
  return ahead((y) => clockAt(y, mo, day, h, mi), now);
}

export function parseCodexQuota(text: string, now = Date.now()): QuotaLine[] {
  const out: QuotaLine[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const resets = m[3]?.trim();
    const at = resets ? codexResetAt(resets, now) : undefined;
    const line = quotaLine(m[1]!.trim(), Number(m[2]), "left", resets, at);
    if (line) out.push(line);
  }
  return out;
}
