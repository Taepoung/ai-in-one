/**
 * **서랍에 얹은 것들** (§4.2.1 · §4.2.2).
 *
 * - 권한을 **한 줄로** — 봇마다 시트를 열어보지 않아도 되게
 * - 이름을 **제자리에서** 바꾸기
 * - 봇을 누르면 **입력창에 멘션이 꽂힌다**
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

const bot = (id, agentId, name, extra = {}) => ({
  id, agentId, name, sessionId: "s" + id, sessionPrompted: true,
  approver: { kind: "user" }, answerPolicy: "ask", ...extra,
});

const room = (bots) => ({
  id: "r1", title: "방", cwd: "/ws/proj", participants: bots,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: [], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

/** 에이전트가 주는 권한 모드 목록 */
const MODE = {
  agentId: "claude",
  options: [{
    configId: "mode", category: "mode", name: "권한 모드", current: "default",
    values: [
      { id: "default", name: "기본" },
      { id: "acceptEdits", name: "편집까지 자동" },
      { id: "plan", name: "읽기만" },
    ],
  }],
};

function open(t, bots, extra = {}) {
  t.$(".room").click();
  t.send({ t: "room", room: room(bots), compactable: false, ...extra });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  return t.$("#screen-bots");
}

const BOTH = () => [bot("b1", "claude", "구현"), bot("b2", "codex", "리뷰어")];

console.log("\n[★ 권한을 한 줄로 — 봇마다 시트를 열어보지 않게]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "room", room: room(BOTH()), compactable: false });
  for (const b of ["b1", "b2"]) t.send({ t: "config", roomId: "r1", botId: b, ...MODE });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();

  const lines = t.$$(".drawer-bot .perm").map((e) => e.textContent);
  ok(lines.length === 2, "봇마다 한 줄");
  ok(lines[0].includes("기본"), `★ **모드**를 이름으로 (${lines[0]})`);
  ok(lines[0].includes("승인은 사용자에게"), "★ **막히면 누가 답하나**");
  ok(lines[0].includes("물어봄"), "★ **갈림길에서** 어떻게 하나 — 「봇 : 범위 : 대상」이 그대로");
}

console.log("\n[★ 봇마다 다른 권한이 한눈에 대비된다]");
{
  const t = mount();
  const bots = [
    bot("b1", "claude", "구현", { configValues: { mode: "acceptEdits" } }),
    bot("b2", "claude", "리뷰어", { configValues: { mode: "plan" }, answerPolicy: "auto" }),
  ];
  t.$(".room").click();
  t.send({ t: "room", room: room(bots), compactable: false });
  for (const b of ["b1", "b2"]) t.send({ t: "config", roomId: "r1", botId: b, ...MODE });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();

  const lines = t.$$(".drawer-bot .perm").map((e) => e.textContent);
  ok(lines[0].includes("편집까지 자동") && lines[1].includes("읽기만"),
     `★ **「리뷰어는 읽기만, 구현 봇은 편집까지」가 한눈에** (${lines.join(" | ")}) — 이게 §4.2.2의 요점이다`);
  ok(lines[1].includes("알아서"), "★ 질문 정책도 봇마다 다르게 읽힌다");
}

console.log("\n[★ «아직 안 왔다»와 «없다»를 구분한다]");
{
  const t = mount();
  const d = open(t, BOTH());   // config 를 안 보냈다
  ok(d.querySelector(".perm").textContent.includes("불러오는 중"),
     "★ 설정이 안 왔으면 «불러오는 중» — «이 에이전트는 권한 모드가 없다»로 읽히면 안 된다");
}

console.log("\n[★ 이름을 제자리에서 바꾼다]");
{
  const t = mount();
  const d = open(t, BOTH());
  const pencil = d.querySelector(".drawer-bot .who .icon.tiny");
  ok(pencil !== null, "연필이 이름 옆에");
  pencil.click();

  /*
   * 🔴 `.who input` 으로 잡다가 **색 고르개(`input[type=color]`)까지 걸렸다**
   * (2026-09-28). 이름 입력창은 **글을 치는** 칸이므로 그렇게 좁혀 잡는다 —
   * 안 그러면 «닫혔나»를 엉뚱한 것으로 재게 된다.
   */
  const NAME_BOX = ".drawer-bot .who input:not([type=color])";
  const input = t.$(NAME_BOX);
  ok(input !== null, "★ 제자리에서 고친다 — 새 화면으로 안 보낸다");
  ok(input.value === "구현", "★ 지금 이름이 담겨 있다");

  input.value = "구현 봇";
  input.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const posted = t.sent.find((m) => m.t === "renameBot");
  ok(posted !== undefined, "올라간다");
  ok(posted.botId === "b1" && posted.name === "구현 봇", "★ 그 봇의 새 이름으로");

  /*
   * 🔴 **엔터를 쳐도 아무 일도 안 일어난 것처럼 보였다.**
   *
   * `paintDrawer` 에는 «입력 중이면 건드리지 않는다»는 규칙이 있는데(치던
   * 글자가 날아가므로), 이 입력창이 포커스를 쥔 채로 부르니 **그 규칙에
   * 우리가 걸렸다.** 이름은 실제로 바뀌었는데 화면만 그대로였다.
   */
  ok(t.$(NAME_BOX) === null,
     "★ **입력창이 닫힌다** — 안 닫히면 «안 먹었다»로 보인다");
}

console.log("\n[★ 바뀐 이름이 서랍에 나타난다]");
{
  const t = mount();
  open(t, BOTH());
  t.$(".drawer-bot .who .icon.tiny").click();
  const input = t.$(".drawer-bot .who input");
  input.value = "설계자";
  input.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  // 코어가 고친 방이 돌아온다
  const bots = BOTH().map((b) => (b.id === "b1" ? { ...b, name: "설계자" } : b));
  t.send({ t: "room", room: room(bots), compactable: false });
  ok(t.$(".drawer-bot .who").textContent.includes("설계자"),
     `★ 새 이름이 보인다 (${t.$(".drawer-bot .who").textContent.trim()})`);
}

console.log("\n[이름을 안 바꾸면 아무것도 안 올린다]");
{
  const t = mount();
  const d = open(t, BOTH());
  d.querySelector(".drawer-bot .who .icon.tiny").click();
  const input = t.$(".drawer-bot .who input");
  input.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(t.sent.find((m) => m.t === "renameBot") === undefined, "★ Esc는 무른다");
}

console.log("\n[★ 봇을 누르면 그 봇의 뷰로 간다 (v2.1)]");
{
  const t = mount();
  const d = open(t, BOTH());
  const go = d.querySelector(".drawer-bot .name-go");
  ok(go !== null, "★ 이름이 눌러진다");
  go.click();

  ok(!t.$$(".screen.active").map((x) => x.id).includes("screen-bots"),
     "★ 들어가면 참여자 화면은 닫힌다 — 칸은 늘 있고 보이느냐는 스택이 정한다");
  // 헤더는 «방 이름 · @봇» 이다 — 방 이름이 먼저여야 «건너온 것»처럼 안 읽힌다
  ok(t.$("#screen-chat .view-head .view-of")?.textContent === "· @구현",
     `★ **그 봇의 뷰로 간다** (${t.$("#screen-chat .view-head")?.textContent.slice(0, 12)})`);

  /*
   * 🔴 **«입력창에 칩을 꽂는» 동작은 뺐다** (v2.1). *"봇별 1:1 뷰가 들어오기
   * 전까지의 자리"* 라고 적어둔 임시 동작이었고, 그 화면이 생겼다.
   *
   * 아쉽지 않다 — **뷰 안에서 친 말은 자동으로 그 봇에게 간다.** 꽂을 이유가
   * 사라진 것이지 길이 막힌 게 아니다. 방 전체에서 지목하려면 `@` 를 친다.
   */
  ok(t.$("#screen-chat .chipbox") === null, "★ 뷰에서는 칩 상자도 아니다");
}

console.log("\n[1:1에서는 봇 뷰가 없다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude", "Claude")]);
  ok(d.querySelector(".name-go") === null,
     "★ 봇이 하나면 **이미 그 봇의 뷰**다 — 갈라 볼 것이 없다");
  ok(d.querySelector(".drawer-bot .who .icon.tiny") !== null,
     "★ 이름 바꾸기는 1:1에도 있다 — 나중에 봇을 부르면 그 이름으로 지목하게 된다");
}

console.log("\n[★ 헤더 버튼이 몇 명인지 보여준다]");
{
  const t = mount();
  open(t, BOTH());
  const btn = t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title));
  ok(btn.querySelector(".count")?.textContent === "2",
     "★ **수가 눈에 보인다** — 여태 툴팁에만 있어서 서랍을 열어야 알 수 있었다");
  ok(btn.title === "참여자 2", "툴팁도 그대로");
}

console.log("\n[1:1에서는 숫자를 안 붙인다]");
{
  const t = mount();
  open(t, [bot("b1", "claude", "Claude")]);
  const btn = t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title));
  ok(btn.querySelector(".count") === null, "★ 언제나 1이면 숫자가 뜻을 못 갖는다");
}

console.log("\n전부 통과");
