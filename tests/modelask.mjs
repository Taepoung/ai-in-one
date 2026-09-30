/**
 * **없어진 모델을 «다시 고르라»고 띄운다** (2026-09-30).
 *
 * 사용자 결정: *"이전 세션에 연결할 때 모델이 목록에 없으면, 사용자에게 새로
 * 선택하라고 함."*
 *
 * 여태는 시스템 줄 한 줄로 끝냈다. 🔴 **그 한 줄로는 모자랐다** — 대체는
 * **계열째** 갈린다(`gpt-6-luna`→`gpt-5.6-terra`, `sonnet`→`opus`. 둘 다 실측).
 * 이름만으로는 얼마나 다른지 못 재고, 시스템 줄은 대화가 길어지면 위로 밀려
 * 안 보인다.
 *
 * 그래서 **답할 때까지 남는 띠**를 띄운다. `contextLost` 와 같은 자리다.
 * 재는 것 넷:
 *
 * ```
 * ① 띠가 뜨나            — 그 봇에만
 * ② 고를 수 있나         — 띠 안에서 바로
 * ③ 고르면 올라가나      — 그 봇 앞으로
 * ④ «이대로 쓰기» 가 있나 — 지금 값이 좋은 사람도 띠를 걷어야 한다
 * ```
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
      <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-new"></button></header>
      <div class="filter"><input type="text" id="filter"><button class="icon" id="only-here" aria-pressed="false"></button></div>
      <div class="rooms" id="rooms"></div>
    </section>
    <section class="screen" id="screen-new"></section>
    <section class="screen" id="screen-chat"></section>
  </div>
  <script type="application/json" id="boot">__BOOT__</script>
</body></html>`;

const AGENTS = [{ id: "claude", label: "Claude", color: "#d97757" }];
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

const bot = (id, name, extra = {}) => ({
  id, agentId: "claude", name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask", ...extra,
});

/** ★ 한 봇만 해당된다 — 단체방에서 멀쩡한 봇까지 물으면 안 된다 */
const TWO = [
  bot("b1", "구현", { model: "opus", modelLabel: "Opus 5", modelGone: { value: "sonnet", label: "Sonnet 5" } }),
  bot("b2", "리뷰어", { model: "opus", modelLabel: "Opus 5" }),
];

function open(t, participants = TWO) {
  t.$(".room").click();
  t.send({ t: "room", room: { id: "r1", title: "방", cwd: "/ws", participants,
                              messages: [], unread: 0, createdAt: 1, lastActivityAt: 2 },
           compactable: false });
}

/** 설정은 **방에 들어온 뒤** 늦게 온다 — 진짜 순서와 같게 */
const feedConfig = (t, botId) => t.send({
  t: "config", agentId: "claude", roomId: "r1", botId,
  options: [{ configId: "model", name: "Model", category: "model", current: "opus",
              values: [{ id: "opus", name: "Opus 5" }, { id: "haiku", name: "Haiku 4.5" }] }],
});

console.log("\n[★ 없어진 모델이 있는 봇에만 띠가 뜬다]");
{
  const t = mount();
  open(t);
  const banners = t.$$("#screen-chat .banner.warn");
  console.log(`   띠 ${banners.length}개: ${banners.map((b) => b.textContent.slice(0, 50)).join(" | ")}`);
  ok(banners.length === 1, `★ **한 개** (${banners.length}) — 봇이 둘인데 해당되는 건 하나다`);
  const txt = banners[0].textContent;
  ok(txt.includes("구현"), "★ 어느 봇인지 짚는다 — 단체방에서 멀쩡한 봇까지 못 미더워지면 안 된다");
  ok(txt.includes("Sonnet 5"), "★ **없어진 것**을 이름으로 적는다");
  ok(txt.includes("Opus 5"), "★ **지금 도는 것**도 적는다 — 둘 다 있어야 무엇이 무엇으로인지 안다");
}

console.log("\n[★ 아무도 안 해당되면 안 뜬다]");
{
  const t = mount();
  open(t, [bot("b1", "구현", { model: "opus", modelLabel: "Opus 5" })]);
  ok(t.$$("#screen-chat .banner.warn").length === 0, "★ 조용하다 — 평소 방은 안 바뀐다");
}

console.log("\n[★ 띠 안에서 바로 고른다 — 설정이 늦게 와도]");
{
  const t = mount();
  open(t);
  const before = t.$("#screen-chat .banner.warn select.regone");
  console.log(`   설정 오기 전: ${before ? "고르개 있음" : "(불러오는 중)"}`);

  feedConfig(t, "b1");
  const pick = t.$("#screen-chat .banner.warn select.regone");
  ok(pick !== null, "★ **늦게 온 설정으로 고르개가 채워진다** — 안 그리면 영영 못 고른다");
  const names = [...pick.options].map((o) => o.textContent);
  console.log(`   고를 수 있는 것: ${names.join(" / ")}`);
  ok(names.includes("Haiku 4.5"), "★ 목록이 실렸다");

  pick.value = "haiku";
  pick.dispatchEvent(new t.w.Event("change", { bubbles: true }));
  const sent = t.sent.find((m) => m.t === "setConfig");
  console.log(`   → ${JSON.stringify(sent)}`);
  ok(sent?.value === "haiku", `★ 고른 값이 올라간다 (${sent?.value})`);
  ok(sent?.botId === "b1", `★ **그 봇 앞으로** (${sent?.botId}) — 봇이 둘이면 엉뚱한 쪽이 바뀐다`);
  ok(sent?.configId === "model", "★ 모델 칸으로");
}

console.log("\n[★ «이대로 쓰기» — 지금 값이 좋은 사람도 띠를 걷어야 한다]");
{
  /*
   * 이 길이 없으면 **띠를 못 걷는다.** 대체된 것이 마음에 드는 사람은 고르개에서
   * 고를 것이 없기 때문이다 — 같은 값을 고르는 셈이라 손이 안 간다.
   */
  const t = mount();
  open(t);
  feedConfig(t, "b1");
  const keep = [...t.$$("#screen-chat .banner.warn button")].find((b) => /이대로/.test(b.textContent));
  ok(keep !== undefined, "★ «이대로 쓰기» 가 있다");
  keep.click();
  const sent = t.sent.find((m) => m.t === "setConfig");
  console.log(`   → ${JSON.stringify(sent)}`);
  ok(sent?.value === "opus", `★ **지금 값 그대로** 올린다 (${sent?.value}) — 코어가 그걸 답으로 보고 걷는다`);
  ok(sent?.botId === "b1", "★ 그 봇 앞으로");
}

console.log("\n전부 통과");
