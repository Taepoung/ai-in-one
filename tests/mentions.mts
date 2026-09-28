/**
 * **멘션 파싱** (§4.1.2) — v2.0의 첫 조각.
 *
 * 화면이 칩이 되든 텍스트가 되든(한글 IME 검증에 달렸다) 규칙은 여기 하나뿐이다.
 * 그래서 화면 없이도 전부 잴 수 있다.
 *
 * 제일 중요한 것은 **조용히 버리지 않는 것**이다. 코딩 에이전트는 파일을 고치므로
 * 오발송 비용이 크고, 반대로 «보냈는데 아무도 안 받았다»도 똑같이 나쁘다.
 */
import {
  parseCompose, composeText, EVERYONE,
  type ComposeToken,
} from "../src/core/mentions.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);

const BOTS = [
  { id: "b1", name: "Claude" },
  { id: "b2", name: "Codex" },
  { id: "b3", name: "Claude 리뷰어" },
];

const at = (botId: string): ComposeToken => ({ kind: "mention", botId });
const txt = (text: string): ComposeToken => ({ kind: "text", text });
const shape = (r: ReturnType<typeof parseCompose>) =>
  r.blocks.map((b) => `${b.botIds.join("+")}: ${b.text}`).join(" | ");

console.log(`${NL}[한 그룹 — 기본]`);
{
  const r = parseCompose([at("b1"), txt(" 이 파일 고쳐줘")], BOTS);
  ok(r.blocked === undefined, "막지 않는다");
  ok(shape(r) === "b1: 이 파일 고쳐줘", `★ 지목 뒤의 글이 그 봇에게 (${shape(r)})`);
  ok(r.warnings.length === 0, "할 말 없음");
}

console.log(`${NL}[연속 칩 = 한 그룹]`);
{
  const r = parseCompose([at("b1"), txt(" "), at("b2"), txt(NL + "리뷰해줘")], BOTS);
  ok(shape(r) === "b1+b2: 리뷰해줘",
     `★ 사이에 공백·줄바꿈만 있으면 **아직 한 그룹**이다 (${shape(r)})`);
}

console.log(`${NL}[그룹이 둘]`);
{
  const r = parseCompose(
    [at("b1"), at("b2"), txt(NL + "리뷰해줘" + NL + NL), at("b3"), txt(NL + "문서도")],
    BOTS,
  );
  ok(shape(r) === "b1+b2: 리뷰해줘 | b3: 문서도",
     `★ 다음 그룹 직전까지가 앞 그룹의 지시다 (${shape(r)})`);
}

console.log(`${NL}[★ 한 번에 네 갈래로 — 기준이 되는 경우]`);
{
  /*
   * 사용자가 실제로 쓰고 싶어 한 모양이다. 한 메시지 안에서 **일을 나눠 주고
   * 마지막에 모으는** 것 — 이게 갈리지 않으면 단체방의 요점이 없다.
   */
  const r = parseCompose([
    at("b1"), txt(" 너는 task1해 "),
    at("b2"), txt(" 너는 task2해 "),
    at("b1"), txt(" "), at("b2"), txt(" 모두 하고 b3에게 검토 받아" + NL),
    at("b3"), txt(" 너는 보고 받아서 정리를 md파일에 해"),
  ], BOTS);

  ok(r.blocks.length === 4, `★ **네 갈래** (${r.blocks.length})`);
  ok(shape(r) ===
     "b1: 너는 task1해 | b2: 너는 task2해 | " +
     "b1+b2: 모두 하고 b3에게 검토 받아 | b3: 너는 보고 받아서 정리를 md파일에 해",
     `★ 갈래마다 **누구에게 무엇이** 맞다 (${shape(r)})`);
  ok(r.blocks[2]!.botIds.join() === "b1,b2",
     "★ **붙여 쓴 둘은 한 갈래** — «둘에게 같은 말»이라는 뜻이다");
}

console.log(`${NL}[★ 지목 없이 보내면 전원 — 말풍선에도 그렇게 뜬다]`);
{
  const r = parseCompose([txt("다들 이것 좀 봐줘")], BOTS);
  ok(r.blocks.length === 1 && r.blocks[0]!.botIds.length === 3,
     "★ 전원에게 간다");
  /*
   * 저장은 «전원 id 목록»이라 `@everyone` 으로 쓴 것과 구분되지 않는다 —
   * 그래서 화면이 **`@everyone` 한 장으로 접어** 보여준다(`delivery.mjs`).
   * 지목을 안 했어도 **어디로 갔는지가 말풍선에 남는다.**
   */
  ok(r.blocks[0]!.mentionAt.length === 0,
     "★ 연 칩이 없다 — 화면이 «전원»으로 칠할 근거가 여기 있다");
}

console.log(`${NL}[★ ⏪ 문장 중간 칩도 블록을 연다 (2026-09-23 정정)]`);
{
  /*
   * 🔴 예전 규칙은 *"줄 맨 앞 칩만 라우팅"* 이었다. 근거는 «지나가는 말에 일을
   * 시키면 안 된다»였는데 — **칩은 자동완성에서 일부러 고른 것**이다. 참조하려고
   * 목록을 열어 고르는 사람은 없다. 참조는 **글자로** 치면 되고, 글자로 쓴
   * `@Codex` 는 칩이 아니라 **절대 라우팅되지 않는다.**
   *
   * 반대로 옛 규칙은 `@구현 이거 @리뷰어 저거` 를 **통째로 구현에게** 보냈다 —
   * 리뷰어는 자기 몫이 있는 줄도 몰랐다. **지목한 대로 안 가는 것**이 더 나쁘다.
   */
  const r = parseCompose(
    [at("b1"), txt(" 이거 "), at("b2"), txt(" 저거")],
    BOTS,
  );
  ok(shape(r) === "b1: 이거 | b2: 저거",
     `★ **칩마다 블록** (${shape(r)}) — 한 줄에 섞어 써도 갈린다`);
}

console.log(`${NL}[★ 참조는 «글자로» 하면 된다 — 길이 막힌 게 아니다]`);
{
  const r = parseCompose(
    [at("b1"), txt(" 아까 @Codex가 말한 대로 고쳐줘")],
    BOTS,
  );
  ok(r.blocks.length === 1 && r.blocks[0]!.botIds.join() === "b1",
     "★ **글자 @Codex 는 라우팅이 아니다** — 칩만 라우팅이다");
  ok(r.blocks[0]!.text.includes("@Codex"),
     `★ 글자는 그대로 남는다 — 읽는 쪽이 누구 얘긴지 안다 (${r.blocks[0]!.text})`);
}

console.log(`${NL}[★ 맨 앞에 지목이 없으면 전원에게]`);
{
  const r = parseCompose([txt("이거 고쳐줘")], BOTS);
  ok(r.blocked === undefined, "★ 막지 않는다 — 단체방에서 제일 흔한 것이 «다들 봐줘»다");
  ok(shape(r) === "b1+b2+b3: 이거 고쳐줘",
     `★ 참여 봇 전원이 받는다 (${shape(r)})`);
}

console.log(`${NL}[★ 첫 지목 앞의 글도 전원에게 — 버리지 않는다]`);
{
  const r = parseCompose(
    [txt("다들 보고" + NL + NL), at("b1"), txt(NL + "너는 고쳐줘")],
    BOTS,
  );
  ok(shape(r) === "b1+b2+b3: 다들 보고 | b1: 너는 고쳐줘",
     `★ 앞에 쓴 것은 전원에게, 지목한 뒤는 그 봇에게 (${shape(r)})`);
  ok(r.blocks[0].botIds.length === 3, "첫 블록이 먼저 온다 — 쓴 순서대로");
}

console.log(`${NL}[보낼 게 아예 없으면 막는다]`);
{
  const r = parseCompose([txt("   ")], BOTS);
  ok(r.blocked !== undefined, `★ 빈 메시지는 안 보낸다 (${r.blocked})`);
}

console.log(`${NL}[내용 없는 그룹은 건너뛰되 말해준다]`);
{
  const r = parseCompose([at("b1"), txt(NL), at("b2"), txt(NL + "너만 해줘")], BOTS);
  ok(shape(r) === "b1+b2: 너만 해줘",
     `★ 사이가 줄바꿈뿐이면 연속이라 한 그룹이다 (${shape(r)})`);

  const r2 = parseCompose([at("b1"), txt(NL + "해줘" + NL + NL), at("b2"), txt(NL)], BOTS);
  ok(shape(r2) === "b1: 해줘", "★ 뒤가 빈 그룹은 빠진다");
  ok(r2.warnings.some((w) => w.includes("Codex")),
     `★ **빠졌다고 말한다** — 안 그러면 «보냈는데 왜 조용하지»가 된다 (${r2.warnings[0]})`);
}

console.log(`${NL}[@everyone]`);
{
  const r = parseCompose([at(EVERYONE), txt(" 다들 봐줘")], BOTS);
  ok(shape(r) === "b1+b2+b3: 다들 봐줘", `★ 참여 봇 전원 (${shape(r)})`);

  const empty = parseCompose([at(EVERYONE), txt(" 아무도 없다")], []);
  ok(empty.blocked !== undefined && empty.warnings.length > 0,
     "★ 방에 봇이 없으면 가리킬 대상이 없다고 말한다");
}

console.log(`${NL}[같은 봇이 두 그룹에 나오면 두 번 보낸다]`);
{
  const r = parseCompose(
    [at("b1"), txt(NL + "먼저 이것" + NL + NL), at("b1"), txt(NL + "그다음 저것")],
    BOTS,
  );
  ok(shape(r) === "b1: 먼저 이것 | b1: 그다음 저것",
     `★ 순서대로 두 번 — 합치면 «먼저/그다음»이 무너진다 (${shape(r)})`);
}

console.log(`${NL}[한 그룹 안의 중복은 한 번만]`);
{
  const r = parseCompose([at("b1"), txt(" "), at("b1"), txt(NL + "해줘")], BOTS);
  ok(shape(r) === "b1: 해줘", `★ 같은 봇에게 같은 말을 두 번 보낼 이유가 없다 (${shape(r)})`);
}

console.log(`${NL}[★ 나간 봇의 칩 — 나머지는 보내고 못 보낸 것을 짚는다]`);
{
  // 그 글만 있으면 보낼 곳이 없다 — 밀어붙이지 않고 말한다
  const alone = parseCompose([at("없는봇"), txt(NL + "해줘")], BOTS);
  ok(alone.blocked !== undefined,
     "★ 보낼 곳이 없으면 막는다 — 전원으로 넓히지 않는다");
  ok(alone.blocked!.includes("해줘"),
     `★ **못 보난 글자를 짚어준다** — 다시 쓸 수 있게 (${alone.blocked})`);

  // 멀줦한 블록이 있으면 **그건 보낸다**
  const mixed = parseCompose(
    [at("없는봇"), txt(NL + "이건 못 간다" + NL + NL), at("b1"), txt(NL + "이건 간다")],
    BOTS,
  );
  ok(mixed.blocked === undefined,
     "★ 하나 때문에 전부 막지 않는다");
  ok(shape(mixed) === "b1: 이건 간다",
     `★ 멀줦한 블록은 그대로 간다 (${shape(mixed)})`);
  ok(mixed.warnings.some((w) => w.includes("이건 못 간다") && w.includes("나머지는 보냈")),
     `★ **뭐가 안 갔고 뭐가 갔는지** 둘 다 말한다 (${mixed.warnings.join(" | ")})`);

  const both = parseCompose([at("없는봇"), txt(" "), at("b1"), txt(NL + "해줘")], BOTS);
  ok(shape(both) === "b1: 해줘",
     `★ 같은 그룹에서는 남은 봇에게 간다 (${shape(both)})`);
  ok(both.warnings.length > 0, "그래도 말은 해준다");
}

console.log(`${NL}[원문을 다시 펼 수 있다]`);
{
  const tokens = [at("b1"), txt(" "), at(EVERYONE), txt(NL + "해줘")];
  ok(composeText(tokens, BOTS) === `@Claude @everyone${NL}해줘`,
     `★ 저장은 쪼개도 «내가 뭐라고 썼더라»에 답할 수 있어야 한다 (${JSON.stringify(composeText(tokens, BOTS))})`);
}

console.log(`${NL}전부 통과`);
