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
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: ["b1"], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});
const wait = (over = {}) => ({
  id: "w1", roomId: "r1", askerBotId: "b1", judgeBotId: "b2",
  title: "파일 고치기", since: 1, ...over,
});

function open(t) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
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
  ok(card.textContent.includes("리뷰어") && card.textContent.includes("기다립니다"),
     `★ **누구를 기다리는지** (${card.querySelector(".dim").textContent})`);

  const btn = [...card.querySelectorAll("button")].find((b) => b.textContent === "유저 승인으로");
  ok(btn !== undefined, "★ **빠져나올 길이 있다**");
  btn.click();
  const posted = t.sent.find((m) => m.t === "takeOverReview");
  ok(posted?.reviewId === "w1" && posted.roomId === "r1", "★ 그 심사만 가로챈다");
}

/*
 * ⏪ **«이미 물어본 뒤에는 가로채기를 안 준다» 가 여기 있었다** (v3.0 3-I).
 *
 * 심사가 **턴을 가로채** 물어보던 시절에는 «줄 서는 중» 과 «물어보는 중» 이
 * 달랐다 — 뒤엣것은 이미 턴이 돌고 있어서, 끊어도 되돌아오지 않았다.
 *
 * 이제 큐에 넣으면 끝이고, 묻는 것은 봇이 **제 턴에 꺼내 보는 일**이라
 * **우리가 그 순간을 모른다.** 한 모양이고, 가로채기는 **언제나** 있다 —
 * 가로채면 큐에서 빼므로 늦게 온 판정은 안 먹는다(`judgeflow.mts`).
 */

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
