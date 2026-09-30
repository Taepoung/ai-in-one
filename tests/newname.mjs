/**
 * **방 만들 때·부를 때 봇 이름을 정한다** (v2.2 앞당김 · §4.2.1).
 *
 * 🔴 여태는 이름을 **방에 들어간 뒤 서랍에서** 고쳐야 했다. 그런데 이름이 제일
 * 필요한 순간은 **같은 에이전트로 봇을 둘 넣을 때**다 — `Claude` 와 `Claude 2`
 * 로는 누가 리뷰어인지 알 수 없고, 멘션도 그 이름으로 간다(§4.1.2).
 * 부르는 자리에서 정할 수 있어야 들어가서 하나씩 고치지 않는다.
 *
 * ★ **겹치면 우리가 뒤에 수를 붙인다.** 만들고 나서 알게 되면 «내가 친 것과
 * 다른 이름»을 방에 들어가서 발견하게 되므로, **미리 보여주고 고칠 기회를 준다.**
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 저장소 안에서 스스로 위치를 찾는다 — 절대경로를 박으면 남의 기계에서 안 돈다
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

const AGENTS = [
  { id: "claude", label: "Claude", color: "#d97757" },
  { id: "codex", label: "Codex", color: "#10a37f" },
];

function mount() {
  const sent = [];
  const boot = { rooms: [], agents: AGENTS, reducedMotion: true, screen: "list",
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

/** 봇 칸의 이름 입력 — 봇 상자 안의 유일한 한 줄 입력이다 */
const nameInputs = (t) =>
  t.$$("#screen-new fieldset.bot").map((f) => f.querySelector('input[type="text"]'));
const typeIn = (t, input, v) => {
  input.value = v;
  input.dispatchEvent(new t.w.Event("input", { bubbles: true }));
};
const addBotBtn = (t) => t.$$("#screen-new button").find((b) => b.textContent.includes("봇 추가"));
const createBtn = (t) => t.$$("#screen-new button").find((b) => b.textContent === "만들기");

console.log("\n[★ 방 만들기에 이름 칸이 있다]");
{
  const t = mount();
  t.$("#btn-new").click();
  const [name] = nameInputs(t);
  ok(name !== null && name !== undefined, "★ 봇마다 이름 칸");
  ok(name.placeholder === "Claude",
     `★ **비우면 무엇이 되는지 보여준다** (${name.placeholder}) — 빈 칸이 «이름 없음»이 아니다`);
}

console.log("\n[★ 에이전트를 바꾸면 기본 이름도 따라간다]");
{
  const t = mount();
  t.$("#btn-new").click();
  t.$$("#screen-new .agent").find((b) => b.textContent.includes("Codex")).click();
  ok(nameInputs(t)[0].placeholder === "Codex",
     `★ 고른 에이전트의 이름이 기본값이다 (${nameInputs(t)[0].placeholder})`);
}

console.log("\n[★ 정한 이름이 만들기에 실려 간다]");
{
  const t = mount();
  t.$("#btn-new").click();
  typeIn(t, nameInputs(t)[0], "  구현  ");
  addBotBtn(t).click();
  typeIn(t, nameInputs(t)[1], "리뷰어");
  createBtn(t).click();

  const sent = t.sent.find((m) => m.t === "createRoom");
  ok(sent.bots.length === 2, "봇 둘");
  ok(sent.bots[0].name === "구현", `★ 앞뒤 공백을 턴다 (${JSON.stringify(sent.bots[0].name)})`);
  ok(sent.bots[1].name === "리뷰어", "★ 봇마다 따로");
}

console.log("\n[★ 안 정하면 아예 안 보낸다]");
{
  const t = mount();
  t.$("#btn-new").click();
  createBtn(t).click();
  const sent = t.sent.find((m) => m.t === "createRoom");
  ok(!("name" in sent.bots[0]),
     "★ 빈 이름을 보내지 않는다 — 기본값은 **코어가** 정한다 (규칙이 한 곳에 있어야 한다)");
}

console.log("\n[★ 겹치면 «이렇게 됩니다»를 미리 보여준다]");
{
  const t = mount();
  t.$("#btn-new").click();
  addBotBtn(t).click();
  typeIn(t, nameInputs(t)[0], "리뷰어");
  typeIn(t, nameInputs(t)[1], "리뷰어");

  const hints = t.$$("#screen-new fieldset.bot .bot-bent").filter((n) => !n.hidden);
  ok(hints.length === 1, `★ **뒤엣 것에만** 붙는다 (${hints.length}개) — 앞엣 것은 친 그대로다`);
  ok(hints[0].textContent.includes("«리뷰어 2»"),
     `★ **무엇이 될지** 말한다 (${hints[0].textContent})`);
  ok(hints[0].textContent.includes("«리뷰어»은(는) 이미 있어서"),
     "★ 왜 그렇게 되는지도 — 조용히 바꾸면 «왜 2가 붙었지»가 된다");
}

console.log("\n[★ 안 겹치면 아무 말도 안 한다]");
{
  const t = mount();
  t.$("#btn-new").click();
  addBotBtn(t).click();
  typeIn(t, nameInputs(t)[0], "구현");
  typeIn(t, nameInputs(t)[1], "리뷰어");
  ok(t.$$("#screen-new fieldset.bot .bot-bent").every((n) => n.hidden),
     "★ 겹치지 않으면 조용하다");
}

console.log("\n[★ 앞엣 것을 고치면 뒤엣 것 안내도 따라간다]");
{
  const t = mount();
  t.$("#btn-new").click();
  addBotBtn(t).click();
  typeIn(t, nameInputs(t)[0], "리뷰어");
  typeIn(t, nameInputs(t)[1], "리뷰어");
  ok(t.$$("#screen-new fieldset.bot .bot-bent").filter((n) => !n.hidden).length === 1, "겹쳤다");

  typeIn(t, nameInputs(t)[0], "구현");
  ok(t.$$("#screen-new fieldset.bot .bot-bent").every((n) => n.hidden),
     "★ **앞을 고치면 뒤가 풀린다** — 최종 이름은 순서로 정해지므로 전부 다시 봐야 한다");
}

console.log("\n[★ 봇 부르기 카드에도 있다]");
{
  const t = mount();
  const bot = (id, agentId, name) => ({
    id, agentId, name, sessionId: "s" + id,
    approver: { kind: "user" }, answerPolicy: "ask",
  });
  t.send({ t: "room", room: {
    id: "r1", title: "방", cwd: "/ws", participants: [bot("b1", "claude", "Claude")],
    messages: [], unread: 0, createdAt: 1, lastActivityAt: 2,
  }, compactable: false });

  // 헤더 ⋮ 를 거치지 않고 카드를 직접 띄우는 길이 없으므로 참여자 서랍에서 부른다
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  t.$$("#screen-bots button").find((b) => /부르기|초대|\+/.test(b.textContent)).click();

  const card = t.$("#screen-chat .card");
  ok(card !== null, "부르기 카드가 떴다");
  const name = card.querySelector('input[type="text"].bot-name');
  ok(name !== null, "★ 부를 때도 이름을 정한다");
  ok(name.placeholder === "Claude 2",
     `★ **이미 Claude 가 있으니 기본값이 «Claude 2»** (${name.placeholder}) — 여기가 이름이 제일 필요한 순간이다`);

  typeIn(t, name, "리뷰어");
  /*
   * 🔴 `button.primary` 로 집다가 **색 고르개의 «적용»** 을 집었다 (2026-09-29).
   * 그쪽도 강조 단추이고 카드 안에서 **더 앞에** 있다. 카드에 강조가 하나뿐일
   * 거라고 믿은 것이 틀렸다 — **글자로 집는다.**
   */
  const call = [...card.querySelectorAll("button")].find((b) => b.textContent === "부르기");
  ok(call !== undefined, "★ «부르기» 단추를 찾았다");
  call.click();
  const sent = t.sent.find((m) => m.t === "addBot");
  ok(sent?.name === "리뷰어", `★ 실려 간다 (${sent?.name})`);
}

console.log("\n전부 통과");
