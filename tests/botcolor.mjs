/**
 * **봇마다 말풍선 색** (2026-09-28).
 *
 * 🔴 C9 는 «색은 보조 신호로만, 이름 텍스트에 브랜드색을 쓰지 않는다»고 정했고,
 * 그 이유 중 제일 센 것이 **«같은 에이전트의 두 봇은 색이 같다»** 였다 —
 * `@Claude 구현` 과 `@Claude 리뷰어` 는 에이전트 색이 하나뿐이라 색이 구분을
 * 못 해준다. **봇마다 색을 주면 그 이유가 사라진다.**
 *
 * 나머지 둘은 남는다:
 *   ① 라이트 테마 대비  → 색을 **테마 배경과 섞어** 쓴다(`color-mix`)
 *   ② 색각 이상        → **이름은 그대로** 둔다. 색은 더해지는 것이다
 *
 * 그래서 여기서 재는 것은 셋이다:
 *   · 봇 색이 말풍선까지 간다
 *   · 안 고르면 **에이전트 색으로 떨어진다** (오늘과 똑같이 보인다)
 *   · 색이 있어도 **이름이 사라지지 않는다**
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const { JSDOM } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "jsdom", "lib", "api.js")).href
);
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

const SHELL = `<!DOCTYPE html><html><body>
  <div id="app">
    <section class="screen" id="screen-list" data-active>
      <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-new"></button></header>
      <div class="filter"><input type="text" id="filter"><button class="icon" id="only-here" aria-pressed="false"></button></div>
      <div class="rooms" id="rooms"></div>
    </section>
    <section class="screen" id="screen-new"></section>
    <section class="screen" id="screen-chat"></section>
  </div>
  <script type="application/json" id="boot">__BOOT__</script>
</body></html>`;

const AGENTS = [{ id: "claude", label: "Claude", color: "#d97757" }];
const META = { id: "r1", title: "방", kind: "group", cwd: "/ws", agentIds: ["claude"],
               unread: 0, createdAt: 1, lastActivityAt: 2 };

function mount() {
  const sent = [];
  const boot = { rooms: [META], agents: AGENTS, reducedMotion: true, screen: "list",
                 cwd: "/ws", hasWorkspace: true };
  const dom = new JSDOM(SHELL.replace("__BOOT__", JSON.stringify(boot)),
                        { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  w.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.eval(fs.readFileSync(path.join(ROOT, "dist", "webview.js"), "utf8"));
  return {
    w, sent,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    send: (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m })),
  };
}

/** ★ 같은 에이전트 두 봇 — C9 가 걱정하던 바로 그 경우 */
const bot = (id, name, extra = {}) => ({
  id, agentId: "claude", name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask", ...extra,
});
const TWO = [
  bot("b1", "구현", { color: "var(--vscode-terminal-ansiBlue, #2472c8)", ink: "white" }),
  bot("b2", "리뷰어"),   // ★ 색을 안 골랐다
];

const MSGS = [
  { id: "u1", role: "user", text: "봐줘", deliveredTo: ["b1", "b2"], createdAt: 1, placedAt: 1 },
  { id: "a1", role: "agent", text: "고쳤어", authorBotId: "b1",
    deliveredTo: ["b1"], replyToIds: ["u1"], createdAt: 2 },
  { id: "a2", role: "agent", text: "봤어", authorBotId: "b2",
    deliveredTo: ["b2"], replyToIds: ["u1"], createdAt: 3 },
];

function open(t) {
  t.$(".room").click();
  t.send({ t: "room", room: { id: "r1", title: "방", cwd: "/ws", participants: TWO,
                              messages: MSGS, unread: 0, createdAt: 1, lastActivityAt: 2 },
           compactable: false });
}

/** 서랍은 헤더의 «참여자» 로 연다 — 다른 검사와 같은 길 */
const openDrawer = (t) =>
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title ?? ""))?.click();

console.log("\n[★ 고른 색이 말풍선까지 간다]");
{
  const t = mount();
  open(t);
  const [, mine, theirs] = t.$$("#screen-chat .msg");

  console.log(`   구현   : ${mine.getAttribute("style")}`);
  console.log(`   리뷰어 : ${theirs.getAttribute("style")}`);

  ok(mine.style.getPropertyValue("--bot").includes("ansiBlue"),
     "★ **고른 색이 실린다** — 섞는 일은 스타일시트가 한다");

  /*
   * 🔴 처음에는 «안 고르면 에이전트 색»으로 떨어지게 해놓고 «오늘과 똑같이
   * 보인다»고 적었다. **거짓이었다** — 그러면 아무도 안 골랐는데 모든 봇
   * 말풍선이 브랜드색으로 물든다. 게다가 그 색(`#d97757`)은 **우리가 박아넣은
   * 값**이지 테마가 준 것이 아니다.
   *
   * 기본은 **테마 그대로**다. 이 단언이 그걸 지킨다.
   */
  ok(theirs.getAttribute("style") === null,
     `★ **안 고르면 아무것도 안 싣는다** (${theirs.getAttribute("style")}) — 기본은 테마 그대로다`);
  ok(mine.style.getPropertyValue("--bot") !== theirs.style.getPropertyValue("--bot"),
     "★ **같은 에이전트인데 색이 갈린다** — C9 가 «색은 못 믿는다»고 한 이유가 사라졌다");
}

console.log("\n[★ 배경은 «그대로» — 섞지 않는다]");
{
  /*
   * 한때 테마 배경과 22% 섞었다. 그러면 **어떤 색을 골라도 비슷하게 흐려져서**
   * 고른 보람이 없다. 대신 대비를 잡을 길이 필요한데, 그게 글자색이다.
   */
  const t = mount();
  open(t);
  const mine = t.$$("#screen-chat .msg")[1];
  const ink = mine.style.getPropertyValue("--ink");
  console.log(`   --bot: ${mine.style.getPropertyValue("--bot")} · --ink: ${ink}`);
  ok(ink === "#fff", `★ **고른 글자색이 실린다** (${ink})`);
}

console.log("\n[★ 글자색은 검정/하양 둘뿐 — 지금 배경 위에 그려서 보여준다]");
{
  /*
   * «검정/하양»이라고 글로 쓰면 어느 쪽이 읽히는지 눌러봐야 안다. 두 칸을
   * **고른 배경으로 칠해두면** 눈으로 바로 갈린다.
   */
  const t = mount();
  open(t);
  openDrawer(t);
  const inks = t.$$(".drawer-bot .swatches .ink");
  ok(inks.length === 4, `★ 봇마다 둘씩 (${inks.length})`);

  const pair = inks.slice(0, 2);
  ok(pair.map((b) => b.style.color).join() === "rgb(0, 0, 0),rgb(255, 255, 255)",
     `★ 검정과 하양 (${pair.map((b) => b.style.color).join(" / ")})`);
  ok(pair.every((b) => b.style.background.includes("ansiBlue")),
     "★ **둘 다 지금 배경 위에** 그려진다 — 어느 쪽이 읽히는지 보고 고른다");
  ok(pair[1].className.includes("on"),
     "★ 지금 고른 쪽(하양)이 표시돼 있다");

  pair[0].click();
  const posted = t.sent.find((m) => m.t === "setBotColor");
  ok(posted?.ink === "black", `★ 고르면 올라간다 (${posted?.ink})`);
  ok(posted?.color.includes("ansiBlue"),
     "★ **색과 한 쌍으로** 보낸다 — 따로 보내면 한쪽만 바뀐 상태가 생긴다");
}

console.log("\n[★ 이름 앞 «점»은 그대로 — C9 가 허락한 자리다]");
{
  /*
   * 말풍선 배경과 달리 **작은 점**에는 에이전트 색을 써도 된다고 C9 가 정했다.
   * 색을 안 고른 봇도 점은 있어야 «누구»가 한눈에 잡힌다.
   */
  const t = mount();
  open(t);
  const dots = t.$$("#screen-chat .msg.agent .who .dot");
  const bg = dots.map((d) => d.style.background);
  console.log(`   ${bg.join(" / ")}`);
  ok(dots.length === 2, `★ 말풍선마다 점 (${dots.length})`);
  ok(bg[0].includes("ansiBlue"), "★ 고른 봇은 고른 색");
  ok(bg[1] === "rgb(217, 119, 87)" || bg[1].includes("d97757"),
     `★ **안 고른 봇은 에이전트 색으로** (${bg[1]}) — 점은 여전히 떨어진다`);
}

console.log("\n[★ 색이 있어도 이름은 그대로]");
{
  /*
   * 색각 이상과 «같은 색을 둘이 고른 경우»가 남아 있다. 이름이 여전히 1차
   * 신호여야 한다 — 색은 **더해지는 것**이지 대신하는 것이 아니다.
   */
  const t = mount();
  open(t);
  const names = t.$$("#screen-chat .msg.agent .who").map((n) => n.textContent.trim());
  console.log(`   ${names.join(" / ")}`);
  ok(names.some((n) => n.includes("구현")), "★ 이름이 살아 있다 (구현)");
  ok(names.some((n) => n.includes("리뷰어")), "★ 이름이 살아 있다 (리뷰어)");
}

console.log("\n[★ 서랍에서 고르면 올라간다]");
{
  const t = mount();
  open(t);
  openDrawer(t);

  const picks = t.$$(".drawer-bot .swatch");
  ok(picks.length === 2, `★ 봇마다 하나씩 (${picks.length})`);

  /*
   * 🔴 처음엔 `charts.*` 여섯에 `ansiCyan` 을 얹었는데 **파랑 둘이 거의 같아
   * 보였다** — 출처가 다르니 명도·채도가 안 맞았다. 한 계열(`terminal.ansi*`)
   * 에서 **일반/밝은 쌍**으로 고르면 색상뿐 아니라 밝기까지 갈린다.
   */
  const swatches = picks[0].querySelectorAll(".swatches .sw:not(.custom)");
  ok(swatches.length === 12, `★ **열둘** (${swatches.length}) — 여섯은 서로 비슷해 보였다`);
  const sw = swatches[0];
  ok(sw !== null, "★ 프리셋이 있다");
  sw.click();

  const posted = t.sent.find((m) => m.t === "setBotColor");
  ok(posted !== undefined, "★ 고르면 올라간다");
  ok(posted.botId === "b1", `★ 그 봇에게 (${posted?.botId})`);
  /*
   * 🔴 여기 `charts-` 를 박아뒀다가 팔레트를 바꾸자 깨졌다. 재려던 것은
   * «어느 계열인가»가 아니라 **«테마 변수인가»** 다 — 그것만 본다.
   */
  ok(posted.color.startsWith("var(--vscode-"),
     `★ **테마 변수로 저장한다** (${posted?.color}) — 하드코딩하면 라이트에서 안 읽힌다`);
}

console.log("\n[★ 고르개는 «실제로 그려질 것»을 보여준다]");
{
  /*
   * 🔴 폴백이 **에이전트 색**이었다. 아무것도 안 골랐는데 고르개의 점이
   * 브랜드색을 보여줬고, 정작 말풍선은 **테마 기본**이었다 — 고르개는
   * «파랑 골라져 있네»라고 하는데 화면은 회색이다.
   *
   * 고르개는 화면과 **같은 말**을 해야 한다.
   */
  const t = mount();
  open(t);
  openDrawer(t);

  const dots = t.$$(".drawer-bot .swatch > summary .dot").map((d) => d.style.background);
  console.log(`   고른 봇: ${dots[0]} · 안 고른 봇: ${dots[1]}`);

  ok(dots[0].includes("ansiBlue"), "★ 고른 봇은 고른 색");
  ok(dots[1].includes("bubble-bot-bg"),
     `★ **안 고른 봇은 «평소 말풍선»** (${dots[1]}) — 에이전트 색을 보여주면 거짓말이 된다`);
  ok(!dots[1].includes("d97757"), "★ 브랜드색이 안 샌다");
}

console.log("\n[★ 봇 부를 때도 색을 고른다]");
{
  /*
   * 🔴 방 만들기에는 넣고 **여기는 빠뜨렸다.** 그런데 색이 제일 필요한 순간이
   * 바로 여기다 — 같은 에이전트를 하나 더 부를 때. 「Claude」와 「Claude 2」는
   * 이름 말고 갈릴 것이 없다.
   */
  const t = mount();
  open(t);
  openDrawer(t);
  const add = [...t.$$(".drawer button")].find((b) => /봇 추가|부르기/.test(b.textContent));
  ok(add !== undefined, "★ 서랍에 «봇 추가»가 있다");
  add.click();

  const card = t.$("#screen-chat .card");
  ok(card !== null, "★ 부르기 카드가 떴다");
  ok(card.querySelector(".named .swatch") !== null,
     "★ **이름 칸 옆에 색 고르개** — 방 만들기와 같은 자리다");
}

console.log("\n[★ 커스텀은 «확정»을 눌러야 들어간다]");
{
  /*
   * 🔴 `oninput` 으로 바로 넣었더니 **고르는 동안 계속 적용됐다.** 고르개를
   * 끌고 다니는 사이에 말풍선이 수십 번 바뀌고, 손을 떼면 **지나가던 색이
   * 남는다.** 프리셋은 «한 번 누르면 그 색»이라 괜찮지만 커스텀은 다르다.
   */
  const t = mount();
  open(t);
  openDrawer(t);

  const box = t.$(".drawer-bot .swatches .sw.custom");
  ok(box !== null, "★ 커스텀 칸이 있다");

  // **그 봇의 글자칸만** 본다 — 서랍에는 봇이 둘이고 판도 둘이다
  const mineInks = () => [...box.closest(".swatches").querySelectorAll(".ink")];
  const inksBefore = mineInks().map((b) => b.style.background);
  box.value = "#123456";
  box.dispatchEvent(new t.w.Event("input", { bubbles: true }));
  ok(t.sent.find((m) => m.t === "setBotColor") === undefined,
     "★ **고르는 동안에는 안 들어간다** — 지나가던 색이 남으면 안 된다");

  /*
   * ★ **고른 색이 글자칸에 깔린다** (2026-09-29).
   *
   * 🔴 글자칸이 늘 «이미 적용된 색» 을 깔고 있었다. 그래서 커스텀으로 남색을
   * 고르는 중에도 글자칸은 옛 색 위에 「가」를 그렸다 — **어느 글자색이
   * 읽히는지 볼 수가 없었다.** 정작 골라야 할 때 못 보여준 셈이다.
   *
   * 사용자 말: *"그래야 색 선택하고 글자 색도 결정하지"*.
   */
  const inksAfter = mineInks().map((b) => b.style.background);
  console.log(`   글자칸 배경: ${inksBefore.join(",")} → ${inksAfter.join(",")}`);
  ok(inksAfter.every((c) => /#123456|rgb\(18, ?52, ?86\)/.test(c)),
     `★ **글자칸이 고른 색으로 깔린다** (${inksAfter[0]}) — 이제 대비를 보고 고를 수 있다`);
  ok(inksAfter.join() !== inksBefore.join(), "★ 실제로 바뀌었다 — 원래 색과 다르다");

  /*
   * ★ **«적용»은 커스텀 칸 «옆»에 있어야 한다** (2026-09-29).
   *
   * 🔴 한때 아래 줄에 `[기본값으로] [적용]` 으로 나란히 뒀다. 끝내는 동작끼리
   * 모은 것인데, **적용은 커스텀에만 쓰인다** — 프리셋도 글자색도 누르면 바로
   * 들어간다. 아래에 있으면 *"뭘 적용하는 거지"* 가 된다.
   *
   * 단추는 **제가 다루는 것 옆에.** 그래야 «이 칸의 값을 넣는다»가 설명 없이
   * 읽힌다.
   */
  const customRow = t.$(".drawer-bot .swatches .custom-row");
  const inRow = [...customRow.children].map((c) => c.textContent || c.type);
  console.log(`   커스텀 줄: ${inRow.join(" / ")}`);
  ok(customRow.querySelector("input[type=color]") !== null, "★ 커스텀 칸이 그 줄에 있다");

  /*
   * ★ **「가」 를 누르면 색과 글자색이 같이 들어간다** (2026-09-29).
   *
   * 「스포이드 창 안에 «적용» 을 넣을 수 없나」 에서 나온 것이다. OS 가 그리는
   * 창이라 거기엔 못 넣는다 — 대신 **창을 닫고 나온 자리**에서 둘을 한 번에
   * 끝내게 한다. 색을 고른 뒤 「가」 하나만 더 누르면 되므로 «적용» 을 따로
   * 찾아갈 일이 없다.
   */
  {
    const t2 = mount();
    open(t2);
    openDrawer(t2);
    const c2 = t2.$(".drawer-bot .swatches .sw.custom");
    c2.value = "#0b3d2e";
    c2.dispatchEvent(new t2.w.Event("input", { bubbles: true }));
    t2.$$(".drawer-bot .swatches .ink")[1].click();   // 하양
    const sent = t2.sent.find((m) => m.t === "setBotColor");
    console.log(`   「가」(하양) 누름 → ${JSON.stringify(sent?.color)} · ${JSON.stringify(sent?.ink)}`);
    ok(sent?.color === "#0b3d2e",
       `★ **고른 색이 실려 간다** (${sent?.color}) — 옛 색이 아니다`);
    ok(sent?.ink === "white", `★ **글자색도 같이** (${sent?.ink})`);
  }

  const use = customRow.querySelector("button.apply");
  ok(use !== null, "★ **«적용»이 같은 줄에** — 무엇에 적용하는지가 보인다");
  ok(use.className.includes("primary"),
     `★ 강조 단추다 (${use.className}) — 누르기 전엔 아무 일도 안 일어나므로 다음 할 일이 보여야 한다`);

  const acts = t.$(".drawer-bot .swatches .pick-acts");
  const labels = [...acts.children].map((b) => b.textContent);
  ok(labels.join() === "기본값으로",
     `★ 아래 줄은 «기본값으로» 뿐 (${labels.join(" / ")}) — 이건 판 전체가 대상이다`);

  use.click();
  const posted = t.sent.find((m) => m.t === "setBotColor");
  ok(posted?.color === "#123456", `★ **누르면 그 색이 들어간다** (${posted?.color})`);
}

console.log("\n[★ «기본»으로 되돌리면 빈 값이 간다]");
{
  const t = mount();
  open(t);
  openDrawer(t);
  const back = [...t.$$(".drawer-bot .swatches button")].find((b) => b.textContent === "기본값으로");
  ok(back !== undefined, "★ 되돌리는 길이 있다");
  back.click();
  const posted = t.sent.find((m) => m.t === "setBotColor");
  ok(posted?.color === "",
     "★ **빈 값** — 코어가 필드를 지우고 테마가 주는 평소 말풍선으로 돌아간다");
  ok(posted?.ink === undefined,
     "★ **글자색도 안 보낸다** — 배경이 테마로 돌아가는데 글자만 검정으로 박혀 있으면 다크에서 안 읽힌다");
}

console.log("\n전부 통과");
