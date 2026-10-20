/**
 * **Claude 의 `/usage` 를 뜯는다** — 이 애드온만의 일이다 (2026-10-20).
 *
 * 받는 글 (2026-10-19 실측):
 *
 * ```
 * **5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9
 * `█░░░░░░░░░░░░░░░░░░░`
 * **Weekly · all models** — **9%** · Resets Oct 22, 11:00 AM GMT+9
 * ```
 *
 * 🔴 **수는 «쓴 양» 이다.** 다른 둘과 뜻이 반대라, 남은 양으로 읽으면 멀쩡한
 * 계정이 «3% 남음» 으로 빨갛게 보인다.
 *
 * ★ **이 모양만 읽는다.** 다른 에이전트의 글이 와도 안 뜯는다 — 저쪽이 모양을
 * 바꿔도 여기만 고치면 되고, 여기를 고쳐도 다른 애드온이 안 깨진다. 그게
 * 애드온으로 나눈 까닭이다(`docs/REFACTOR.md`).
 */
import { quotaLine, type QuotaLine } from "../../core/agent-api.js";

const LINE = /^\*\*(.+?)\*\*\s*—\s*\*\*(\d+(?:\.\d+)?)%\*\*(?:\s*·\s*Resets\s+(.+?))?\s*$/;

export function parseClaudeQuota(text: string): QuotaLine[] {
  const out: QuotaLine[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const line = quotaLine(m[1]!.trim(), Number(m[2]), "used", m[3]?.trim());
    if (line) out.push(line);
  }
  return out;
}
