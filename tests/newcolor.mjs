/**
 * **새 방 만들기에서 색을 정한다 — 안 고르면 파랑** (2026-09-30).
 *
 * 사용자 요청: *"새 대화방 만들기에서 봇 말풍선 색깔 정할 수 있게 (굳이
 * 지정하지 않으면 원래 파란색을 사용하도록)"* · *"혼자 쓰면 1:1 방입니다
 * 메세지 제거"*.
 *
 * 고르개는 이미 있었다. 🔴 **기본값이 «테마가 주는 평소 말풍선»** 이었던 것이
 * 문제다 — 그 값은 편집기 배경을 글자색 쪽으로 8% 민 것이라 거의 회색이다.
 * 색을 고를 수 있게 만들어 놓고 **아무도 안 고르면 아무 방에도 색이 없었다.**
 *
 * 그 파랑은 **내 말풍선과 같은 것**이다(`--vscode-button-background`) — 테마가
 * 강조색으로 고른 값이라 어느 테마에서든 «이 에디터의 파랑» 이고, 글자는
 * 하양이 맞는다. 팔레트 첫 칸(«기본»)에도 같은 색을 넣어 **돌아올 길**을 뒀다.
 *
 * 재는 것:
 *   ① 안 고르면 그 파랑이 실려 간다
 *   ② 고르개에 **보인다** — 숨은 기본값이 아니어야 바꿀 생각이 든다
 *   ③ 봇을 더해도 같은 파랑 — 겹쳐도 된다(사용자 결정)
 *   ④ 다시 열어도 처음과 같다
 *   ⑤ 고르면 고른 것이 이긴다
 *   ⑥ «혼자 쓰면 1:1 방입니다» 가 없다
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
  return {
    w, sent,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
  };
}

/** 만들기 화면을 연다 */
const openNew = (t) => { t.$("#btn-new").click(); return t.$("#screen-new"); };
const create = (t) =>
  [...t.$$("#screen-new button")].find((b) => /만들기|열기|시작/.test(b.textContent))?.click();

console.log("\n[★ 안 고르면 파랑이 실려 간다]");
{
  const t = mount();
  openNew(t);
  create(t);
  const m = t.sent.find((x) => x.t === "createRoom");
  console.log(`   실려 간 색: ${m?.bots?.[0]?.color}`);
  ok(m !== undefined, "★ 방 만들기가 올라간다");
  ok(/button-background/.test(m.bots[0].color ?? ""),
     `★ **파랑이 기본** (${m.bots[0].color}) — 고를 수 있게 해놓고 기본이 없으면 아무도 색이 없다`);
  ok((m.bots[0].color ?? "").startsWith("var(--vscode-"),
     "★ 테마 변수로 — 하드코딩하면 라이트에서 안 읽힌다");
}

console.log("\n[★ 그 파랑이 고르개에 보인다]");
{
  /*
   * 숨은 기본값이면 «바꿀 수 있다» 를 모른다. 고르개의 점이 파랑이어야
   * «지금 파랑이구나, 바꿔볼까» 가 된다 — 고르개는 화면과 같은 말을 해야 한다.
   */
  const t = mount();
  const s = openNew(t);
  const dot = s.querySelector(".swatch > summary .dot");
  console.log(`   고르개 점: ${dot?.style.background}`);
  ok(dot !== null, "★ 만들기 화면에 색 고르개가 있다");
  ok(/button-background/.test(dot.style.background), `★ **파랑으로 보인다** (${dot.style.background})`);
}

console.log("\n[★ 봇을 더해도 파랑 — 겹쳐도 된다]");
{
  /*
   * ⏪ 한때 **이미 쓴 색을 피해 다음 색**으로 넘겼다. 둘 다 파랑이면 색을 준
   * 보람이 없다고 봐서다. 사용자가 «봇끼리 색 겹쳐도 됨» 으로 정리했고 그
   * 편이 맞다 — 겹치는 것이 싫으면 **고르면 된다.** 안 겹치게 해주려다
   * «내가 파랑을 골랐는데 왜 자홍이지» 가 생기는 쪽이 더 나쁘다.
   */
  const t = mount();
  const s = openNew(t);
  [...s.querySelectorAll("button")].find((b) => /봇 추가/.test(b.textContent)).click();
  const dots = t.$$("#screen-new .swatch > summary .dot").map((d) => d.style.background);
  console.log(`   ${dots.join("  /  ")}`);
  ok(dots.length === 2, `★ 봇이 둘 (${dots.length})`);
  ok(dots.every((d) => /button-background/.test(d)), "★ **둘 다 같은 파랑** — 기본은 늘 같은 값이다");
}

console.log("\n[★ 다시 열어도 파랑에서 시작한다]");
{
  /*
   * 🔴 «이미 쓴 색 피하기» 시절, 새로 열 때 **지난 초안이 아직 들어 있어서**
   * 첫 봇이 자홍으로 시작했다. 피하기를 걷으면서 그 자리도 없어졌지만,
   * «다시 열면 처음과 같다» 는 그대로 지켜야 한다.
   */
  const t = mount();
  const s = openNew(t);
  [...s.querySelectorAll("button")].find((b) => /봇 추가/.test(b.textContent)).click();
  t.$("#screen-new .bar button").click();        // 목록으로
  t.$("#btn-new").click();                        // 다시 새 방
  const dots = t.$$("#screen-new .swatch > summary .dot").map((d) => d.style.background);
  console.log(`   다시 연 뒤: ${dots.join("  /  ")}`);
  ok(dots.length === 1, `★ 봇도 하나로 돌아온다 (${dots.length})`);
  ok(/button-background/.test(dots[0]), `★ **파랑에서 시작** (${dots[0]})`);
}

console.log("\n[★ 고르면 고른 것이 이긴다]");
{
  const t = mount();
  const s = openNew(t);
  const preset = s.querySelectorAll(".swatches .sw:not(.custom)")[3];   // 초록
  preset.click();
  s.querySelector(".swatches .apply").click();
  create(t);
  const m = t.sent.find((x) => x.t === "createRoom");
  console.log(`   고른 색: ${m?.bots?.[0]?.color}`);
  ok(m.bots[0].color === preset.style.background,
     `★ **고른 것이 실린다** (${m.bots[0].color}) — 기본값이 우기면 안 된다`);
}

console.log("\n[★ «혼자 쓰면 1:1 방입니다» 는 없다]");
{
  /*
   * 봇이 하나인 것은 **화면에 이미 보인다** — 칸이 하나뿐이다. 보이는 것을
   * 글로 또 말하면 «내가 뭘 잘못했나» 하고 읽게 된다.
   */
  const t = mount();
  const s = openNew(t);
  ok(!/혼자 쓰면/.test(s.textContent), "★ 안 적는다");
  [...s.querySelectorAll("button")].find((b) => /봇 추가/.test(b.textContent)).click();
  ok(/단체방으로 만들어집니다/.test(t.$("#screen-new").textContent),
     "★ **여럿일 때는 적는다** — 그건 화면에 안 보이던 결과다");
}

console.log("\n전부 통과");
