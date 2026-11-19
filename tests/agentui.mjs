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
  state: "none", size: 0, loggedIn: false, canLogout: true, viaAcp: false, ...over,
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

  /*
   * 🔴 **로그아웃할 길이 없는 CLI 가 있다** (2026-10-07).
   *
   * `agy --help` 를 보면 하위 명령에 `login` 도 `logout` 도 없다 —
   * 그냥 띄우면 대화식으로 묻는 게 전부다. 그런데 화면은 `loggedIn`
   * 하나만 보고 단추를 달았고, 누르면 `if (!cmd) return` 으로 **조용히
   * 끝났다.** 사용자: *"로그아웃도 안먹네"*.
   *
   * 안 먹는 단추는 고장보다 나쁘다 — 몇 번을 더 누르게 만든다.
   */
  b = only("ready", { version: "1.3.0", size: 1, loggedIn: true, canLogout: false });
  console.log(`   ready(길 없음) → ${JSON.stringify(b)}`);
  ok(!b.includes("로그아웃"), "★ **길이 없으면 단추를 안 단다** — 눌러도 아무 일도 안 생긴다");
  ok(b.includes("제거"), "★ 그래도 제거는 남아 있다");
  ok(a.cards()[0].textContent.includes("로그아웃 명령이 없습니다"),
     "★ **왜 없는지 적어준다** — 그냥 지우면 «왜 없지» 가 된다");
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
  /*
   * **터미널이 안 뜨는 쪽에게 터미널 얘기를 하면 안 된다** (2026-10-07).
   *
   * ACP 로 로그인하는 에이전트는 **브라우저가 뜨다.** 그런데 화면은
   * «터미널이 열립니다» 를 무조건 적고 있었다 — 사용자가 짚었다.
   * 안 열릴 창을 기다리게 만드는 말이다.
   */
  {
    const a = mount();
    a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));

    a.send({ t: "agents", list: [row({ state: "needLogin", version: "1", size: 1 })] });
    const term = a.cards()[0].textContent;
    ok(term.includes("터미널이 열립니다"), "터미널 길은 그대로 터미널이라고 한다");

    a.send({ t: "agents", list: [row({ state: "needLogin", version: "1", size: 1, viaAcp: true })] });
    const web = a.cards()[0].textContent;
    console.log(`   ACP 쪽 → ${web.includes("브라우저") ? "브라우저" : "???"}`);
    ok(web.includes("브라우저가 열립니다"), "★ **ACP 쪽은 브라우저라고 한다**");
    ok(!web.includes("터미널이 열립니다"),
       "★ **안 뜨는 터미널을 기다리게 하지 않는다**");
  }

  console.log(`   ${JSON.stringify(card.textContent.trim().slice(0, 40))}`);
  ok(card.querySelectorAll("button").length === 0,
     "★ **단추를 안 띄운다** — 우리가 받은 것이 아니라 지울 수도 없다");
  ok(card.textContent.includes("설정"), "★ 왜 비었는지 적어준다");
}

/*
 * ★ **디스크 정리** (2026-11-19) — 사용자: *"캐시 정리할 수 있는 기능 넣을 수 있나?"*
 *
 * 재는 것은 **누를 때만** — 수만 개를 세므로 화면을 열 때마다 재면 디스크가 돈다.
 * 쓰는 중인 것은 보여주되 단추가 없고, 남의 자리는 그렇다고 적는다.
 */
console.log("\n[★ 디스크 정리 — 누를 때만 재고, 쓰는 것은 지우지 않는다]");
{
  const a = mount();
  a.$("#btn-agents").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  a.send({ t: "agents", list: [row({ state: "ready", version: "1", size: 1, loggedIn: true })] });
  const card = () => a.$("#screen-agents .clean-card");
  ok(card() !== null, "★ 로봇 화면 아래에 정리 칸이 있다");
  ok(a.cards().length === 1, "★ 에이전트 카드로 세지 않는다 — 다른 검사의 단추 세기를 안 흐린다");
  ok(!a.sent.some((m) => m.t === "cleanAsk"), "★ **열기만 해서는 안 잰다**");

  const go = [...card().querySelectorAll("button")].find((b) => b.textContent === "얼마나 쓰나 보기");
  ok(go !== undefined, "★ «얼마나 쓰나 보기» 단추");
  go.click();
  ok(a.sent.at(-1)?.t === "cleanAsk", "★ 누르면 재 달라고 한다");

  a.send({ t: "clean", busy: "얼마나 쓰는지 재는 중…" });
  ok(card().textContent.includes("재는 중"), "★ 재는 동안 그렇다고 보인다");

  const GB = 1024 * 1048576;
  const spot = (id, label, bytes, shared, canClean) =>
    ({ id, label, where: `/x/${id}`, bytes, shared, canClean, count: canClean ? 1 : 0 });
  a.send({ t: "clean", spots: [
    spot("agents", "받아둔 에이전트", 972 * 1048576, false, false),
    spot("node", "같이 받은 Node", 107 * 1048576, false, false),
    spot("leftover", "받다·지우다 남은 것", 0, false, true),
    spot("npmCache", "npm 캐시", 3.7 * GB, true, true),
    spot("npx", "npx 캐시", 6.6 * GB, true, true),
  ] });
  const rows = [...card().querySelectorAll(".clean-row")];
  for (const r of rows) console.log(`   ${r.textContent}`);
  ok(rows.length === 5, "★ 다섯 칸");
  const btn = (id) => card().querySelector(`.clean-row.${id} button`);
  ok(!btn("agents") && !btn("node"), "★ **쓰는 에이전트·Node 에는 지우기 단추가 없다**");
  ok(card().querySelector(".clean-row.agents").textContent.includes("「제거」"),
     "★ 대신 어디서 지우는지 적는다");
  ok(btn("leftover").disabled, "★ 0MB 칸의 단추는 죽어 있다");
  ok(card().querySelector(".clean-row.npx").textContent.includes("6.6GB"), "★ 크기를 보여준다");
  ok(card().querySelector(".clean-row.npmCache").textContent.includes("다른 프로그램도 씀"),
     "★ **남의 자리라고 적는다**");
  ok(card().querySelector(".clean-row.npx").title === "/x/npx", "★ 어디인지는 마우스를 올리면");

  btn("npx").click();
  ok(JSON.stringify(a.sent.at(-1)) === JSON.stringify({ t: "cleanDo", id: "npx" }), "★ 그 칸만 지우라고 한다");

  a.send({ t: "clean", busy: "npx 캐시을(를) 지우는 중…" });
  ok(card().querySelectorAll(".clean-row").length === 5, "★ 지우는 동안에도 칸은 그대로 — 단추가 도망가지 않는다");
  ok(btn("npmCache").disabled, "★ 지우는 동안 다른 지우기는 죽어 있다");

  a.send({ t: "clean", spots: [spot("npx", "npx 캐시", 0, true, true)], said: "6.6GB를 비웠습니다" });
  ok(card().textContent.includes("6.6GB를 비웠습니다"), "★ 결과를 말한다");
  ok(btn("npx").disabled, "★ 비운 칸은 0이라 단추가 죽는다");
  a.send({ t: "clean", busy: "얼마나 쓰는지 재는 중…" });
  ok(!card().textContent.includes("비웠습니다"), "★ 다음 일이 시작되면 지난 결과는 지운다");
}

console.log("\n전부 통과");
