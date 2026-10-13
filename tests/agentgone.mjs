/**
 * **에이전트를 안 받았으면 막는다** (2026-10-01).
 *
 * 사용자: *"안 받으면, 방 만들때 목록에 안떠야되고, 이미 있던 채팅방에서도
 * 에이전트 없어져서 다른 에이전트로 바꾸거나 내보내야된다고 알려줘"*.
 *
 * 즉 «모델이 없어졌다» 와 **같은 취급**이다. 사용자 입장에선 둘 다 «이 방을
 * 지금 못 쓴다» 이고, 고치는 길도 같다 — 다른 걸 고르거나 봇을 내보낸다.
 *
 * ```
 * ① 안 받은 에이전트는 방 만들기 목록에 안 뜬다
 * ② 그걸 쓰던 방은 **채팅이 아니라 막음 화면**으로 간다
 * ③ 거기서 **다른 에이전트로 바꾸거나 내보낸다**
 * ④ **내보내기는 모델이 없어진 경우에도** 있다
 * ⑤ 받으면 막음이 풀린다
 * ```
 *
 * ④가 사용자가 따로 짚은 것이다. 예전엔 «고르기» 밖에 없어서 **그 봇을 더 안
 * 쓰고 싶은 사람은 갇혀 있었다** — 안 고르면 방 전체가 막힌 채로 남았다.
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

const META = { id: "r1", title: "방", kind: "group", cwd: "/ws", agentIds: ["codex"],
               unread: 0, createdAt: 1, lastActivityAt: 2 };

/** `available` 을 바꿔가며 띄운다 — 이게 이 검사의 손잡이다 */
function mount(avail = { claude: true, codex: false }) {
  const sent = [];
  const agents = [
    { id: "claude", label: "Claude", color: "#d97757", available: avail.claude },
    { id: "codex", label: "Codex", color: "#10a37f", available: avail.codex },
  ];
  const boot = { rooms: [META], agents, reducedMotion: true, screen: "list",
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
    fix: () => w.document.getElementById("screen-fix"),
    btns: () => [...w.document.querySelectorAll("#screen-fix button")]
      .map((b) => b.textContent.trim()),
  };
}

const bot = (id, agentId, name, extra = {}) => ({
  id, agentId, name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask", ...extra,
});

function open(t, participants) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: { id: "r1", title: "방", cwd: "/ws", participants,
                              messages: [], unread: 0, createdAt: 1, lastActivityAt: 2 },
           compactable: false });
}

console.log("\n[★ 안 받은 에이전트는 방 만들기 목록에 안 뜬다]");
{
  const t = mount();
  t.$("#btn-new").dispatchEvent(new t.w.MouseEvent("click", { bubbles: true }));
  const opts = [...t.$$("#screen-new .agent-pick option")].map((o) => o.textContent.trim());
  console.log(`   고를 수 있는 것: ${JSON.stringify(opts)}`);
  ok(opts.includes("Claude"), "★ 받아둔 것은 뜬다");
  ok(!opts.includes("Codex"),
     "★ **안 받은 것은 안 뜬다** — 고르게 해두고 나중에 막으면 더 나쁘다");
}

console.log("\n[★ 그걸 쓰던 방은 막음 화면으로 간다]");
{
  const t = mount();
  open(t, [bot("b1", "codex", "코덱스")]);
  const top = t.$$(".screen.active").map((s) => s.id);
  console.log(`   지금 화면: ${top.join(",")}`);
  ok(top.includes("screen-fix"), "★ **채팅이 아니라 막음 화면**");
  const txt = t.fix().textContent;
  ok(/쓸 수 없습니다/.test(txt), "★ 못 쓴다고 말한다");
  ok(/받지 않았|받아둔/.test(txt) || t.btns().length > 0, "★ 무엇을 하라고 적는다");
}

console.log("\n[★ 거기서 다른 에이전트로 바꾸거나 내보낸다]");
{
  const t = mount();
  open(t, [bot("b1", "codex", "코덱스")]);
  const sel = t.$("#screen-fix select");
  const opts = [...sel.options].map((o) => o.textContent.trim());
  console.log(`   바꿀 수 있는 것: ${JSON.stringify(opts)}`);
  ok(opts.some((x) => x.includes("Claude")), "★ **받아둔 것으로 갈아탈 수 있다**");
  ok(!opts.some((x) => x.includes("Codex")),
     "★ 없는 것으로는 못 간다 — 같은 자리를 맴돈다");

  /*
   * ★ **고르기 전에도 줄은 둘이다** (2026-10-02).
   *
   * 이전 에이전트와 이전 모델이 처음부터 보이고, 모델 고르개는 **에이전트를
   * 고를 때까지 꺼져 있다.** 무엇을 더 정해야 하는지 미리 보이는 쪽이 낫다.
   */
  const first = t.$$("#screen-fix .fix-swap");
  console.log(`   줄: ${first.map((x) => x.querySelector(".gone").textContent).join(" / ")}`);
  ok(first.length === 2, `★ **줄이 처음부터 둘이다** (${first.length})`);
  ok(first[0].querySelector(".gone").textContent.includes("Codex"),
     "★ 왼쪽에 이전 에이전트가 남는다");
  ok(t.$$("#screen-fix select.regone")[1].disabled,
     "★ **모델 고르개는 꺼져 있다** — 어느 에이전트인지 모르면 모델도 모른다");
}

console.log("\n[★ 모델이 없어진 경우에도 내보내기가 있다]");
{
  /*
   * 사용자가 따로 짚은 것이다. 예전엔 고르기밖에 없어서 **그 봇을 더 안 쓰고
   * 싶은 사람은 갇혀 있었다** — 안 고르면 방 전체가 막힌 채였다.
   */
  const t = mount({ claude: true, codex: true });
  open(t, [bot("b1", "claude", "구현",
    { model: "opus", modelLabel: "Opus 5", modelGone: { value: "sonnet", label: "Sonnet 5" } })]);
  t.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1",
    options: [{ configId: "model", name: "Model", category: "model", current: "opus",
                values: [{ id: "opus", name: "Opus 5" }] }] });
  const labels = t.btns();
  console.log(`   단추: ${JSON.stringify(labels)}`);
  ok(labels.some((x) => /내보내기/.test(x)),
     "★ **모델이 없어진 경우에도 내보낼 수 있다** — 고르기만 있으면 갇힌다");

  const rows = t.$$("#screen-fix .fix-swap");
  console.log(`   줄: ${rows.map((x) => x.querySelector(".gone").textContent).join(" / ")}`);
  ok(rows.length === 2, `★ **에이전트 줄과 모델 줄이 둘 다 있다** (${rows.length})`);
  ok(rows[0].querySelector(".gone").textContent.includes("Claude"),
     "★ 첫 줄이 에이전트 — **모델만 없어져도 갈아탈 수 있어야 한다**");
  ok(rows[1].querySelector(".gone").textContent.includes("Sonnet 5"),
     "★ **이전 모델이 무엇이었는지 보인다** — 고르는 순간 제일 알고 싶은 것이다");
  ok(rows[1].querySelector("select") !== null, "★ 그 오른쪽이 고르개다");
}

console.log("\n[★ 받으면 막음이 풀린다]");
{
  const t = mount();
  open(t, [bot("b1", "codex", "코덱스")]);
  ok(t.$$(".screen.active").map((s) => s.id).includes("screen-fix"), "★ 막혀 있다가");

  t.send({ t: "agents", list: [
    { id: "claude", label: "Claude", color: "#d97757", managed: true, available: true,
      state: "ready", size: 1, loggedIn: true },
    { id: "codex", label: "Codex", color: "#10a37f", managed: true, available: true,
      state: "ready", size: 1, loggedIn: true },
  ] });
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  const top = t.$$(".screen.active").map((s) => s.id);
  console.log(`   받은 뒤: ${top.join(",")}`);
  ok(top.includes("screen-chat"),
     "★ **받으면 바로 들어간다** — 다시 열라고 하지 않는다");
}

console.log("\n전부 통과");
