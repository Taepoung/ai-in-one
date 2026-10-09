/**
 * **올려둔 한 칸의 화면 상태** (v3.0 1-E · 4-21).
 *
 * ⏪ 이 파일은 원래 **줄 서 있는 말**을 쟀다. 바쁠 때 보내면 **저절로** 줄에
 * 섰고, 말풍선 아래에 «⏳ 대기 중» 띠가 붙고 그 안에 «지금 보내기»·«빼기»가
 * 있었다.
 *
 * 🔴 **그 큐가 엇갈림을 만들었다** — 10분짜리 일이 끝난 뒤에 «그거 말고 이거»가
 * 나가서 **이미 끝난 일에 대한 정정**이 날아갔다. 끼어들기가 있던 이유가 그건데,
 * 끼어들기를 없앴으므로(1-D) 남겨둔 큐만 혼자 그걸 계속 만든다.
 *
 * 그래서 **예약 한 칸**이다. 옛 큐와 결정적으로 다른 점은 **명시적 행동**이라는
 * 것 — 옛 큐는 기본 동작이라 모르고 쌓였다(«내가 언제 이걸 줄 세웠지»).
 *
 * ```
 * 예약만 있을 때   ⏳ 끝나면 보냅니다 — "그거 말고 이거"   [수정] [내리기]
 * 수정 누른 뒤     ↩ 치워둔 글 — "아까 쓰던 거"            [되돌리기]
 * ```
 *
 * **둘이 동시에 안 뜬다** — 「수정」을 누르는 순간 예약이 풀리므로 언제나 한 줄이다.
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

const AGENTS = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }];
const META = { id: "r1", title: "방", kind: "direct", cwd: "/ws", agentIds: ["claude"],
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
  id, agentId, name, sessionId: "s" + id, sessionPrompted: true,
  approver: { kind: "user" }, answerPolicy: "ask",
});

/** 방을 열고, 올려둔 칸과 봇 상태를 알려준다 */
function open(bots, staged, status) {
  const t = mount();
  t.$(".room").click();
  t.send({
    t: "room", compactable: false,
    room: {
      id: "r1", title: "방", cwd: "/ws/proj", participants: bots,
      messages: [], unread: 0, createdAt: 1, lastActivityAt: 2,
      ...(staged ? { staged } : {}),
    },
  });
  if (status) t.send({ t: "status", roomId: "r1", status: "streaming", bots: status });
  return t;
}

const rowOf = (t) => t.$("#screen-chat .staged-row");
const btn = (row, text) => [...row.querySelectorAll("button")].find((b) => b.textContent.includes(text));

const ONE = [bot("b1", "claude", "클로드")];
const TWO = [bot("b1", "claude", "알파"), bot("b2", "codex", "베타")];

console.log("\n[★ 올려두면 입력창 위에 보인다]");
{
  /*
   * 🔴 **접거나 작게 하지 않는다.** 올려두고 잊으면 10분 뒤 뜬금없이 나가서
   * «이게 왜 나가?»가 된다. 계속 보이는 것이 이 줄의 값이다.
   */
  const t = open(ONE, { tokens: [{ kind: "text", text: "그거 말고 이거 해줘" }],
                        botIds: ["b1"], at: 1 });
  const row = rowOf(t);
  ok(row !== null && !row.hidden, "★ **줄이 뜬다** — 안 보이면 올려둔 걸 잊는다");
  ok(row.textContent.includes("끝나면 보냅니다"), `★ 무엇을 할지 말한다 (${row.textContent})`);
  ok(row.textContent.includes("그거 말고 이거"), "★ **무슨 글인지도** — 제목만으로는 못 알아본다");
}

console.log("\n[★ 올려둔 것이 없으면 줄도 없다]");
{
  const t = open(ONE);
  const row = rowOf(t);
  ok(row === null || row.hidden, "★ 평소엔 자리를 안 먹는다");
}

console.log("\n[★ 수정과 내리기 — 같은 동작이고 «글을 살리느냐»만 다르다]");
{
  const t = open(ONE, { tokens: [{ kind: "text", text: "고칠 글" }], botIds: ["b1"], at: 1 });
  const row = rowOf(t);
  const labels = [...row.querySelectorAll("button")].map((b) => b.textContent.trim());
  ok(labels.join() === "수정,내리기", `★ **둘뿐이다** (${labels.join(" · ")})`);

  btn(row, "내리기").click();
  ok(t.sent.some((m) => m.t === "unstage" && m.roomId === "r1"), "★ 내리기는 내린다");

  const t2 = open(ONE, { tokens: [{ kind: "text", text: "고칠 글" }], botIds: ["b1"], at: 1 });
  btn(rowOf(t2), "수정").click();
  ok(t2.sent.some((m) => m.t === "editStaged" && m.roomId === "r1"),
     "★ 수정은 **돌려달라고** 한다 — 글은 코어가 들고 있다");
}

console.log("\n[★ 수정하면 쓰던 글이 치워진다 — 묻지도 않고 안 잃는다]");
{
  /*
   * 🔴 「수정」을 누르면 예약 글이 입력창으로 내려오는데, 그때 **쓰던 글이
   * 있으면** 덮어쓰게 된다. 깊이 1 스택으로 밀어두고 **보여준다** — 숨긴
   * 스택이 문제지, 한 줄로 보이면 그냥 «잠깐 치워둔 것»이다.
   */
  const t = open(ONE, { tokens: [{ kind: "text", text: "올려둔 글" }], botIds: ["b1"], at: 1 });
  const box = t.$("#screen-chat .composer textarea");
  box.value = "아까 쓰던 거";

  btn(rowOf(t), "수정").click();
  // 코어가 글을 돌려준다
  t.send({ t: "stagedBack", roomId: "r1", tokens: [{ kind: "text", text: "올려둔 글" }] });

  ok(box.value === "올려둔 글", `★ 예약 글이 입력창으로 내려왔다 (${box.value})`);
  const row = rowOf(t);
  ok(row.textContent.includes("치워둔 글"), `★ **쓰던 글은 안 잃는다** (${row.textContent})`);
  ok(row.textContent.includes("아까 쓰던 거"), "★ 무엇을 치웠는지도 보인다");
  ok([...row.querySelectorAll("button")].length === 1,
     "★ **되돌리기 하나뿐** — 치워둔 칸은 «예약»이 아니다. 안 나간다");

  btn(row, "되돌리기").click();
  ok(box.value === "아까 쓰던 거", `★ 되돌리면 그대로 (${box.value})`);
  ok(rowOf(t) === null || rowOf(t).hidden, "★ 그리고 줄이 걷힌다");
}

console.log("\n[★ 바쁘면 보내기 단추가 «끝나면 보내기»라고 말한다]");
{
  /*
   * 🔴 누르기 전에 **무슨 일이 일어날지**를 말해야 한다. 같은 모양이 어떤
   * 때는 바로 보내고 어떤 때는 올려두면, 올려둔 글이 10분 뒤에 나갈 때
   * «이게 왜 나가?»가 된다 — 올린 기억이 없으니까.
   */
  const idle = open(ONE);
  ok(!idle.$("#screen-chat .composer button.send").classList.contains("later"),
     "한가하면 그냥 보내기다");

  const t = open(ONE, undefined, { b1: "streaming" });
  const send = t.$("#screen-chat .composer button.send");
  ok(send.classList.contains("later"), "★ **모양이 달라진다**");
  ok((send.getAttribute("title") ?? "").includes("끝나면 보냅니다"),
     `★ 말로도 알려준다 (${send.getAttribute("title")})`);
}

console.log("\n[★ 칸이 차 있으면 미리 말해준다]");
{
  const t = open(ONE, { tokens: [{ kind: "text", text: "이미 하나" }], botIds: ["b1"], at: 1 },
                 { b1: "streaming" });
  const send = t.$("#screen-chat .composer button.send");
  ok((send.getAttribute("title") ?? "").includes("이미 하나 있습니다"),
     `★ **눌러보기 전에** 안다 (${send.getAttribute("title")})`);
}

console.log("\n[★ 단체방 — 누구를 기다리는지 적는다]");
{
  const t = open(TWO, undefined, { b1: "idle", b2: "streaming" });
  const send = t.$("#screen-chat .composer button.send");
  ok((send.getAttribute("title") ?? "").includes("베타"),
     `★ **누구 때문인지** (${send.getAttribute("title")}) — 모르면 기다릴지 말지를 못 정한다`);
}

console.log("\n전부 통과");
