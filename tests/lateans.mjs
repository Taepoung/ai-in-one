/**
 * **늦게 받은 봇의 답은 화면에서 어떻게 보이나** (2026-09-23).
 *
 * 시나리오는 이렇다:
 *
 *   M  «이 코드 봐줘»   → 구현·리뷰어 둘에게
 *      구현은 바로 받고, 리뷰어는 **바빠서 줄에 선다**
 *   구현의 답
 *   N  «그리고 저것도»   ← 그 사이에 새 말이 들어간다
 *   …
 *   리뷰어의 답          ← 이제야 M 을 받고 답한다
 *
 * 재는 것 세 가지:
 *   ① M 이 자리를 지키는가 (`placedAt`) — 한 명이라도 받았으면 거기다
 *   ② 리뷰어의 답에 «뭐에 대한 답인지»가 붙는가 (`needsAnswerNote`)
 *   ③ **그 표시를 눌러서 되돌아갈 수 있는가**
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 저장소 안에서 스스로 위치를 찾는다 — 절대경로를 박으면 남의 기계에서 안 돈다
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
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

const bot = (id, agentId, name) => ({
  id, agentId, name, sessionId: "s" + id,
  approver: { kind: "user" }, answerPolicy: "ask",
});
const BOTH = [bot("b1", "claude", "구현"), bot("b2", "codex", "리뷰어")];
const room = (messages) => ({
  id: "r1", title: "방", cwd: "/ws", participants: BOTH, messages,
  unread: 0, createdAt: 1, lastActivityAt: 2,
});
function open(t, r) {
  t.$(".room").click();
  t.send({ t: "room", room: r, compactable: false });
}

/*
 * ── 시나리오 ──────────────────────────────────────────────────────
 * M 은 둘에게 갔지만 **구현만 받았다** (placedAt=10).
 * N 은 그 뒤에 구현에게 갔다 (placedAt=30).
 * 그리고 리뷰어가 이제야 M 에 답한다.
 */
const M = { id: "m", role: "user", text: "이 코드 좀 봐줘, 특히 에러 처리가 걱정돼",
            deliveredTo: ["b1"], createdAt: 10, placedAt: 10 };
const A = { id: "a", role: "agent", text: "봤어. 에러 처리는 괜찮아 보여",
            authorBotId: "b1", deliveredTo: ["b1"], replyToIds: ["m"], createdAt: 20 };
const N = { id: "n", role: "user", text: "그리고 테스트도 봐줘",
            deliveredTo: ["b1"], createdAt: 30, placedAt: 30 };
const A2 = { id: "a2", role: "agent", text: "테스트도 봤어",
             authorBotId: "b1", deliveredTo: ["b1"], replyToIds: ["n"], createdAt: 40 };
const B = { id: "b", role: "agent", text: "나는 이제 봤는데, 세 군데가 걸려",
            authorBotId: "b2", deliveredTo: ["b2"], replyToIds: ["m"], createdAt: 50 };

console.log("\n[① M 이 자리를 지키나 — 한 명이라도 받았으면 거기다]");
{
  const t = mount();
  open(t, room([M, A, N, A2, B]));
  const order = t.$$("#screen-chat .msg").map((n) => n.textContent.slice(0, 12));
  console.log("   화면 순서:", order.map((s) => `«${s.replace(/\s+/g, " ")}…»`).join("  "));
  ok(order.length === 5, `말풍선 다섯 (${order.length})`);
  ok(/이 코드/.test(order[0]), "★ **M 이 맨 위 그대로** — 늦게 받은 봇 때문에 안 내려간다");
  ok(/이제 봤는데/.test(order[4]), "★ 리뷰어의 답은 맨 아래 — 실제로 그때 온 것이므로");
}

console.log("\n[② «뭐에 대한 답인지»가 붙나]");
{
  const t = mount();
  open(t, room([M, A, N, A2, B]));
  const notes = t.$$("#screen-chat .msg").map((n) => {
    const metas = [...n.querySelectorAll(".meta")].map((x) => x.textContent);
    return metas.find((x) => x.startsWith("↩"));
  });
  console.log("   답장 표시:", JSON.stringify(notes));

  ok(notes[1] === undefined,
     "★ **바로 밑 답에는 안 붙는다** — 자명한 데 붙이면 군더더기다");
  ok(typeof notes[4] === "string" && notes[4].includes("이 코드"),
     `★ **멀어진 답에는 붙는다** (${notes[4]}) — 이게 오늘 이미 되는 부분`);
}

console.log("\n[③ ★ 눌러서 찾아간다]");
{
  const t = mount();
  open(t, room([M, A, N, A2, B]));
  const last = t.$$("#screen-chat .msg")[4];
  const note = last.querySelector(".answer-note");

  const jumps = [...note.querySelectorAll("button.jump")];
  console.log(`   표시 : ${note.textContent}`);
  console.log(`   단추 : ${jumps.map((b) => b.textContent).join(" | ")}`);

  ok(jumps.length === 1, `★ **발췌가 곧 누를 대상** (${jumps.length}개)`);
  ok(jumps[0].textContent === "«이 코드 좀 봐줘, 특히 에러 처리가…»",
     "★ 발췌는 20자에서 줄인다 — 여럿이 한 줄에 서야 하므로");
  ok(jumps[0].getAttribute("title") === M.text,
     "★ **잘린 뒤는 툴팁에 통째로** — 짧은 발췌로 못 알아볼 때가 있다");
  ok(note.textContent.endsWith("에 답합니다"),
     `★ 조사가 알약에 붙어 있다 (${note.textContent.slice(-8)}) — 사이가 벌어지면 글이 끊긴다`);

  /*
   * jsdom 에는 배치가 없어 사각형이 전부 0 이다 = «이미 보인다». 그래서
   * **스크롤은 안 하고 깜빡이기만** 해야 한다 — 바로 그 규칙을 여기서 잰다.
   */
  jumps[0].click();
  const lit = t.$$("#screen-chat .msg.jumped");
  ok(lit.length === 1, `★ **하나만 깜빡인다** (${lit.length})`);
  ok(/이 코드/.test(lit[0].textContent), "★ 그리고 그게 그 질문이다");
  ok(t.$("#screen-chat .back-jump").hidden === true,
     "★ **이미 보이면 띠도 안 뜬다** — 화면이 안 움직였으니 돌아갈 데도 없다");
}

console.log("\n[④ ★ 묶여서 답하면 질문마다 하나씩]");
{
  const t = mount();
  const both = { ...B, replyToIds: ["m", "n"] };
  open(t, room([M, A, N, A2, both]));
  const note = t.$$("#screen-chat .msg")[4].querySelector(".answer-note");
  const jumps = [...note.querySelectorAll("button.jump")];
  console.log(`   표시 : ${note.textContent}`);

  ok(jumps.length === 2,
     `★ **«2개»가 아니라 둘 다 보여준다** (${jumps.length}) — 여기가 제일 헷갈리는 자리다`);
  ok(note.textContent.endsWith("에 한 번에 답합니다"), "★ 둘 이상이면 «한 번에»를 붙인다");

  jumps[1].click();
  ok(/그리고 테스트도/.test(t.$("#screen-chat .msg.jumped").textContent),
     "★ **각자 제 질문으로** 간다");

  // 앞서 켠 것이 남으면 «어느 쪽이지»가 된다
  jumps[0].click();
  ok(t.$$("#screen-chat .msg.jumped").length === 1,
     "★ **둘이 같이 켜지지 않는다** — 다음 것을 누르면 앞엣것은 꺼진다");
}

console.log("\n[⑤ ★ 사라진 질문은 단추로 안 둔다]");
{
  /*
   * 압축(C11)으로 질문이 없어졌을 수 있다. 눌러도 아무 일이 없는 단추를 두면
   * «고장»으로 읽히므로, 그때는 옛 문구로 떨어진다.
   */
  const t = mount();
  const ghost = { ...B, replyToIds: ["없는것"] };
  open(t, room([M, A, N, A2, ghost]));
  const last = t.$$("#screen-chat .msg")[4];
  const note = [...last.querySelectorAll(".meta")].find((x) => x.textContent.startsWith("↩"));
  console.log(`   표시 : ${note.textContent}`);

  ok(note.querySelector("button") === null,
     "★ **못 가는 곳으로 가는 단추는 안 만든다**");
  ok(note.textContent === "↩ 앞선 질문에 답합니다",
     "★ 그래도 «무언가에 답했다»는 남긴다 — 답이 허공에서 온 것처럼 보이면 안 된다");
}

console.log("\n[⑥ ★ 화면 밖이면 «읽던 자리로»가 뜬다]");
{
  const t = mount();
  open(t, room([M, A, N, A2, B]));
  const list = t.$("#screen-chat .messages");
  const target = t.$$("#screen-chat .msg")[0];

  // jsdom 엔 배치가 없으므로 «위로 한참 벗어나 있다»를 손으로 만들어준다
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400, left: 0, right: 0, width: 0 });
  target.getBoundingClientRect = () => ({ top: -80, bottom: -20, height: 60, left: 0, right: 0, width: 0 });

  t.$("#screen-chat .answer-note button.jump").click();

  const band = t.$("#screen-chat .back-jump");
  console.log(`   띠 : hidden=${band.hidden} · «${band.textContent}»`);
  ok(band.hidden === false,
     "★ **화면이 움직였으니 돌아갈 길을 준다** — 없으면 찾아가기가 덫이 된다");
  ok(band.querySelector("button") !== null && band.textContent.includes("읽던 자리"),
     "★ 무엇으로 돌아가는지 말한다 — «돌아가기»만으로는 어디로인지 모른다");

  band.querySelector("button").click();
  ok(band.hidden === true, "★ 돌아가면 띠도 걷는다");
}

console.log("\n[★ 봇이 먼저 보낸 말은 «답합니다»가 아니다]");
{
  /*
   * 봇은 질문 없이도 말한다 — 백그라운드 일이 끝나면 턴이 닫힌 뒤에 제 발로
   * 알려온다(실측). 그 말풍선은 `replyToIds` 가 **없고** `afterIds` 만 있다.
   *
   * 🔴 같은 «↩ «…»» 을 쓰되 **꼬리말이 달라야 한다.** «답합니다»라고 쓰면
   * 거짓말이 된다 — 사용자는 그 질문을 한 적이 없다.
   */
  const t = mount();
  const spur = { id: "sp", role: "agent", text: "다 됐어. 결과는 42야",
                 authorBotId: "b1", deliveredTo: ["b1"], afterIds: ["m"], createdAt: 60 };
  open(t, room([M, A, N, A2, spur]));

  const note = t.$$("#screen-chat .msg")[4].querySelector(".answer-note");
  console.log(`   표시 : ${note.textContent}`);

  ok(note.textContent.endsWith("에서 이어집니다"),
     `★ **«에서 이어집니다»** (${note.textContent.slice(-9)}) — 묻지 않은 것에 «답합니다»는 거짓말이다`);
  ok(!note.textContent.includes("답합니다"), "★ «답합니다»가 안 섞인다");

  const jump = note.querySelector("button.jump");
  ok(jump !== null, "★ 그래도 **눌러서 갈 수 있다** — 답장 칩과 같은 장치를 쓴다");
  jump.click();
  ok(/이 코드/.test(t.$("#screen-chat .msg.jumped").textContent),
     "★ 그 일을 시킨 **원래 요청**으로 간다");
}

console.log("\n전부 통과");
