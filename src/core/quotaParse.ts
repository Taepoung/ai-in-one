/**
 * **잔량 글에서 수를 뜯는다** (사용자, 2026-10-19).
 *
 * 어댑터는 사람이 읽을 markdown 을 준다(`docs/SLASH.md`). 거기서 **퍼센트와
 * 리셋 시각**만 건지면 막대를 세울 수 있다 — 셋이 공통으로 주는 것이 그 둘뿐이다.
 *
 * 🔴 **뜯은 것이 참을 덮지 않는다.** 모양은 저쪽 판이 바뀌면 같이 바뀌므로,
 * 이 파일은 **언젠가 반드시 틀린다.** 그래서 규칙이 둘이다:
 *
 *   ① 못 뜯으면 **빈 배열**을 준다 — 지어내지 않는다
 *   ② 받은 글은 **언제나 그대로 남는다** — 화면이 접어서 들고 있는다
 *
 * 그러면 틀렸을 때 잃는 것은 «막대가 안 선다» 뿐이고, 사람은 한 번 더 눌러
 * 진짜 글을 본다. 핀을 올릴 때 `tests/probes/quota.mts` 로 다시 보는 자리이고,
 * `docs/PIN.md`·`docs/BUMP.md` 에 그렇게 적어뒀다.
 *
 * 🔴 **셋의 뜻이 같지 않다** (2026-10-19 실측). Claude 는 «얼마나 **썼나**»를,
 * Codex·Antigravity 는 «얼마나 **남았나**»를 준다:
 *
 * ```
 * Claude        **5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9      ← 쓴 양
 * Codex         **codex Weekly limit:** 100% left (resets 16:02 on 11월 18일)  ← 남은 양
 * Antigravity   - **Weekly Limit Remaining:** 100% remaining (resets …)        ← 남은 양
 * ```
 *
 * 그냥 나란히 세우면 **3% 가 거의 다 쓴 것처럼** 보인다 — 정반대다. 그래서
 * 수만 들고 오지 않고 **그 수가 무엇인지**(`sense`)를 같이 들고 온다.
 */

export interface QuotaLine {
  /** 무엇의 한도인가 — «5-hour limit» · «Gemini Models · Weekly Limit Remaining» */
  label: string;
  /** 0~100 */
  percent: number;
  /** 그 수가 **쓴 양**인가 **남은 양**인가 — 어댑터마다 반대다 */
  sense: "used" | "left";
  /** 언제 다시 차나 — **글 그대로** 둔다. 모양이 제각각이라 날짜로 안 바꾼다 */
  resets?: string;
}

/** `**굵게**` 와 군더더기를 걷어 이름만 남긴다 */
function clean(raw: string): string {
  return raw.replace(/\*\*/g, "").replace(/[:\-\s]+$/, "").trim();
}

/**
 * ★ **«남았다» 라고 적힌 것만 남은 양이다.**
 *
 * 🔴 기본값을 «남았다» 로 두면 Claude 의 3% 가 «3% 남음» 이 되어 **멀쩡한
 * 계정이 빨갛게** 보인다. 반대로 틀리면 다 쓴 계정이 괜찮아 보인다 —
 * 둘 다 나쁘지만, 말이 적혀 있을 때만 믿는 쪽이 **지어내지 않는** 쪽이다.
 */
const LEFT = /\b(left|remaining|available)\b|남(음|았)/i;

/** `- **이름**` 한 줄짜리 묶음 머리 — Antigravity 가 모델 묶음을 이렇게 낸다 */
const GROUP = /^\s*[-*]?\s*\*\*([^*]+?)\*\*\s*:?\s*$/;

/** 퍼센트가 든 줄 — 이름과 수와 (있으면) 리셋 시각 */
const LINE =
  /\*\*([^*]+?)\*\*[^\n%]*?(\d+(?:\.\d+)?)\s*%([^\n]*)/
;

/**
 * 받은 글에서 한도 줄들을 뜯는다. **못 뜯으면 빈 배열**이다.
 *
 * ⚠️ 줄 단위로 본다 — 한 줄에 한 한도라는 것은 셋 다 같았다. 아니게 되면
 * 여기가 조용히 비는데, 그때도 받은 글은 화면에 그대로 있다.
 */
export function parseQuota(text: string | undefined): QuotaLine[] {
  if (!text) return [];
  const out: QuotaLine[] = [];
  /** 가장 가까운 묶음 머리 — 안쪽 이름이 «Weekly Limit Remaining» 처럼 밋밋할 때 쓴다 */
  let group = "";
  for (const raw of text.split("\n")) {
    const head = GROUP.exec(raw);
    if (head && !/\d\s*%/.test(raw)) { group = clean(head[1]!); continue; }

    const hit = LINE.exec(raw);
    if (!hit) continue;
    const percent = Number(hit[2]);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;

    const tail = hit[3] ?? "";
    const inner = clean(hit[1]!);
    /*
     * 리셋 시각은 «resets …» 뒤를 통째로 가져온다. 괄호 안이면 괄호까지만 —
     * Codex 가 `(resets 16:02 on 11월 18일)` 꼴로 준다.
     */
    const when = /resets?\s*:?\s*([^)\n]+)/i.exec(tail);
    out.push({
      label: group && group !== inner ? `${group} · ${inner}` : inner,
      percent,
      sense: LEFT.test(tail) || LEFT.test(inner) ? "left" : "used",
      ...(when ? { resets: when[1]!.trim() } : {}),
    });
  }
  return out;
}

/** 막대로 세울 값 — 언제나 «남은 양» 으로 맞춘다 */
export function leftOf(line: QuotaLine): number {
  return line.sense === "left" ? line.percent : 100 - line.percent;
}
