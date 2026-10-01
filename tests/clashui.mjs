/**
 * **부딪힘 띠가 화면에 보인다** (§4.3 · 2026-09-22 실측).
 *
 * 🔴 예전에는 시스템 메시지 **한 줄**로 끝이었다. 대화가 흐르면 그 줄은 위로
 * 밀려 올라가서, 사용자는 **부딪히는 중인지 이미 끝났는지 알 수가 없었다.**
 * 게다가 그 문구가 *"덮어쓸 수 있습니다"* 였는데 **사실이 아니었다.**
 *
 * 띠는 **지금 상태**고 메시지는 **그때 일어난 일**이다 — 둘 다 있어야 한다.
 *
 * ★ **자리가 중요하다.** 헤더 밑, 입력창이 보이는 자리여야 한다 — 막을 수 있는
 * 층은 사람뿐이라 「@베타 api.ts 고쳐줘」를 **치기 전에** 보여야 뜻이 있다.
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
      <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-agents"></button><button class="icon" id="btn-new"></button></header>
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

const bot = (id, agentId, name) => ({
  id, agentId, name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask",
});
const BOTH = [bot("b1", "claude", "구현"), bot("b2", "codex", "리뷰어")];
const room = () => ({
  id: "r1", title: "방", cwd: "/ws", participants: BOTH,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: ["b1", "b2"], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

const REASON =
  "<tool_use_error>File has been modified since read, either by the user or by a linter. " +
  "Read it again before attempting to write it.</tool_use_error>";

const open = () => {
  const t = mount();
  t.send({ t: "room", room: room() });
  return t;
};

console.log("\n[★ 부딪힘이 없으면 띠가 없다]");
{
  const { $ } = open();
  ok($(".clashes")?.hidden === true, "★ 평소에는 숨어 있다 — 안 겹칠 때가 대부분이다");
}

console.log("\n[★ 정황 — 아직 아무 일도 안 일어났다]");
{
  const { $, $$, send } = open();
  send({ t: "clashes", roomId: "r1", list: [
    { path: "/ws/src/core/api.ts", botIds: ["b1", "b2"], at: 1 },
  ] });

  ok($(".clashes")?.hidden === false, "★ 띠가 뜬다");
  ok($$(".clash").length === 1, "줄 하나");
  ok($(".clash-who")?.textContent === "구현·리뷰어",
     `★ **누구와 누구인지** (${$(".clash-who")?.textContent}) — «누가»는 우리만 안다`);
  ok($(".clash-path")?.textContent.includes("api.ts"), "★ 어느 파일인지");
  ok($(".clash-path")?.getAttribute("title") === "/ws/src/core/api.ts",
     "★ **전체 경로는 제목에 남는다** — 줄여 보여주되 버리지 않는다");
  ok($(".clash-what")?.textContent === "함께 고치는 중",
     `★ **아직 사실이 아니라고 말한다** (${$(".clash-what")?.textContent})`);
  ok($(".clash")?.className.includes("blocked") === false, "★ 아직 강조하지 않는다");
  ok($(".clash-why") === null, "사유가 없으면 접을 것도 없다");
}

console.log("\n[★ 사실 — 에이전트가 막혔다고 신고했다]");
{
  const { $, send } = open();
  send({ t: "clashes", roomId: "r1", list: [
    { path: "/ws/src/api.ts", botIds: ["b1", "b2"], blocked: true,
      blockedBotId: "b2", reason: REASON, at: 1 },
  ] });

  ok($(".clash")?.className.includes("blocked"), "★ **강조된다** — 정황과 사실은 무게가 다르다");
  ok($(".clash-what")?.textContent === "리뷰어가 막혀 다시 읽는 중",
     `★ **무슨 일이 일어나는지** (${$(".clash-what")?.textContent}) — «충돌»만으로는 뭘 할지 모른다`);
  ok($(".clash-what")?.textContent.includes("덮어") === false,
     "★ **«덮어쓴다»고 말하지 않는다** — 실측으로 거짓임이 확인된 말이다");
  ok($(".clash-why") !== null, "★ 사유를 접어서 단다");
  ok($(".clash-why pre")?.textContent === REASON,
     "★ **CLI가 준 말 그대로** (§0) — 우리 말로 바꾸면 원인을 못 짚는다");
  ok($(".clash-why")?.hasAttribute("open") === false,
     "★ 접혀 있다 — 평소엔 한 줄, 원하면 볼 수 있다");
}

console.log("\n[★ 자리 — 헤더 밑, 입력창이 보이는 곳]");
{
  const { $, w } = open();
  const kids = [...$("#screen-chat").children].map((n) => n.className.split(" ")[0]);
  const band = kids.indexOf("clashes");
  ok(band > kids.indexOf("bar"), "★ 헤더 아래");
  ok(band < kids.indexOf("messages"), "★ **대화 위** — 흘러가 버리면 «지금»을 못 본다");
  ok(band > kids.indexOf("approvals"),
     "★ **승인 큐 아래** — 승인은 답해야 진행되고, 부딪힘은 저절로 풀린다");
  ok(w.document.querySelector(".composer") !== null,
     "★ 입력창과 같은 화면에 있다 — 치기 전에 보여야 뜻이 있다");
}

console.log("\n[★ 걷힌다 — 띠는 «지금»이다]");
{
  const { $, $$, send } = open();
  send({ t: "clashes", roomId: "r1", list: [
    { path: "/ws/a.ts", botIds: ["b1", "b2"], blocked: true, blockedBotId: "b1", at: 1 },
  ] });
  ok($$(".clash").length === 1, "떴다");

  send({ t: "clashes", roomId: "r1", list: [] });
  ok($(".clashes")?.hidden === true,
     "★ **끝나면 사라진다** — 남겨두면 «이미 끝난 것»을 계속 경고하게 된다");
}

console.log("\n[★ 여러 파일이 동시에 부딪힐 수 있다]");
{
  const { $$, send } = open();
  send({ t: "clashes", roomId: "r1", list: [
    { path: "/ws/a.ts", botIds: ["b1", "b2"], at: 1 },
    { path: "/ws/b.ts", botIds: ["b1", "b2"], blocked: true, blockedBotId: "b2", at: 2 },
  ] });
  ok($$(".clash").length === 2, "★ 파일마다 한 줄");
  ok($$(".clash.blocked").length === 1, "★ 막힌 것만 강조된다");
}

console.log("\n[★ 남의 방 것은 안 받는다]");
{
  const { $, send } = open();
  send({ t: "clashes", roomId: "r9", list: [
    { path: "/ws/x.ts", botIds: ["b1", "b2"], at: 1 },
  ] });
  ok($(".clashes")?.hidden === true, "★ 다른 방에서 온 것은 무시한다");
}

console.log("\n[★ 모르는 봇 id 여도 화면이 안 깨진다]");
{
  const { $, send } = open();
  send({ t: "clashes", roomId: "r1", list: [
    { path: "/ws/x.ts", botIds: ["b1", "사라진봇"], at: 1 },
  ] });
  ok($(".clash-who")?.textContent === "구현·사라진봇",
     "★ 이름을 못 찾으면 **id를 그대로 보여준다** — 조용히 지우지 않는다 (§0)");
}

console.log("\n전부 통과");
