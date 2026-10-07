/**
 * **한 번 실패하면 영영 안 물었다** (2026-10-07).
 *
 * 사용자: *"안티그래비티 아직도 방 만들때, 모델 목록 안나옴"*. 제품 코드로
 * 재보니 11개가 멀쩡히 온다 — **19.5초** 걸려서 그렇지.
 *
 * 범인은 조르는 조건이었다:
 *
 * ```
 * 설정은 패널을 만들 때 한 번 밀어준다      (warmConfigs)
 * 화면은 configs.has() 가 거짓일 때만 조른다
 * 그런데 **실패도 빈 배열로 들어간다**      → has() 가 참이 된다
 * ```
 *
 * 로그인 전에 그 한 번이 지나가면 **패널을 닫았다 열기 전까지** 비어 있다.
 * 게다가 화면은 *"이 에이전트는 고를 수 있는 모델을 알려주지 않습니다"* 라고
 * 한다 — **못 물어본 것이지 저쪽이 안 알려준 게 아니다.**
 *
 * 재는 것:
 *
 * ```
 * ① 실패가 오면 까닭을 그대로 보여준다 (빈 목록으로 둔갑시키지 않는다)
 * ② 다시 들어가면 **다시 조른다**
 * ③ 성공한 뒤에는 안 조른다 — 19.5초짜리를 괜히 두 번 돌리지 않는다
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
      <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-agents"></button><button class="icon" id="btn-new"></button></header>
      <div class="filter"><input type="text" id="filter"><button class="icon" id="only-here" aria-pressed="false"></button></div>
      <div class="rooms" id="rooms"></div>
    </section>
    <section class="screen" id="screen-new"></section>
    <section class="screen" id="screen-chat"></section>
  </div>
  <script type="application/json" id="boot">__BOOT__</script>
</body></html>`;

function mount() {
  const sent = [];
  const boot = {
    rooms: [], reducedMotion: true, screen: "list", cwd: "/ws", hasWorkspace: true,
    agents: [{ id: "antigravity", label: "Antigravity", available: true }],
  };
  const dom = new JSDOM(SHELL.replace("__BOOT__", JSON.stringify(boot)),
                        { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  w.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.eval(fs.readFileSync(path.join(ROOT, "dist", "webview.js"), "utf8"));
  const send = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  const open = () => w.document.querySelector("#btn-new")
    .dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const back = () => w.document.querySelector("#screen-new .bar .icon")
    .dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  return {
    w, sent, send, open, back,
    asks: () => sent.filter((m) => m.t === "needConfig").length,
    text: () => w.document.querySelector("#screen-new").textContent,
  };
}

const FAIL = "Antigravity 이(가) 90초 안에 응답하지 않았습니다.";
const GOT = [{
  configId: "model", name: "Model", category: "model", current: "gemini-3.8-flash-high",
  values: [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  ],
}];

console.log("\n[★ 실패하면 까닭을 보여준다]");
{
  const a = mount();
  a.open();
  const first = a.asks();
  /* warmConfigs 가 실패한 꼴 — 빈 목록 + 까닭 */
  a.send({ t: "config", agentId: "antigravity", options: [], error: FAIL });
  console.log(`   화면: ${a.text().includes(FAIL) ? "까닭이 보인다" : "안 보인다"}`);
  ok(a.text().includes(FAIL), "★ **까닭을 그대로 보여준다**");
  ok(!a.text().includes("알려주지 않습니다"),
     "★ **«저쪽이 안 알려준다» 로 둔갑시키지 않는다** — 못 물어본 것이다");
  ok(first >= 0, "들어가면서 한 번 조른다");
}

console.log("\n[★ 실패한 뒤에 다시 들어가면 다시 조른다]");
{
  const a = mount();
  a.open();
  a.send({ t: "config", agentId: "antigravity", options: [], error: FAIL });
  const before = a.asks();
  a.back();
  a.open();
  const after = a.asks();
  console.log(`   조른 횟수: ${before} → ${after}`);
  ok(after > before, "★ **다시 조른다** — 전엔 빈 배열이 들어차 영영 안 물었다");
}

console.log("\n[★ 성공한 뒤에는 안 조른다]");
{
  const a = mount();
  a.open();
  a.send({ t: "config", agentId: "antigravity", options: GOT });
  console.log(`   화면: ${a.text().includes("Gemini 3.8 Flash (High)") ? "모델이 뜬다" : "안 뜬다"}`);
  ok(a.text().includes("Gemini 3.8 Flash (High)"), "★ 받은 모델이 뜬다");
  const before = a.asks();
  a.back();
  a.open();
  ok(a.asks() === before,
     "★ **19.5초짜리를 괜히 두 번 돌리지 않는다**");
}

console.log("\n전부 통과");
