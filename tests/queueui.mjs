/**
 * **줄 서 있는 말의 화면 상태** (2026-10-07 — 다시 씀).
 *
 * ⏪ 사라진 셋 중 마지막(`NEXT.md` ①). 이름과 «18개» 만 남아 있어 코드를 다시
 * 읽고 새로 설계했다. 원래 이름은 `.mts` 였는데, 재는 것이 **화면**이라
 * jsdom 을 쓰는 다른 검사들(`agentui` · `drawer` · `configretry`)과 맞춰
 * `.mjs` 로 둔다.
 *
 * 🔴 **줄에 선 말풍선은 보낸 것과 똑같이 생겼다.** 그래서 표시가 없으면
 * *"보냈는데 왜 조용하지"* 가 된다 — 이 띠가 유일한 단서다.
 *
 * ```
 * 1:1      ⏳ 앞 대화가 끝나면 보냅니다
 * 단체방    ⏳ 베타 대기 중            ← 누구를 기다리는지
 * ```
 *
 * 그리고 급할 때 쓰는 자리라 **두 길**이 같이 있다. 둘은 결과가 정반대인데
 * 글자 길이가 비슷해서, 아이콘이 다른지까지 잰다.
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
/*
 * 🔴 **`deliveredTo` 가 비어 있으면 띠가 안 붙는다.** 처음에 그렇게 써서 헤맸다.
 *
 * 띠는 «이 말이 **갈 곳** 중 아직 안 간 데» 를 적는 것이라, 받는 이가 없으면
 * 적을 것도 없다. 줄에 섰다는 것은 **보낼 상대는 정해졌는데 아직 못 갔다**는
 * 뜻이다.
 */
const msg = (id, text, to) => ({ id, role: "user", text, deliveredTo: to, createdAt: 1 });

/** 방을 열고, 줄 서 있는 것을 알려준다 */
function open(bots, messages, queued) {
  const t = mount();
  t.$(".room").click();
  t.send({
    t: "room", compactable: false,
    room: { id: "r1", title: "방", cwd: "/ws/proj", participants: bots,
            messages, unread: 0, createdAt: 1, lastActivityAt: 2 },
  });
  if (queued) t.send({ t: "queued", roomId: "r1", bots: queued });
  return t;
}

const bandOf = (t, at = 0) => t.$$("#screen-chat .msg")[at]?.querySelector(".meta.delivery");
const btn = (band, text) => [...band.querySelectorAll("button")].find((b) => b.textContent.includes(text));

console.log("\n[★ 줄 서 있으면 말풍선이 말해준다]");
{
  const t = open([bot("b1", "claude", "클로드")], [msg("u1", "급한 것", ["b1"])], { b1: ["u1"] });
  const band = bandOf(t);
  ok(band !== null && band !== undefined, "★ **띠가 붙는다** — 없으면 보낸 것과 구별이 안 된다");
  console.log(`   띠: ${band.querySelector(".held").textContent}`);
  ok(band.querySelector(".held").textContent.includes("앞 대화가 끝나면 보냅니다"),
     "★ 1:1 은 **무슨 일이 일어날지**로 적는다");
  ok(!band.querySelector(".held").textContent.includes("클로드"),
     "★ **1:1 에선 이름을 안 붙인다** — 상대가 하나뿐인데 적으면 읽을 것만 는다");
  ok(band.querySelector(".held").getAttribute("title")?.includes("끝나면"),
     "왜 기다리는지는 툴팁에");
}

console.log("\n[★ 단체방이면 누구를 기다리는지 적는다]");
{
  const t = open(
    [bot("b1", "claude", "알파"), bot("b2", "codex", "베타")],
    [msg("u1", "둘 다 봐줘", ["b1", "b2"])],
    { b2: ["u1"] },
  );
  const held = bandOf(t).querySelector(".held").textContent;
  console.log(`   띠: ${held}`);
  ok(held.includes("베타"), "★ **기다리는 봇을 이름으로** 짚는다");
  ok(!held.includes("알파"), "★ **안 기다리는 봇은 안 적는다** — 전부 막힌 걸로 읽히면 안 된다");
  ok(held.includes("대기 중"), "무슨 상태인지도 같이");
}

console.log("\n[★ 급할 때 쓸 두 길을 같이 준다]");
{
  const t = open([bot("b1", "claude", "클로드")], [msg("u1", "급한 것", ["b1"])], { b1: ["u1"] });
  const band = bandOf(t);
  const now = btn(band, "지금 보내기");
  const drop = btn(band, "빼기");
  ok(now !== undefined, "★ **지금 보내기** — 앞 턴을 끊고 보낸다");
  ok(drop !== undefined, "★ **빼기** — 안 보낸 것을 무른다");

  /*
   * 🔴 결과가 정반대인데 글자 길이가 비슷하다. 급하면 **옆엣것을 누른다** —
   * 모양이 다르면 글자를 다 읽기 전에 갈린다.
   */
  const iconOf = (b) => [...b.querySelectorAll("*")].map((e) => e.className).join(" ");
  console.log(`   아이콘: 보내기=${/send/.test(iconOf(now))} 빼기=${/close/.test(iconOf(drop))}`);
  ok(/send/.test(iconOf(now)) && /close/.test(iconOf(drop)),
     "★ **아이콘이 다르다** — 급할 때 글자만으로는 갈리지 않는다");
  ok(now.textContent.trim() !== "" && drop.textContent.trim() !== "",
     "★ **글자를 빼지는 않는다** — 아이콘만 두면 뜻을 툴팁으로 확인해야 한다");
  ok((drop.getAttribute("title") ?? "").includes("진행 중인 답변은 그대로"),
     "★ 빼기가 **진행 중인 턴을 안 끊는다**고 말해준다");
}

console.log("\n[★ 눌렀을 때 무엇이 가나]");
{
  const t = open(
    [bot("b1", "claude", "알파"), bot("b2", "codex", "베타")],
    [msg("u1", "급한 것", ["b1", "b2"])],
    { b2: ["u1"] },
  );
  btn(bandOf(t), "빼기").click();
  const un = t.sent.find((m) => m.t === "unqueue");
  console.log(`   빼기 → ${JSON.stringify(un)}`);
  ok(un?.messageId === "u1", "★ **그 메시지를** 뺀다");
  ok(un?.roomId === "r1", "어느 방인지도 실린다");

  const t2 = open(
    [bot("b1", "claude", "알파"), bot("b2", "codex", "베타")],
    [msg("u1", "급한 것", ["b1", "b2"])],
    { b2: ["u1"] },
  );
  btn(bandOf(t2), "지금 보내기").click();
  const ints = t2.sent.filter((m) => m.t === "interrupt").map((m) => m.botId);
  console.log(`   지금 보내기 → 끊은 봇: ${JSON.stringify(ints)}`);
  ok(ints.includes("b2"), "★ **기다리게 한 봇을** 끊는다");
  ok(!ints.includes("b1"), "★ **남의 턴은 안 끊는다** — 끼어들기는 남의 진행을 죽이는 일이다");
}

console.log("\n[★ 줄에서 빠지면 표시도 사라진다]");
{
  const t = open([bot("b1", "claude", "클로드")], [msg("u1", "급한 것", ["b1"])], { b1: ["u1"] });
  ok(bandOf(t) !== null, "줄에 서 있을 땐 있다");
  t.send({ t: "queued", roomId: "r1", bots: {} });
  console.log(`   빠진 뒤: ${bandOf(t) ? "남아 있다" : "없다"}`);
  ok(!bandOf(t), "★ **빠지면 바로 사라진다** — 남아 있으면 영영 기다리는 줄 안다");
}

console.log("\n[★ 안 선 말풍선엔 안 붙는다]");
{
  const t = open(
    [bot("b1", "claude", "클로드")],
    [msg("u1", "먼저 한 말", ["b1"]), msg("u2", "줄 선 말", ["b1"])],
    { b1: ["u2"] },
  );
  console.log(`   첫째: ${bandOf(t, 0) ? "붙었다" : "없다"} · 둘째: ${bandOf(t, 1) ? "붙었다" : "없다"}`);
  ok(!bandOf(t, 0), "★ **이미 간 말엔 안 붙는다**");
  ok(bandOf(t, 1) !== null && bandOf(t, 1) !== undefined, "★ 줄 선 말에만 붙는다");
}

console.log("\n전부 통과");
