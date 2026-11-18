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

/**
 * ★ **유료 계정**의 `/status` (2026-10-20 실측 · codex-acp 2.2.2).
 *
 * 무료는 주간 한도 한 줄이었는데, 유료는 **5시간 한도가 더 붙고 크레딧 줄**이 생긴다.
 * 파서는 계정 종류를 모른다 — «`**이름:** N% left`» 꼴이면 무엇이든 한 줄로 뜯는다.
 */
const CODEX_PAID = [
  "**Model:** gpt-5.6-terra[medium]  ",
  "**Approval:** on-request  ",
  "**Sandbox:** workspace-write  ",
  "  ",
  "**Token usage:** data not available yet  ",
  "**Context window:** data not available yet  ",
  "**codex 5h limit:** 100% left (resets 03:23 on 10월 21일)  ",
  "**codex Weekly limit:** 100% left (resets 22:23 on 10월 27일)  ",
  "**codex Credits:** 0",
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

console.log(NL + "[★ Codex 유료 — 5시간 · 주간 둘, 크레딧은 막대가 아니다]");
{
  const got = parse("codex", CODEX_PAID);
  ok(got.length === 2, `★ 두 줄 (${got.length}) — 계정이 바뀌어도 파서는 그대로다`);
  ok(got[0]!.label === "codex 5h limit" && got[0]!.left === 100 && (got[0]!.resets ?? "").includes("10월 21일"),
     `★ 5시간 한도 (${got[0]!.label} · ${got[0]!.left}% · ${got[0]!.resets})`);
  ok(got[1]!.label === "codex Weekly limit" && (got[1]!.resets ?? "").includes("10월 27일"),
     `★ 주간 한도 (${got[1]!.label} · ${got[1]!.resets})`);
  // 🔴 크레딧은 퍼센트가 아니다 — 막대로 세우면 «0%» 로 읽힌다. 받은 글에는 그대로 있다
  ok(!got.some((l) => /credit/i.test(l.label)), "★ **크레딧 줄은 막대로 안 뜯는다**");
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

console.log(NL + "[★ 리셋 글을 시각으로 읽는다 — 화면이 «몇 시간 뒤» 를 센다 (2026-11-18)]");
{
  /*
   * 사용자: *"사용량에서는 언제 다시 차는지가 아니라 몇시간 후 이렇게는 못보여주려나"*.
   * 셋의 모양이 다 다르다 — 위의 **진짜 표본**을 그대로 읽힌다. `now` 를 박아 둬야
   * 연도 없는 날짜(Claude · Codex)를 어느 해로 맞추는지까지 잴 수 있다.
   */
  const pq = (id: string, text: string, now: number): QuotaLine[] =>
    (DEFAULT_AGENTS.find((a) => a.id === id)!.quota!.parse as (t: string, n: number) => QuotaLine[])(text, now);

  // Claude — «Oct 19, 7:20 PM GMT+9» : 연도 없음 · 시간대 있음
  const c = pq("claude", CLAUDE, Date.UTC(2026, 9, 19, 8, 0));
  ok(c[0]!.resetsAt === Date.UTC(2026, 9, 19, 10, 20),
     `★ Claude — GMT+9 의 저녁 7:20 은 UTC 10:20 (${new Date(c[0]!.resetsAt ?? 0).toISOString()})`);
  ok(c[1]!.resetsAt === Date.UTC(2026, 9, 22, 2, 0), "★ Claude 주간 — Oct 22, 11:00 AM GMT+9");
  ok(c[0]!.resets === "Oct 19, 7:20 PM GMT+9", "★ **원문도 그대로** 남는다 — 툴팁과, 못 읽었을 때의 자리");

  // 해를 넘긴다 — 12월 말에 받은 «Jan 2» 는 내년이다
  const wrap = pq("claude", "**Weekly** — **9%** · Resets Jan 2, 9:00 AM GMT+9", Date.UTC(2026, 11, 30));
  ok(wrap[0]!.resetsAt === Date.UTC(2027, 0, 2, 0, 0), "★ **해를 넘긴다** — 12월에 받은 1월 2일은 내년");
  // 방금 지난 것은 내년으로 안 보낸다 — «이미 다시 찼다» 여야 한다
  const just = pq("claude", "**5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9", Date.UTC(2026, 9, 19, 10, 30));
  ok(just[0]!.resetsAt === Date.UTC(2026, 9, 19, 10, 20), "★ 10분 전에 지난 시각은 **그대로** — 1년 뒤가 아니다");

  // Antigravity — «Oct 26, 2026, 07:02 UTC» : 연도 · 시간대 다 있다
  const g = pq("antigravity", AGY, Date.UTC(2026, 9, 19));
  ok(g[0]!.resetsAt === Date.UTC(2026, 9, 26, 7, 2), "★ Antigravity — UTC 그대로");

  // Codex — «16:02 on 11월 18일» : 시간대 없음 → 이 기계 시계
  const nowLocal = new Date(2026, 10, 18, 10, 0).getTime();
  const x = pq("codex", CODEX, nowLocal);
  ok(x[0]!.resetsAt === new Date(2026, 10, 18, 16, 2).getTime(), "★ Codex — «11월 18일» 을 이 기계 시간으로");
  const en = pq("codex", "**codex 5h limit:** 50% left (resets 16:02 on 18 Nov)", nowLocal);
  ok(en[0]!.resetsAt === new Date(2026, 10, 18, 16, 2).getTime(), "★ Codex — 영어 «18 Nov» 도");
  const en2 = pq("codex", "**codex 5h limit:** 50% left (resets 16:02 on Nov 18)", nowLocal);
  ok(en2[0]!.resetsAt === new Date(2026, 10, 18, 16, 2).getTime(), "★ Codex — «Nov 18» 도");
  const bare = pq("codex", "**codex 5h limit:** 50% left (resets 09:00)", nowLocal);
  ok(bare[0]!.resetsAt === new Date(2026, 10, 19, 9, 0).getTime(), "★ Codex — 시각만 있으면 **다음에 오는** 그 시각 (내일 9시)");

  // 모르는 모양은 지어내지 않는다 — 원문만 남는다
  const odd = pq("codex", "**codex 5h limit:** 50% left (resets next Tuesday)", nowLocal);
  ok(odd[0]!.resetsAt === undefined && odd[0]!.resets === "next Tuesday",
     "★ **못 읽으면 시각을 안 지어낸다** — 화면은 원문을 보인다");
  ok(pq("claude", "**x** — **3%** · Resets Oct 19, 25:20 PM GMT+9", nowLocal)[0]!.resetsAt === undefined,
     "★ 말이 안 되는 시각(25시)도 버린다");
}

console.log(NL + "전부 통과");
