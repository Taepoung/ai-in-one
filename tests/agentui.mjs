/**
 * **에이전트 설정 화면 — 상태가 단추를 정한다** (2026-10-01).
 *
 * 사용자가 표로 정해줬다. 그 표가 화면에 그대로 나오는지 잰다:
 *
 * ```
 * none       설치하기
 * stale      업데이트          + 제거
 * needLogin  로그인            + 제거
 * ready      로그아웃 · 사용량  + 제거
 * ```
 *
 * 🔴 **제거와 로그아웃이 따로여야 한다.** 자격은 `~/.codex`·`~/.claude` 에
 * 있어 우리가 지우는 자리가 아니다 — 하나로 묶으면 «앱을 지웠더니 로그인도
 * 날아갔다» 가 된다. 그래서 `ready` 에 둘이 **같이** 떠야 한다.
 *
 * 그리고 단추를 **화면이 제 손으로 고르지 않는다.** 계산은 전부
 * `agentInstaller.stateOf` 한 자리에 있고 여기는 받아 그린다 — 두 자리에서
 * 같은 규칙을 쓰면 언젠가 갈라진다.
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
  const send = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  return {
    w, sent, send,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    cards: () => [...w.document.querySelectorAll("#screen-agents .agent-card")],
    labels: (card) => [...card.querySelectorAll("button")].map((b) => b.textContent.trim()),
  };
}

const row = (over) => ({
  id: "codex", label: "Codex", color: "#10a37f", managed: true,
  state: "none", size: 0, loggedIn: false, ...over,
});

console.log("\n[★ 로봇 단추가 화면을 열고 목록을 조른다]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  ok(a.sent.some((m) => m.t === "agentsAsk"), "★ 열면서 목록을 조른다");
  ok(a.$("#screen-agents").classList.contains("active"), "★ 그 화면으로 간다");
  ok(a.$("#screen-agents .codicon-arrow-left") !== null,
     "★ **뒤로가기가 보인다** — 없는 codicon 을 쓰면 통째로 안 보인다(전적이 있다)");
}

console.log("\n[★ 상태마다 단추가 표대로]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));

  const only = (state, extra) => {
    a.send({ t: "agents", list: [row({ state, ...extra })] });
    return a.labels(a.cards()[0]);
  };

  let b = only("none");
  console.log(`   none      → ${JSON.stringify(b)}`);
  ok(b.includes("설치하기"), "★ `none` → 설치하기");
  ok(!b.includes("제거"), "★ **안 받았으면 제거가 없다** — 지울 것이 없다");

  b = only("stale", { version: "2.0.1", wanted: "2.1.0", size: 441 * 1048576, loggedIn: true });
  console.log(`   stale     → ${JSON.stringify(b)}`);
  ok(b.includes("업데이트"), "★ `stale` → 업데이트");
  ok(b.includes("제거"), "★ 제거도 같이");
  ok(a.cards()[0].textContent.includes("2.0.1") && a.cards()[0].textContent.includes("2.1.0"),
     "★ **두 판을 같이 보여준다** — 무엇에서 무엇으로인지 알아야 누른다");
  ok(a.cards()[0].textContent.includes("441MB"), "★ 자리를 얼마나 먹는지 보여준다");

  b = only("needLogin", { version: "2.1.0", size: 1 });
  console.log(`   needLogin → ${JSON.stringify(b)}`);
  ok(b.includes("로그인"), "★ `needLogin` → 로그인");
  ok(!b.includes("로그아웃"), "★ 로그인 안 됐는데 로그아웃을 띄우지 않는다");

  b = only("ready", { version: "2.1.0", size: 1, loggedIn: true });
  console.log(`   ready     → ${JSON.stringify(b)}`);
  ok(b.includes("로그아웃"), "★ `ready` → 로그아웃");
  ok(b.includes("제거"), "★ **제거와 로그아웃이 따로 있다** — 묶으면 로그인까지 날아간 줄 안다");
}

console.log("\n[★ 제거는 빨간 단추다]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  a.send({ t: "agents", list: [row({ state: "ready", size: 1, loggedIn: true })] });
  const drop = [...a.cards()[0].querySelectorAll("button")].find((x) => x.textContent.trim() === "제거");
  console.log(`   class = ${JSON.stringify(drop.className)}`);
  ok(drop.classList.contains("danger"),
     "★ **`danger` 가 붙는다** — 봇 «빼기»와 같은 꼴, 같은 무게의 일이다");
}

console.log("\n[★ 누르면 그 일을 보낸다]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  a.send({ t: "agents", list: [row({ state: "none" })] });
  a.sent.length = 0;
  [...a.cards()[0].querySelectorAll("button")]
    .find((x) => x.textContent.trim() === "설치하기")
    .dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  const did = a.sent.find((m) => m.t === "agentDo");
  console.log(`   보낸 것: ${JSON.stringify(did)}`);
  ok(did?.what === "install" && did.agentId === "codex", "★ 무엇을 누구에게인지 실어 보낸다");

  /* 업데이트도 같은 일이다 — 가르는 것은 부르는 쪽이 아니라 지금 상태다 */
  a.send({ t: "agents", list: [row({ state: "stale", version: "2.0.1", wanted: "2.1.0", size: 1, loggedIn: true })] });
  a.sent.length = 0;
  [...a.cards()[0].querySelectorAll("button")]
    .find((x) => x.textContent.trim() === "업데이트")
    .dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  ok(a.sent.find((m) => m.t === "agentDo")?.what === "install",
     "★ 업데이트도 `install` 로 간다 — 받는 일은 하나뿐이다");
}

console.log("\n[★ 받는 중에는 단추를 안 보여준다]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  a.send({ t: "agents", list: [row({ state: "none", busy: "added 19 packages in 5s" })] });
  const card = a.cards()[0];
  ok(card.textContent.includes("added 19 packages"), "★ 저쪽이 하는 말을 그대로 보여준다");
  ok(card.querySelectorAll("button").length === 0,
     "★ **단추가 없다** — 받는 중에 또 누르면 두 번 돈다");

  /*
   * ★ **지우는 중에도 같다** (2026-10-06).
   *
   * 사용자: *"에이전트 제거중에 뭔가 표시가 있으면 좋겠어 지워지고 있는건지
   * 모르겠네"*. 그리는 길은 하나다 — `busy` 가 차 있으면 그 말을 띄우고
   * 단추를 감춘다. 받기든 지우기든 **화면은 같은 규칙**을 따른다.
   */
  a.send({ t: "agents", list: [row({ state: "ready", size: 1, loggedIn: true, busy: "지우는 중…" })] });
  const gone = a.cards()[0];
  ok(gone.textContent.includes("지우는 중"), "★ 지우는 중이라고 말한다");
  ok(gone.querySelectorAll("button").length === 0,
     "★ **그때도 단추가 없다** — 398MB 를 지우는 사이 또 누르면 안 된다");}

console.log("\n[★ 사용자가 직접 적은 에이전트는 안 건드린다]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  a.send({ t: "agents", list: [row({ managed: false, state: "ready", loggedIn: true })] });
  const card = a.cards()[0];
  console.log(`   ${JSON.stringify(card.textContent.trim().slice(0, 40))}`);
  ok(card.querySelectorAll("button").length === 0,
     "★ **단추를 안 띄운다** — 우리가 받은 것이 아니라 지울 수도 없다");
  ok(card.textContent.includes("설정"), "★ 왜 비었는지 적어준다");
}

console.log("\n전부 통과");
