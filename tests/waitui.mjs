/**
 * ★ **대기는 서랍에서 «수», 누르면 «화면»** (§5-M, 2026-10-14).
 *
 * 사용자: *"5-M에서 각 봇 별로 큐 보이는건 버튼을 눌러서 또 들어가게 해야될거
 * 같아. 엄청 쌓이면서는 봇별로 엄청 많아지면 정보보기도 어렵고 지저분해서 좀
 * 힘들듯?"*
 *
 * 🔴 서랍 한 줄은 **봇 하나**다. 한 봇의 대기를 거기서 펼치면 **다른 봇이
 * 화면 밖으로 밀린다** — 훑는 자리가 훑을 수 없게 된다. 그래서 서랍에 두는
 * 것은 수 하나고, 목록은 **얹는 화면**이다(로봇·권한과 같은 길).
 *
 * 그리고 두 종류는 **할 수 있는 일이 다르다**:
 *
 * ```
 * 권한    낸 봇이 얼어 있다   → 「유저 승인으로」. **버리기는 없다**
 * 메시지  아무도 안 기다린다  → 「버리기」
 * ```
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

const AGENTS = [
  { id: "claude", label: "Claude", color: "#d97757" },
  { id: "codex", label: "Codex", color: "#10a37f" },
];
const META = { id: "r1", title: "방", kind: "group", cwd: "/ws", agentIds: ["claude", "codex"],
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
    active: () => [...w.document.querySelectorAll(".screen.active")].map((x) => x.id),
  };
}

const bot = (id, agentId, name) => ({
  id, agentId, name, sessionId: "s" + id, sessionPrompted: true,
  approver: { kind: "user" }, answerPolicy: "ask",
});

const BOTS = [bot("b1", "claude", "구현"), bot("b2", "codex", "리뷰어")];

const ROOM = {
  id: "r1", title: "방", cwd: "/ws/proj", participants: BOTS,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: [], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
};

const WAITING = [
  { id: "p7", botId: "b2", kind: "permission", from: "구현",
    text: "터미널 명령", command: "rm -rf build/", at: 10 },
  { id: "x3", botId: "b2", kind: "message", from: "구현",
    text: "이 테스트 좀 봐줄래?", at: 11 },
];

/** 방을 열고, 대기를 보내고, 서랍을 연다 */
function open(t, list) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: ROOM, compactable: false });
  if (list) t.send({ t: "waiting", roomId: "r1", list });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  return t.$("#screen-bots");
}

const rowOf = (d, i) => d.querySelectorAll(".drawer-bot")[i];
const btn = (txt) => (b) => b.textContent.includes(txt);

console.log("\n[★ 대기가 없으면 **단추도 없다**]");
{
  const t = mount();
  const d = open(t, []);
  ok(d.querySelector(".wait-go") === null,
     "★ «대기 0» 을 안 띄운다 — 빈 단추가 참여자 수만큼 서면 자리만 먹는다");
}

console.log("\n[★ 서 있는 봇에게만 «대기 N»]");
{
  const t = mount();
  const d = open(t, WAITING);
  ok(rowOf(d, 0).querySelector(".wait-go") === null, "★ 구현에게는 안 붙는다 — 그 앞엔 아무것도 없다");
  const go = rowOf(d, 1).querySelector(".wait-go");
  ok(go !== null && go.textContent.includes("대기 2"), `★ 리뷰어에게 «대기 2» (${go?.textContent.trim()})`);
  ok(go.title.includes("승인 요청"),
     `★ **승인이 섞였으면 말한다** — 급한 쪽이 있다 (${go.title})`);
  ok(d.textContent.includes("rm -rf build/") === false,
     "🔴 **서랍에서 펼치지 않는다** — 내용은 한 줄도 안 쌓인다");
}

console.log("\n[★ 누르면 그 봇의 화면으로 — 서랍 «위에»]");
{
  const t = mount();
  const d = open(t, WAITING);
  rowOf(d, 1).querySelector(".wait-go").click();
  ok(t.active().includes("screen-wait"), "★ 대기 화면이 섰다");
  const head = t.$("#screen-wait .bar h1").textContent;
  ok(head.includes("리뷰어") && head.includes("2"), `★ 누구 것인지·몇인지 머리에 (${head.trim()})`);
  ok(t.$$("#screen-wait .wait-item").length === 2, "★ 두 줄");

  /* 돌아가기는 **서랍으로** — 온 길과 돌아가는 길이 같다 */
  t.$("#screen-wait .bar button").click();
  ok(t.active().includes("screen-bots"), "★ 뒤로가기 하나로 참여자로");
}

console.log("\n[🔴 둘은 **할 수 있는 일이 다르다**]");
{
  const t = mount();
  const d = open(t, WAITING);
  rowOf(d, 1).querySelector(".wait-go").click();
  const [perm, msg] = t.$$("#screen-wait .wait-item");

  ok(perm.textContent.includes("구현의 승인 요청"), "★ 권한 줄은 누가 냈는지로 시작한다");
  ok(perm.querySelector("pre").textContent.includes("rm -rf build/"),
     "★ **명령 그대로** — 제목만 보면 `rm -rf` 와 `ls` 가 같아 보인다 (D1)");
  /*
   * ★ **그 자리에서 답한다** (사용자, 2026-10-14) — *"펼쳐볼 수 있고 바로
   * 승인, 거절 할 수 있는게 더나을듯"*.
   *
   * ⏪ 두 번 돌았다: 채팅으로 데려갔다가, 따로 한 화면으로 보냈다가. 둘 다
   * **가져오는 걸음**이 끼어 있었는데 그건 우리 사정이지 사용자가 원하는
   * 일이 아니었다(큐에서 빼야 봇이 나중에 또 안 꺼내므로).
   *
   * 🔴 그래서 **줄을 펼칠 수 있어야** 한다 — 안 보고 누르면 심사가 아니라
   * 도장 찍기다(D1). 펼치면 명령·바뀌는 파일·미리보기가 카드와 같이 나온다.
   */
  ok(perm.tagName === "DETAILS", "★ 펼칠 수 있는 줄이다");
  const acts = [...perm.querySelectorAll(".card-actions button")].map((b) => b.textContent);
  ok(acts.join() === "허용,거절", `★ **그 자리에서 허용·거절** (${acts.join(",")})`);
  ok(!acts.includes("항상 허용"),
     "🔴 **«항상»은 없다** — 봇에게 안 주는 것과 같은 줄이다 (§4.2.2)");

  perm.querySelector(".card-actions .ok").click();
  const yes = t.sent.at(-1);
  ok(yes.t === "answerWaiting" && yes.id === "p7" && yes.allow === true && yes.botId === "b2",
     `★ **누구 큐의 무엇을 어떻게** (${JSON.stringify(yes)})`);
  perm.querySelector(".card-actions .no").click();
  ok(t.sent.at(-1).allow === false, "★ 거절도 같은 길로");

  ok(msg.textContent.includes("구현의 말"), "★ 메시지 줄");
  ok(msg.textContent.includes("이 테스트 좀 봐줄래?"), "★ 한 말이 그대로 보인다");
  const drop = [...msg.querySelectorAll(".card-actions button")];
  ok(drop.length === 1 && drop[0].textContent === "버리기",
     `★ 메시지에는 **버리기 하나** (${drop.map((b) => b.textContent).join(",")})`);
  /* 🔴 권한에 버리기를 안 주는 이유는 그대로다 — 버리면 낸 봇이 영영 기다린다 */
  ok(![...perm.querySelectorAll("button")].some((b) => b.textContent === "버리기"),
     "🔴 **권한에는 버리기가 없다**");
  drop[0].click();
  const out = t.sent.at(-1);
  ok(out.t === "dropWaiting" && out.botId === "b2" && out.id === "x3",
     `★ **누구 큐의 무엇인지**까지 보낸다 (${JSON.stringify(out)})`);
}

console.log("\n[★ 보고 있는 중에 닫히면 **그 자리에서** 줄어든다]");
{
  const t = mount();
  const d = open(t, WAITING);
  rowOf(d, 1).querySelector(".wait-go").click();
  /*
   * 🔴 **화면을 안 닫는다.** 마지막 하나가 처리된 순간 화면이 사라지면 «내가
   * 뭘 한 거지» 가 된다 — 돌아가는 것은 사용자가 한다.
   */
  t.send({ t: "waiting", roomId: "r1", list: [] });
  ok(t.active().includes("screen-wait"), "★ 화면은 그대로 서 있다");
  ok(t.$$("#screen-wait .wait-item").length === 0, "★ 줄은 사라졌다");
  ok(t.$("#screen-wait").textContent.includes("대기가 없습니다"), "★ 비었다고 말한다");

  t.$("#screen-wait .bar button").click();
  ok(t.$("#screen-bots .wait-go") === null, "★ 서랍의 수도 같이 사라졌다");
}

console.log("\n[★ 방을 옮기면 옆 방 것이 안 따라온다]");
{
  const t = mount();
  const d = open(t, WAITING);
  ok(rowOf(d, 1).querySelector(".wait-go") !== null, "전제 — 서 있었다");
  t.send({ t: "room", room: { ...ROOM, id: "r2" }, compactable: false });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  ok(t.$("#screen-bots .wait-go") === null,
     "★ **방마다다** — 안 비우면 옆 방 큐가 여기 붙는다 (심사 줄과 같은 줄)");
}

const CARD = {
  id: "c1", kind: "permission", roomId: "r1",
  req: {
    title: "터미널 명령", kind: "execute", readOnly: false,
    command: "rm -rf build/", askerBotId: "b1",
    options: [
      { optionId: "y", name: "이번만 허용", kind: "allow_once" },
      { optionId: "always", name: "항상 허용", kind: "allow_always" },
      { optionId: "n", name: "이번만 거절", kind: "reject_once" },
    ],
  },
};

console.log("\n[★ 승인이 오면 **채팅 입력창 위**에 선다 — 아무 데로도 안 끌려간다]");
{
  const t = mount();
  const d = open(t, WAITING);
  rowOf(d, 1).querySelector(".wait-go").click();
  ok(t.active().includes("screen-wait"), "전제 — 대기 화면에 있다");

  /*
   * ⏪ 한때 이 자리에서 **화면을 옮겼다** — 채팅으로 내려보내거나, 팝업을
   * 띄우거나, 유저 승인 화면으로 데려가거나. 셋 다 물렀다(사용자):
   * *"창을 따로 만드니까 조금 불편한데"*. 답하는 자리는 **보고 있던 자리**다.
   */
  t.send({ t: "ask", card: CARD });
  ok(t.active().includes("screen-wait"), "★ **보던 화면을 안 빼앗는다**");
  ok(t.$("#screen-chat .approvals").hidden === false,
     "★ 카드는 **채팅 입력창 위**에 선다 — 놓칠 일은 없다");
  ok(t.$("#screen-chat .approvals .approval") !== null, "★ 거기서 바로 답한다");
}

console.log("\n다 지나갔다 — 수는 서랍에, 목록은 화면에.");
