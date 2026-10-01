/**
 * **없어진 모델을 «다시 고르라»고 띄운다** (2026-09-30).
 *
 * 사용자 결정: *"이전 세션에 연결할 때 모델이 목록에 없으면, 사용자에게 새로
 * 선택하라고 함."*
 *
 * 여태는 시스템 줄 한 줄로 끝냈다. 🔴 **그 한 줄로는 모자랐다** — 대체는
 * **계열째** 갈린다(`gpt-6-luna`→`gpt-5.6-terra`, `sonnet`→`opus`. 둘 다 실측).
 * 이름만으로는 얼마나 다른지 못 재고, 시스템 줄은 대화가 길어지면 위로 밀려
 * 안 보인다.
 *
 * 그래서 **답할 때까지 남는 띠**를 띄운다. `contextLost` 와 같은 자리다.
 * 재는 것 넷:
 *
 * ```
 * ① 띠가 뜨나            — 그 봇에만
 * ② 고를 수 있나         — 띠 안에서 바로
 * ③ 고르면 올라가나      — 그 봇 앞으로
 * ④ «이대로 쓰기» 가 있나 — 지금 값이 좋은 사람도 띠를 걷어야 한다
 * ```
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const { JSDOM } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "jsdom", "lib", "api.js")).href
);
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

const SHELL = `<!DOCTYPE html><html><body>
  <div id="app">
    <section class="screen" id="screen-list" data-active>
      <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-agents"></button><button class="icon" id="btn-new"></button></header>
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

const bot = (id, name, extra = {}) => ({
  id, agentId: "claude", name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask", ...extra,
});

/** ★ 한 봇만 해당된다 — 단체방에서 멀쩡한 봇까지 물으면 안 된다 */
const TWO = [
  bot("b1", "구현", { model: "opus", modelLabel: "Opus 5", modelGone: { value: "sonnet", label: "Sonnet 5" } }),
  bot("b2", "리뷰어", { model: "opus", modelLabel: "Opus 5" }),
];

function open(t, participants = TWO) {
  t.$(".room").click();
  t.send({ t: "room", room: { id: "r1", title: "방", cwd: "/ws", participants,
                              messages: [], unread: 0, createdAt: 1, lastActivityAt: 2 },
           compactable: false });
}

/** 설정은 **방에 들어온 뒤** 늦게 온다 — 진짜 순서와 같게 */
const feedConfig = (t, botId) => t.send({
  t: "config", agentId: "claude", roomId: "r1", botId,
  options: [{ configId: "model", name: "Model", category: "model", current: "opus",
              values: [{ id: "opus", name: "Opus 5" }, { id: "haiku", name: "Haiku 4.5" }] }],
});
console.log("\n[★ 방에 들어가는 순간 «고르기» 화면으로 끌려간다]");
{
  const t = mount();
  open(t);
  const top = t.$$(".screen.active").map((s) => s.id);
  console.log(`   지금 화면: ${top.join(",")}`);
  ok(top.includes("screen-fix"), `★ **채팅이 아니라 고르기 화면** (${top.join(",")})`);
  ok(!top.includes("screen-chat"), "★ 채팅은 안 보인다 — 보이면 그냥 쓰게 된다");
  const txt = t.$("#screen-fix").textContent;
  ok(/쓸 수 없습니다/.test(txt), "★ **못 쓴다고 말한다**");
  ok(/성격이 다를 수 있습니다/.test(txt),
     "★ **왜 막는지** 적는다 — 안 적으면 «그냥 쓰면 되지 왜 막아» 가 된다");
}

console.log("\n[★ 모델이 없어진 봇만 세운다]");
{
  const t = mount();
  open(t);
  const cards = t.$$("#screen-fix .fix-bot");
  const names = cards.map((c) => c.querySelector("strong").textContent);
  console.log(`   세운 봇: ${names.join(", ")}`);
  ok(cards.length === 1, `★ **하나** (${cards.length}) — 봇이 둘인데 해당되는 건 하나다`);
  ok(names[0] === "구현", "★ 그 봇만 — 멀쩡한 봇까지 세우면 «방이 통째로 고장났나» 가 된다");
  ok(/Sonnet 5/.test(cards[0].textContent), "★ **없어진 것**을 이름으로 적는다");
  ok(cards[0].querySelector(".gone") !== null, "★ 줄 그은 자리에 — 무엇이 사라졌는지가 첫 정보다");
}

console.log("\n[★ 아무도 안 해당되면 평소처럼 채팅으로]");
{
  const t = mount();
  open(t, [bot("b1", "구현", { model: "opus", modelLabel: "Opus 5" })]);
  const top = t.$$(".screen.active").map((s) => s.id);
  console.log(`   지금 화면: ${top.join(",")}`);
  ok(top.includes("screen-chat"), "★ 채팅으로 간다 — 평소 방은 안 바뀐다");
  ok(t.$("#screen-fix").children.length === 0, "★ 고르기 화면은 비어 있다");
}

console.log("\n[★ 고르개는 늦게 온 설정을 기다린다]");
{
  /*
   * 🔴 **막아놓고 고를 수가 없으면 방이 통째로 잠긴다.** 설정은 방에 들어온
   * 뒤에 오므로, 그때 이 화면을 다시 안 그리면 «불러오는 중…» 에서 멈춘다.
   * 띠였을 때보다 훨씬 나쁘다 — 그땐 그냥 쓸 수라도 있었다.
   */
  const t = mount();
  open(t);
  ok(t.$("#screen-fix select.regone") === null, "★ 설정 전엔 고르개가 없다");
  ok(/불러오는 중/.test(t.$("#screen-fix").textContent), "★ 대신 기다린다고 적는다");

  feedConfig(t, "b1");
  const pick = t.$("#screen-fix select.regone");
  ok(pick !== null, "★ **늦게 온 설정으로 채워진다** — 안 그리면 방이 잠긴다");
  console.log(`   고를 수 있는 것: ${[...pick.options].map((o) => o.textContent).join(" / ")}`);

  pick.value = "haiku";
  pick.dispatchEvent(new t.w.Event("change", { bubbles: true }));
  /*
   * ★ **고르기만 해서는 안 간다** (2026-10-01).
   *
   * 사용자: *"선택하자마자 없어지는게 아니라, 내보내기 옆에 적용
   * 버튼이 있어야지"*. 고르개 한 번으로 치르면 손이 미끄러졌을 때
   * 되돌릴 길이 없다.
   */
  ok(t.sent.find((m) => m.t === "setConfig") === undefined,
     "★ **고르기만 해서는 안 간다**");
  const apply = [...t.$$("#screen-fix button")].find((b) => b.textContent.trim() === "적용");
  ok(apply !== undefined && !apply.disabled, "★ 고르면 «적용» 이 켬진다");
  apply.dispatchEvent(new t.w.MouseEvent("click", { bubbles: true }));
  const sent = t.sent.find((m) => m.t === "setConfig");
  console.log(`   → ${JSON.stringify(sent)}`);
  ok(sent?.value === "haiku", `★ 고른 값이 올라간다 (${sent?.value})`);
  ok(sent?.botId === "b1", `★ **그 봇 앞으로** (${sent?.botId})`);
}

console.log("\n[★ 다 고르면 채팅으로 넘어간다]");
{
  const t = mount();
  open(t);
  ok(t.$$(".screen.active").map((s) => s.id).includes("screen-fix"), "★ 막혀 있다");

  // 코어가 고쳐서 방을 다시 내보낸 것 — `modelGone` 이 지워져서 온다
  open(t, [bot("b1", "구현", { model: "haiku", modelLabel: "Haiku 4.5" }), TWO[1]]);
  const top = t.$$(".screen.active").map((s) => s.id);
  console.log(`   지금 화면: ${top.join(",")}`);
  ok(top.includes("screen-chat"), "★ **채팅으로 열린다** — 고르자마자 쓸 수 있어야 한다");
  ok(t.$("#screen-fix").children.length === 0, "★ 고르기 화면은 비워둔다");
}

console.log("\n[★ «지금 것 그대로» 도 답이다]");
{
  /*
   * 이 길이 없으면 대체된 것이 마음에 드는 사람은 **빠져나갈 수가 없다** —
   * 고르개에서 같은 값을 고르는 셈이라 손이 안 간다.
   */
  const t = mount();
  open(t);
  feedConfig(t, "b1");
  const keep = [...t.$$("#screen-fix button")].find((b) => /그대로 쓰기/.test(b.textContent));
  ok(keep !== undefined, "★ «그대로 쓰기» 가 있다");
  console.log(`   단추: ${keep.textContent}`);
  ok(/Opus 5/.test(keep.textContent), "★ **무엇을** 그대로 쓰는지 이름이 적혀 있다");
  keep.click();
  const sent = t.sent.find((m) => m.t === "setConfig");
  ok(sent?.value === "opus", `★ 지금 값 그대로 올린다 (${sent?.value})`);
}

console.log("\n[★ 가둬두지 않는다]");
{
  const t = mount();
  open(t);
  const out = t.$("#screen-fix .bar button");
  ok(out !== null, "★ 나가는 길이 있다");
  out.click();
  const top = t.$$(".screen.active").map((s) => s.id);
  console.log(`   나간 뒤: ${top.join(",")}`);
  ok(top.includes("screen-list"), "★ **목록으로 돌아간다** — 지금 안 쓰겠다는 것도 답이다");
}

console.log("\n전부 통과");
