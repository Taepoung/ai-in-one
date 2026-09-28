/**
 * **줄 서 있는 심사가 화면에 보이고, 사람이 가로챌 수 있다** (§4.2.2).
 *
 * 심사 봇의 세션은 하나라 직렬이다(B1). 그 봇이 자기 일을 하는 중이면 심사는
 * 기다린다 — 끊은 일은 자동으로 다시 이어지지 않으므로 그게 맞다.
 *
 * 🔴 그런데 기다리는 동안 **요청한 봇의 턴은 얼어 있다.** 안 보이면
 * «왜 아무 일도 안 일어나지»가 되고, 그때 할 수 있는 일도 없다.
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

const bot = (id, agentId, name) => ({
  id, agentId, name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask",
});
const BOTH = [bot("b1", "claude", "구현"), bot("b2", "codex", "리뷰어")];
const room = () => ({
  id: "r1", title: "방", cwd: "/ws", participants: BOTH,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: ["b1"], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});
const wait = (over = {}) => ({
  id: "w1", roomId: "r1", askerBotId: "b1", judgeBotId: "b2",
  title: "파일 고치기", state: "waiting", since: 1, ...over,
});

function open(t) {
  t.$(".room").click();
  t.send({ t: "room", room: room(), compactable: false });
}

console.log("\n[★ 기다리는 중이면 보이고, 가로챌 수 있다]");
{
  const t = mount();
  open(t);
  ok(t.$(".review-wait") === null, "평소엔 없다");

  t.send({ t: "reviews", roomId: "r1", list: [wait()] });
  const card = t.$(".review-wait");
  ok(card !== null, "★ 줄에 서면 보인다");
  ok(card.textContent.includes("구현") && card.textContent.includes("파일 고치기"),
     `★ **누가 무엇을** 승인하려는지 (${card.querySelector(".card-title").textContent.trim()})`);
  ok(card.textContent.includes("리뷰어") && card.textContent.includes("끝내면"),
     "★ **왜 기다리는지** — 심사 봇이 하던 일을 끝내면 물어본다");

  const btn = [...card.querySelectorAll("button")].find((b) => b.textContent === "내가 답할게");
  ok(btn !== undefined, "★ **빠져나올 길이 있다**");
  btn.click();
  const posted = t.sent.find((m) => m.t === "takeOverReview");
  ok(posted?.reviewId === "w1" && posted.roomId === "r1", "★ 그 심사만 가로챈다");
}

console.log("\n[★ 이미 물어본 뒤에는 가로채기를 안 준다]");
{
  const t = mount();
  open(t);
  t.send({ t: "reviews", roomId: "r1", list: [wait({ state: "asking" })] });

  const card = t.$(".review-wait");
  ok(card.textContent.includes("물어보는 중"),
     `★ «곧 끝난다»로 읽혀야 한다 (${card.textContent.trim()})`);
  ok([...card.querySelectorAll("button")].length === 0,
     "★ **돌고 있는 턴은 끊어도 자동으로 안 이어진다** — 그래서 버튼을 안 준다");
}

console.log("\n[★ 여럿이면 여럿 다 보인다]");
{
  const t = mount();
  open(t);
  t.send({ t: "reviews", roomId: "r1",
           list: [wait(), wait({ id: "w2", askerBotId: "b2", judgeBotId: "b1", title: "명령 실행" })] });
  ok(t.$$(".review-wait").length === 2, "★ 둘 다 — 쌓이는 게 보여야 한다");
}

console.log("\n[★ 끝나면 걷힌다]");
{
  const t = mount();
  open(t);
  t.send({ t: "reviews", roomId: "r1", list: [wait()] });
  ok(t.$(".review-wait") !== null, "있다");
  t.send({ t: "reviews", roomId: "r1", list: [] });
  ok(t.$(".review-wait") === null, "★ **빈 것도 와야** 걷힌다");
}

console.log("\n[★ 방을 옮기면 옆 방의 줄을 안 들고 간다]");
{
  const t = mount();
  open(t);
  t.send({ t: "reviews", roomId: "r1", list: [wait()] });
  ok(t.$(".review-wait") !== null, "있다");

  t.send({ t: "room", compactable: false, room: { ...room(), id: "r2", title: "옆 방" } });
  ok(t.$(".review-wait") === null, "★ 심사도 **방마다**다");
}

console.log("\n전부 통과");
