/**
 * ★ **보여주는 것은 쉰 개까지 — 기록은 그대로** (사용자, 2026-10-15).
 *
 * 🔴 여태 **전부** 그렸다. 디스크에서 통째로 읽고, 셸이 통째로 넘기고,
 * 화면이 통째로 말풍선을 지었다. 돌아가는 중에는 `nodeCache` 가 받쳐주지만
 * **껐다 켜면 그 캐시가 없다** — 방을 열 때마다 평생치를 처음부터 짓는다.
 *
 * 사용자: *"기록은 남아있지만 보여주는건 다른거지"*. 그래서 자르는 것은
 * **그리는 것**뿐이다:
 *
 * ```
 * 파일        그대로 (append 만 한다 · §0)
 * 넘기는 것    그대로 (`room.messages` 를 통째로 보낸다)
 * 그리는 것    꼬리부터 50개 + 「이전 대화 N개 더 보기」(위에 닿으면 저절로도)
 * ```
 *
 * 🔴 **못 보면 안 되는 것은 창을 넓힌다** — 안 읽음 줄이 창 밖이면 방을
 * 열자마자 **그 줄이 통째로 없는** 채로 바닥에 앉는다. 자르는 것이 보이는
 * 것을 바꾸면 안 된다.
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
      <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-agents"></button><button class="icon" id="btn-new"></button></header>
      <div class="filter"><input type="text" id="filter"><button class="icon" id="only-here" aria-pressed="false"></button></div>
      <div class="rooms" id="rooms"></div>
    </section>
    <section class="screen" id="screen-new"></section>
    <section class="screen" id="screen-chat"></section>
  </div>
  <script type="application/json" id="boot">__BOOT__</script>
</body></html>`;

const META = { id: "r1", title: "방", kind: "direct", cwd: "/ws", agentIds: ["claude"],
               unread: 0, createdAt: 1, lastActivityAt: 2 };

function mount() {
  const sent = [];
  const boot = { rooms: [META], agents: [{ id: "claude", label: "Claude" }],
                 reducedMotion: true, screen: "list", cwd: "/ws", hasWorkspace: true };
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

const bot = { id: "b1", agentId: "claude", name: "Claude", sessionId: "s1",
              approver: { kind: "user" }, answerPolicy: "ask" };

/** 말풍선 n 개짜리 방 — 사용자 말과 봇 말이 번갈아 */
const roomOf = (n, extra = {}) => ({
  id: "r1", title: "방", cwd: "/ws", participants: [bot], unread: 0,
  createdAt: 1, lastActivityAt: 2,
  messages: Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { id: `u${i}`, role: "user", text: `물음 ${i}`, deliveredTo: ["b1"], createdAt: i + 1 }
      : { id: `a${i}`, role: "agent", authorBotId: "b1", text: `답 ${i}`,
          deliveredTo: [], createdAt: i + 1 }),
  ...extra,
});

function open(t, r, extra = {}) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: r, compactable: false, ...extra });
}

console.log("\n[★ 짧은 방은 그대로 — 자를 것이 없으면 아무것도 안 바뀐다]");
{
  const t = mount();
  open(t, roomOf(30));
  ok(t.$$("#screen-chat .msg").length === 30, "서른 개 그대로");
  ok(t.$("#screen-chat .more-up") === null, "★ 접은 것이 없으면 **띠도 없다**");
}

console.log("\n[★ 긴 방은 꼬리부터 쉰 개만 — 그리고 수를 적는다]");
{
  const t = mount();
  open(t, roomOf(250));
  const msgs = t.$$("#screen-chat .msg");
  ok(msgs.length === 50, `★ **쉰 개만 그린다** (${msgs.length})`);
  ok(msgs.at(-1).textContent.includes("답 249"), "★ **꼬리**가 보인다 — 방금 한 말이 제일 중요하다");
  ok(!msgs[0].textContent.includes("물음 0"), "★ 맨 앞은 접혔다");

  const band = t.$("#screen-chat .more-up");
  ok(band !== null, "★ 위에 길이 난다");
  ok(band.textContent.includes("200"),
     `★ **얼마나 묻혔는지 적는다** (${band.textContent.trim()}) — 모르면 누를지 말지 못 고른다`);
}

console.log("\n[★ 누르면 쉰 개씩 더 — 기록은 처음부터 다 있었다]");
{
  const t = mount();
  open(t, roomOf(250));
  t.$("#screen-chat .more-up button").click();
  ok(t.$$("#screen-chat .msg").length === 100, `★ 백 개 (${t.$$("#screen-chat .msg").length})`);
  ok(t.$("#screen-chat .more-up").textContent.includes("150"), "★ 남은 수도 따라 준다");

  /* 끝까지 펴 본다 — 기록은 처음부터 다 와 있었고, 그리는 것만 늘어난다 */
  for (let i = 0; i < 10 && t.$("#screen-chat .more-up"); i++) {
    t.$("#screen-chat .more-up button").click();
  }
  ok(t.$$("#screen-chat .msg").length === 250, `★ 다 펴면 전부 (${t.$$("#screen-chat .msg").length})`);
  ok(t.$("#screen-chat .more-up") === null, "★ 다 폈으면 띠가 사라진다");
}

console.log("\n[🔴 안 읽음 줄이 창 밖이면 **창을 넓힌다**]");
{
  /*
   * 자르는 것이 **보이는 것을 바꾸면** 안 된다. 200개를 안 읽은 채로 방을
   * 열면 그 줄은 꼬리에서 200번째라 창 밖인데, 그대로 자르면 방을 열자마자
   * «여기서부터 안 읽음» 이 **통째로 없다.**
   */
  const t = mount();
  open(t, roomOf(250), { firstUnreadId: "u40" });
  ok(t.$("#screen-chat .unread-line") !== null, "★ **그 줄이 보인다**");
  const msgs = t.$$("#screen-chat .msg");
  ok(msgs.length > 100, `★ 창이 그만큼 넓어졌다 (${msgs.length})`);
  ok(msgs[0].textContent.includes("물음 40"), "★ 그 자리부터 그린다");
}

console.log("\n[★ 방을 바꾸면 창도 처음으로]");
{
  const t = mount();
  open(t, roomOf(250));
  t.$("#screen-chat .more-up button").click();
  ok(t.$$("#screen-chat .msg").length === 100, "전제 — 폈다");

  t.send({ t: "room", room: { ...roomOf(250), id: "r2" }, compactable: false });
  ok(t.$$("#screen-chat .msg").length === 50,
     `★ **옆 방에서 편 만큼 여기서도 펴지면 안 된다** (${t.$$("#screen-chat .msg").length})`);
}

console.log("\n[★ 나갔다 들어와도 **다시 쉰 개부터** (사용자, 2026-10-15)]");
{
  /*
   * 🔴 방을 **바꿀 때**만 되돌리면, 나갔다 **같은 방**으로 돌아올 때는 아까
   * 펴둔 만큼이 그대로 다시 그려진다 — 캐시가 식은 뒤라 **가장 비싼 순간**에
   * 제일 많이 짓는 셈이다.
   */
  const t = mount();
  open(t, roomOf(250));
  t.$("#screen-chat .more-up button").click();
  ok(t.$$("#screen-chat .msg").length === 100, "전제 — 폈다");

  t.$("#screen-chat .bar button").click();          // 목록으로
  t.$(".room").click();                              // 같은 방으로 다시
  t.send({ t: "room", room: roomOf(250), compactable: false });
  ok(t.$$("#screen-chat .msg").length === 50,
     `★ **다시 쉰 개부터** (${t.$$("#screen-chat .msg").length})`);
}

console.log("\n다 지나갔다 — 기록은 그대로, 그리는 것만 쉰 개.");
