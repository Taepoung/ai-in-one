/**
 * **잔량 글 뜯기** — 2026-10-19 에 **진짜로 받아온 글**로 잰다.
 *
 * 🔴 아래 세 덩이는 `tests/probes/quota.mts` 가 받아온 것을 그대로 붙인
 * 것이다. 지어낸 표본으로 재면 «우리가 상상한 모양» 만 통과한다 — 뜯기는
 * 저쪽 판이 바뀌면 깨지는 자리라, 표본이 진짜여야 깨진 줄 안다.
 *
 * ⚠️ 모양이 바뀌면 여기가 빨개진다. 그때 할 일은 `probes/quota.mts` 를 다시
 * 돌려 **새 글로 표본을 갈아 끼우는 것**이다 (`docs/PIN.md` · `docs/BUMP.md`).
 */
import { parseQuota, leftOf } from "../src/core/quotaParse.js";

const NL = String.fromCharCode(10);
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ok -", m);
};

const CLAUDE = [
  "## Usage", "", "> Claude team subscription usage", "", "### Limits", "",
  "**5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9", "",
  "`█░░░░░░░░░░░░░░░░░░░`", "",
  "**Weekly · all models** — **9%** · Resets Oct 22, 11:00 AM GMT+9", "",
].join(NL);

const CODEX = [
  "**Model:** gpt-5.6-terra[medium]  ",
  "**Directory:** C:\\ws  ",
  "**Approval:** on-request  ",
  "**Token usage:** data not available yet  ",
  "**codex Weekly limit:** 100% left (resets 16:02 on 11월 18일)",
].join(NL);

const AGY = [
  "### Session Usage", "- **Session total:** data not available yet", "",
  "### Quota Limits", "- **Gemini Models**",
  "  *(Models within this group: Gemini Flash, Gemini Pro)*",
  "  - **Weekly Limit Remaining:** 100% remaining (resets Oct 26, 2026, 07:02 UTC)",
  "- **Claude and GPT models**",
  "  - **Weekly Limit Remaining:** 80% remaining (resets Oct 26, 2026, 07:02 UTC)",
].join(NL);

console.log(NL + "[★ Claude — 두 한도, 그리고 그 수는 «쓴 양» 이다]");
{
  const got = parseQuota(CLAUDE);
  ok(got.length === 2, `★ 두 줄 (${got.length})`);
  ok(got[0]!.label === "5-hour limit" && got[0]!.percent === 3,
     `★ 이름과 수 (${got[0]!.label} · ${got[0]!.percent})`);
  /*
   * 🔴 **여기가 제일 중요하다.** «3%» 를 남은 양으로 읽으면 멀쩡한 계정이
   * 빨갛게 보인다 — 다른 둘과 **뜻이 반대**다.
   */
  ok(got[0]!.sense === "used", "★ **쓴 양이다** — «left»·«remaining» 이 안 적혀 있다");
  ok(leftOf(got[0]!) === 97, `★ 막대는 남은 쪽으로 맞춘다 (${leftOf(got[0]!)}%)`);
  ok((got[0]!.resets ?? "").startsWith("Oct 19"), `★ 리셋 시각 (${got[0]!.resets})`);
  ok(got[1]!.label === "Weekly · all models" && got[1]!.percent === 9, "★ 둘째 줄도");
  ok(!got.some((l) => /█|░/.test(l.label)), "★ **막대 그림은 안 줍는다** — 수가 아니다");
}

console.log(NL + "[★ Codex — 섞인 글에서 한도만]");
{
  const got = parseQuota(CODEX);
  ok(got.length === 1, `★ 한 줄만 (${got.length}) — 모델·폴더·승인 줄은 수가 없다`);
  ok(got[0]!.percent === 100 && got[0]!.sense === "left",
     `★ **남은 양이다** — «left» 가 적혀 있다 (${got[0]!.percent}% ${got[0]!.sense})`);
  ok(leftOf(got[0]!) === 100, "★ 그대로 100% 남음");
  ok((got[0]!.resets ?? "").includes("11월 18일"), `★ 리셋 (${got[0]!.resets})`);
}

console.log(NL + "[★ Antigravity — 묶음 이름을 앞에 붙인다]");
{
  const got = parseQuota(AGY);
  ok(got.length === 2, `★ 묶음마다 한 줄 (${got.length})`);
  /*
   * 안쪽 이름은 둘 다 «Weekly Limit Remaining» 이라 **그것만으로는 안 갈린다.**
   * 바로 위의 묶음 머리를 앞에 붙여야 어느 모델 몫인지 읽힌다.
   */
  ok(got[0]!.label.startsWith("Gemini Models"), `★ 첫 줄 (${got[0]!.label})`);
  ok(got[1]!.label.startsWith("Claude and GPT models"), `★ 둘째 줄 (${got[1]!.label})`);
  ok(got[0]!.sense === "left" && got[1]!.percent === 80, "★ 남은 양 · 둘째는 80%");
  ok(!got.some((l) => /Session total/.test(l.label)),
     "★ **«data not available yet» 은 안 줍는다** — 수가 없다");
}

console.log(NL + "[★ 못 뜯으면 빈손 — 지어내지 않는다]");
{
  ok(parseQuota(undefined).length === 0, "★ 글이 없으면 빈 배열");
  ok(parseQuota("").length === 0, "★ 빈 글도");
  ok(parseQuota("무슨 말인지 모르겠는 글").length === 0, "★ 모르는 모양도");
  ok(parseQuota("**이상함:** 120% left").length === 0, "★ **말이 안 되는 수는 버린다** (0~100)");
  ok(parseQuota("**비용:** 0.29 USD").length === 0, "★ 퍼센트가 아니면 안 줍는다");
}

console.log(NL + "전부 통과");
