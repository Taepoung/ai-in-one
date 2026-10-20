/**
 * **잔량 글 뜯기 — 애드온마다 제 글을** (2026-10-20).
 *
 * 🔴 아래 세 덩이는 `tests/probes/quota.mts` 가 2026-10-19 에 **진짜로 받아온 글**을
 * 그대로 붙인 것이다. 지어낸 표본으로 재면 «우리가 상상한 모양» 만 통과한다 —
 * 뜯기는 저쪽 판이 바뀌면 깨지는 자리라, 표본이 진짜여야 깨진 줄 안다.
 *
 * ★ **뜯기는 애드온의 일이다.** 코어는 `QuotaLine` 이라는 꼴만 정하고, 저마다 제
 * 에이전트의 글을 그 꼴로 맞춰 온다. 그래서 여기서도 **한 애드온이 남의 글을 안
 * 뜯는지**를 잰다 — 그래야 한 에이전트의 모양이 바뀌어도 다른 둘이 안 깨진다.
 *
 * ⚠️ 모양이 바뀌면 여기가 빨개진다. 할 일은 `probes/quota.mts` 를 다시 돌려
 * **새 글로 표본을 갈아 끼우고**, 그 에이전트의 `quota.ts` 만 고치는 것이다.
 */
import { DEFAULT_AGENTS, resolveAgents } from "../src/agents/index.js";
import { parseStandardQuota } from "../src/agents/standard/index.js";
import type { QuotaLine } from "../src/core/types.js";

const NL = String.fromCharCode(10);
const ok = (c: boolean, m: string) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ok -", m);
};
const parse = (id: string, text: string): QuotaLine[] =>
  DEFAULT_AGENTS.find((a) => a.id === id)!.quota!.parse(text);
const commands = (id: string) => DEFAULT_AGENTS.find((a) => a.id === id)?.quota?.commands;

const CLAUDE = [
  "## Usage", "", "> Claude team subscription usage", "", "### Limits", "",
  "**5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9", "",
  "`█░░░░░░░░░░░░░░░░░░░`", "",
  "**Weekly · all models** — **9%** · Resets Oct 22, 11:00 AM GMT+9", "",
].join(NL);

const CODEX = [
  "**Model:** gpt-5.6-terra[medium]  ",
  "**Directory:** C:\\\\ws  ",
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
  const got = parse("claude", CLAUDE);
  ok(got.length === 2, `★ 두 줄 (${got.length})`);
  ok(got[0]!.label === "5-hour limit" && got[0]!.percent === 3,
     `★ 이름과 수 (${got[0]!.label} · ${got[0]!.percent})`);
  // 🔴 여기가 제일 중요하다 — «3%» 를 남은 양으로 읽으면 멀쩡한 계정이 빨갛게 보인다
  ok(got[0]!.sense === "used" && got[0]!.left === 97, `★ **쓴 양이다** — 97% 남음 (${got[0]!.left}%)`);
  ok((got[0]!.resets ?? "").startsWith("Oct 19"), `★ 리셋 시각 (${got[0]!.resets})`);
  ok(got[1]!.label === "Weekly · all models" && got[1]!.percent === 9, "★ 둘째 줄도");
  ok(!got.some((l) => /█|░/.test(l.label)), "★ **막대 그림은 안 줍는다** — 수가 아니다");
  ok(JSON.stringify(commands("claude")) === '["usage"]', "★ /usage 로 묻는다");
}

console.log(NL + "[★ Codex — 섞인 글에서 한도만]");
{
  const got = parse("codex", CODEX);
  ok(got.length === 1, `★ 한 줄만 (${got.length}) — 모델·폴더·승인 줄은 수가 없다`);
  ok(got[0]!.sense === "left" && got[0]!.left === 100, `★ **남은 양이다** (${got[0]!.left}%)`);
  ok((got[0]!.resets ?? "").includes("11월 18일"), `★ 리셋 (${got[0]!.resets})`);
  ok(JSON.stringify(commands("codex")) === '["status"]', "★ **/status 로 묻는다** — /usage 가 아니다");
}

console.log(NL + "[★ Antigravity — 묶음 이름을 앞에 붙인다]");
{
  const got = parse("antigravity", AGY);
  ok(got.length === 2, `★ 묶음마다 한 줄 (${got.length})`);
  ok(got[0]!.label.startsWith("Gemini Models"), `★ 첫 줄 (${got[0]!.label})`);
  ok(got[1]!.label.startsWith("Claude and GPT models"), `★ 둘째 줄 (${got[1]!.label})`);
  ok(got[0]!.sense === "left" && got[1]!.left === 80, "★ 남은 양 · 둘째는 80%");
  ok(!got.some((l) => /Session total/.test(l.label)), "★ **«data not available yet» 은 안 줍는다**");
}

console.log(NL + "[★ 한 애드온은 남의 글을 안 뜯는다 — 격리]");
{
  /*
   * 🔴 **이게 애드온으로 나눈 까닭이다.** 예전엔 정규식 하나가 셋의 모양을 다
   * 받았다 — Codex 의 모양 때문에 그걸 고치면 다른 둘이 같이 깨질 수 있었다.
   * 이제 저마다 제 모양만 읽으니, 남의 글을 넣으면 **빈손**이어야 한다.
   */
  ok(parse("claude", CODEX).length === 0 && parse("claude", AGY).length === 0,
     "★ Claude 파서는 Codex·Antigravity 글을 안 뜯는다");
  ok(parse("codex", CLAUDE).length === 0 && parse("codex", AGY).length === 0,
     "★ Codex 파서는 남의 글을 안 뜯는다");
  ok(parse("antigravity", CLAUDE).length === 0 && parse("antigravity", CODEX).length === 0,
     "★ Antigravity 파서는 남의 글을 안 뜯는다");
}

console.log(NL + "[★ 못 뜯으면 빈손 — 지어내지 않는다]");
{
  for (const id of ["claude", "codex", "antigravity"]) {
    ok(parse(id, "").length === 0 && parse(id, "무슨 말인지 모르겠는 글").length === 0,
       `★ ${id} — 빈 글 · 모르는 모양은 빈 배열`);
  }
  ok(parse("codex", "**이상함:** 120% left").length === 0, "★ **말이 안 되는 수는 버린다** (0~100)");
}

console.log(NL + "[★ standard — 처음 보는 에이전트는 짐작하는 어댑터가 받는다]");
{
  /*
   * 코어는 짐작하지 않는다. 설정으로 넣은 낯선 에이전트에게는 목록을 세우는
   * 쪽(`resolveAgents`)이 standard 를 **끼워** 준다.
   */
  const list = resolveAgents({ stranger: { label: "낯선", command: "node", args: ["x.js"] } });
  const s = list.find((a) => a.id === "stranger");
  ok(s?.quota?.parse === parseStandardQuota, "★ **설정으로 넣은 에이전트에 standard 가 끼워진다**");
  ok(JSON.stringify(s?.quota?.commands) === '["usage","status"]', "★ 아는 이름 둘을 차례로 묻는다");
  ok(resolveAgents({}).every((a) => a.quota !== undefined), "★ 내장 셋은 제 것을 그대로 들고 있다");

  // 짐작은 글에 «left»·«remaining» 이 적혀 있을 때만 남은 양으로 읽는다
  ok(parseStandardQuota(CODEX)[0]!.left === 100, "★ «left» 가 적혀 있으면 남은 양");
  ok(parseStandardQuota(CLAUDE)[0]!.left === 97, "★ 아무 말 없으면 쓴 양");
  /*
   * ⚠️ **짐작의 한계** — 판에서 «left» 한 마디가 빠지면 «100% 남음» 이 «100% 씀»
   * 으로, 정반대로 읽힌다. 내장 셋이 짐작 대신 제 파서를 쓰는 까닭이다.
   */
  ok(parseStandardQuota("**codex Weekly limit:** 100% (resets 16:02)")[0]!.left === 0,
     "⚠️ 짐작은 말 한 마디가 빠지면 정반대로 틀린다 — 내장 셋이 제 파서를 쓰는 까닭");
  ok(parseStandardQuota("**비용:** 0.29 USD").length === 0, "★ 퍼센트가 아니면 안 줍는다");
}

console.log(NL + "전부 통과");
