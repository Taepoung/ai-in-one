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
import { quotaLine, type QuotaLine } from "../../core/agent-api.js";

const LINE = /^\*\*(.+?):\*\*\s*(\d+(?:\.\d+)?)%\s*left\b(?:\s*\(resets\s+([^)]+)\))?/i;

export function parseCodexQuota(text: string): QuotaLine[] {
  const out: QuotaLine[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const line = quotaLine(m[1]!.trim(), Number(m[2]), "left", m[3]?.trim());
    if (line) out.push(line);
  }
  return out;
}
