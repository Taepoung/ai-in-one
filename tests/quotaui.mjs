/**
 * **사용량 팝업** (사용자, 2026-10-19) — 방 머리의 단추 · 팝업 · 새로고침.
 *
 * 🔴 **대화를 안 건드리는 것이 이 기능의 전부다.** 잔량은 어댑터의 슬래시
 * 명령으로만 알 수 있는데(`docs/SLASH.md`), 그걸 방으로 보내면 읽던 대화에
 * 말풍선이 둘 남는다. 그래서 여기서 제일 세게 재는 것은 «눌러도 `send` 가
 * 안 나간다» 이다 — 모양이 예뻐도 그게 깨지면 기능이 틀린 것이다.
 *
 * 나머지는 셋이다: 단추가 **참여자 왼쪽**에 서나, 팝업이 **에이전트마다 한
 * 줄**인가(봇 수가 아니라), 못 받은 것은 **왜인지 적히나**.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const { JSDOM } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "jsdom", "lib", "api.js")).href
);
const NL = String.fromCharCode(10);
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

const bot = (id, agentId) => ({ id, agentId, name: id,
  sessionId: "s" + id, sessionPrompted: true, approver: { kind: "user" }, answerPolicy: "ask" });

const room = (bots) => ({
  id: "r1", title: "방", cwd: "/ws", participants: bots,
  messages: [{ id: "u1", role: "user", text: "안녕", deliveredTo: [], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

function open(t, bots) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: room(bots), compactable: false });
}

console.log(NL + "[★ 단추는 참여자 바로 왼쪽에 선다]");
{
  const t = mount();
  open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  const head = t.$("#screen-chat .bar, #screen-chat header");
  const icons = [...head.querySelectorAll("button.icon")];
  const mine = icons.findIndex((b) => b.title === "사용량");
  const people = icons.findIndex((b) => (b.title ?? "").startsWith("참여자"));
  ok(mine >= 0, "★ 사용량 단추가 있다");
  ok(people === mine + 1,
     `★ **참여자 바로 왼쪽**이다 (사용량 ${mine} · 참여자 ${people})`);
}

console.log(NL + "[★ 누르면 묻는다 — 그런데 **방에는 아무것도 안 보낸다**]");
{
  const t = mount();
  open(t, [bot("b1", "claude")]);
  t.sent.length = 0;
  t.$("button.icon[title='사용량']").click();

  ok(t.$(".quota-card") !== null, "★ 팝업이 뜬다");
  /*
   * 🔴 **여기가 이 기능의 전부다.** `send` 가 한 번이라도 나가면 읽던
   * 대화에 말풍선이 둘 남는다 — 잔량을 보려고 대화를 더럽히는 꼴이다.
   */
  ok(t.sent.every((m) => m.t !== "send" && m.t !== "sendCompose"),
     `★ **대화로는 아무것도 안 간다** (${t.sent.map((m) => m.t).join(" · ") || "없음"})`);
  const ask = t.sent.filter((m) => m.t === "quotaAsk");
  ok(ask.length === 1 && ask[0].roomId === "r1",
     `★ 조회만 한 번 나간다 (${JSON.stringify(ask)})`);
  ok(/받는 중/.test(t.$(".quota-card").textContent),
     "★ **기다리는 줄을 세운다** — 20초까지 걸리는 길이라 빈 화면이면 고장으로 보인다");
}

console.log(NL + "[★ 에이전트마다 한 줄 — 봇 수가 아니다]");
{
  const t = mount();
  // 같은 에이전트 봇 둘 + 다른 에이전트 하나 = 줄은 **둘**이어야 한다
  open(t, [bot("b1", "claude"), bot("b2", "claude"), bot("b3", "codex")]);
  t.$("button.icon[title='사용량']").click();
  t.send({ t: "quota", list: [
    // 리팩토링 ③ 부터 **호스트가 뜯어서** 보낸다 — 화면은 `lines` 만 그린다
    { agentId: "claude", label: "Claude", cmd: "usage", at: 1,
      text: "**5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9",
      lines: [{ label: "5-hour limit", percent: 3, sense: "used", left: 97,
                resets: "Oct 19, 7:20 PM GMT+9" }] },
    { agentId: "codex", label: "Codex", at: 1, why: "로그인이 필요합니다" },
  ] });

  const rows = t.$$(".quota-row");
  ok(rows.length === 2, `★ **두 줄이다** (봇은 셋, 에이전트는 둘 — ${rows.length})`);
  /*
   * 🔴 **Claude 의 «3%» 는 «쓴 양»이다** — 막대는 «남은 양»으로 맞춰야 한다.
   * 그대로 세우면 멀쩡한 계정이 거의 비어 보인다.
   */
  ok(/97% 남음/.test(rows[0].textContent),
     `★ **쓴 양을 남은 양으로 뒤집어** 세운다 (${rows[0].querySelector(".quota-bar-num")?.textContent})`);
  ok(rows[0].querySelector(".quota-raw pre")?.textContent?.includes("3%") === true,
     "★ **받은 글은 접어서 그대로** 남는다 — 뜯기가 틀려도 참은 한 번 더 누르면 나온다");
  ok(/\/usage/.test(rows[0].textContent), "★ 무엇을 불러서 받았는지도 적는다");
  ok(/로그인이 필요합니다/.test(rows[1].textContent),
     "★ **못 받은 것은 왜인지** 적힌다 — 하나가 터져도 나머지는 보인다");
}

console.log(NL + "[★ 화면은 뜯지 않는다 — 리팩토링 ③]");
{
  /*
   * 🔴 **뜯는 것은 호스트(애드온의 선언)다.** 화면이 글을 직접 뜯으면 «쓴
   * 양이냐 남은 양이냐» 를 화면이 알아야 하고, 그건 에이전트마다 반대다.
   * 그래서 `lines` 없이 글만 오면 **막대를 안 세운다** — 글은 그대로 접혀 있다.
   */
  const t = mount();
  open(t, [bot("b1", "claude")]);
  t.$("button.icon[title='사용량']").click();
  t.send({ t: "quota", list: [
    { agentId: "claude", label: "Claude", cmd: "usage", at: 1,
      text: "**5-hour limit** — **3%** · Resets Oct 19, 7:20 PM GMT+9" },
  ] });
  ok(t.$$(".quota-bar").length === 0, "★ **`lines` 가 없으면 막대가 없다** — 화면이 짐작하지 않는다");
  ok(t.$(".quota-raw pre")?.textContent?.includes("3%") === true, "★ 받은 글은 그대로 접혀 있다");
}

console.log(NL + "[★ 새로고침은 다시 묻는다]");
{
  const t = mount();
  open(t, [bot("b1", "claude")]);
  t.$("button.icon[title='사용량']").click();
  t.send({ t: "quota", list: [
    { agentId: "claude", label: "Claude", cmd: "usage", at: 1, text: "3%" },
  ] });
  t.sent.length = 0;

  const again = t.$$(".quota-card .card-actions button").at(-1);
  ok(again.textContent === "새로고침", `★ 강조 단추가 맨 오른쪽 (${again.textContent})`);
  again.click();
  ok(t.sent.filter((m) => m.t === "quotaAsk").length === 1, "★ 다시 묻는다");
  ok(t.sent.every((m) => m.t !== "send"), "★ 이번에도 대화로는 안 간다");
}

console.log(NL + "[★ 줄 하나만 다시 받는다 (사용자, 2026-10-20)]");
{
  /*
   * 하나가 비어 왔다고 멀쩡한 줄까지 다시 깨우지 않는다 — 한 번에 20초씩 든다.
   * 다시 받는 동안 **그 줄만** «받는 중» 이고, 다른 줄은 받아 둔 그대로다.
   */
  const t = mount();
  open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  t.$("button.icon[title='사용량']").click();
  t.send({ t: "quota", list: [
    { agentId: "claude", label: "Claude", cmd: "usage", at: 1, text: "멀쩡한 글",
      lines: [{ label: "5-hour limit", percent: 3, sense: "used", left: 97 }] },
    { agentId: "codex", label: "Codex", cmd: "status", at: 1,
      why: "/status 를 보냈는데 답 글이 비어 왔습니다. 다시 받아 보세요." },
  ] });
  ok(/답 글이 비어 왔습니다/.test(t.$$(".quota-row")[1].textContent),
     "★ **빈 것은 무엇이 비었는지** 적힌다 — «빈손으로 왔습니다» 가 아니다");
  t.sent.length = 0;

  const retry = t.$$(".quota-row")[1].querySelector("button.quota-retry");
  ok(retry !== null && !retry.disabled, "★ 줄마다 다시 받기 단추가 있다");
  retry.click();
  const ask = t.sent.filter((m) => m.t === "quotaAsk");
  ok(ask.length === 1 && ask[0].agentId === "codex",
     `★ **그 에이전트만** 묻는다 (${JSON.stringify(ask)})`);
  ok(t.sent.every((m) => m.t !== "send" && m.t !== "sendCompose"), "★ 이번에도 대화로는 안 간다");
  ok(/받는 중/.test(t.$$(".quota-row")[1].textContent), "★ 그 줄만 «받는 중»");
  ok(/97% 남음/.test(t.$$(".quota-row")[0].textContent), "★ **다른 줄은 그대로** 서 있다");

  // 그 줄의 답만 온다 — 다른 줄은 안 바뀐다
  t.send({ t: "quota", only: "codex", list: [
    { agentId: "codex", label: "Codex", cmd: "status", at: 2, text: "**codex 5h limit:** 80% left",
      lines: [{ label: "codex 5h limit", percent: 80, sense: "left", left: 80 }] },
  ] });
  const rows = t.$$(".quota-row");
  ok(rows.length === 2, `★ 줄 수는 그대로 (${rows.length})`);
  ok(/97% 남음/.test(rows[0].textContent) && /80% 남음/.test(rows[1].textContent),
     "★ **그 줄만 갈아끼웠다** — Claude 97% · Codex 80%");
  ok(!/받는 중/.test(t.$(".quota-card").textContent), "★ 다 받았으면 «받는 중» 이 걷힌다");
}

console.log(NL + "전부 통과");
