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
  t.send({ t: "joinDone", roomId: "r1" });
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

console.log("\n[⑦ ★ 위로 올라가 있으면 «맨 아래로» 가 뜬다 (2026-10-15)]");
{
  /*
   * 🔴 사용자: *"스크롤으로 위로 올라가면, 아래로 내려갈 수 있는 버튼 만들기"*.
   * 긴 대화를 훑다 보면 **바닥으로 돌아갈 길이 손가락뿐**이고, 봇이 답하는
   * 중이면 그 사이에도 내용이 자라 끝이 멀어진다.
   *
   * «읽던 자리로»와 **같은 띠·같은 모양**이다 — 하는 일이 같으므로.
   */
  const t = mount();
  open(t, room([M, A, N, A2, B]));
  const list = t.$("#screen-chat .messages");
  const down = t.$("#screen-chat .back-jump.to-bottom");
  ok(down !== null && down.hidden === true, "★ 바닥에 있으면 안 뜬다");

  /* jsdom 은 배치가 없으므로 «한 화면 넘게 올라가 있다»를 손으로 만든다 */
  Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
  list.scrollTop = 500;
  list.dispatchEvent(new t.w.Event("scroll", { bubbles: true }));

  console.log(`   띠 : hidden=${down.hidden} · «${down.textContent}»`);
  ok(down.hidden === false, "★ **올라가 있으면 뜬다**");
  ok(down.textContent.includes("맨 아래로"), "★ 어디로 가는지 말한다");

  down.querySelector("button").click();
  ok(list.scrollTop === 2000, "★ 누르면 **바닥으로**");
  ok(down.hidden === true, "★ 가고 나면 띠도 걷는다");
}

console.log("\n[★ 봇이 먼저 보낸 말은 어느 경우든 «한 줄»]");
{
  /*
   * 봇은 질문 없이도 말한다 — 백그라운드 일이 끝나면 턴이 닫힌 뒤에 제 발로
   * 알려온다(실측). 그 말풍선은 `replyToIds` 가 **없다.**
   *
   * 🔴 한때 깨운 활동을 짚어 ««빌드 돌려놔줘»의 «npm run build»가 끝났습니다»
   * 까지 보여줬다. 실제로 짚였다. 그런데 **그 실이 우연에 가깝다** — 에이전트가
   * 결과를 말하려고 출력 파일을 «읽어주기 때문»이지 프로토콜이 이어준 것이
   * 아니다. 그러면 **같은 종류의 말풍선이 어떤 날은 가리키고 어떤 날은 안
   * 가리킨다** — 사용자는 그 차이를 알 수 없고, 있을 때는 믿게 된다.
   *
   * 그래서 **늘 같은 한 줄**이다. 여기서는 «짚였을 때도 안 가리킨다»를 잰다 —
   * 그게 이 결정의 전부이고, 안 재면 슬그머니 되돌아온다.
   */
  const cases = [
    ["짚였을 때", { afterIds: ["m"], afterToolId: "bg1" }],
    ["못 짚었을 때", {}],
  ];
  for (const [label, extra] of cases) {
    const t = mount();
    const ran = { ...A, tools: [{ id: "bg1", title: "Terminal", kind: "execute",
                                  status: "completed", command: "npm run build",
                                  output: "…written to: /x/tasks/bxgz.output" }] };
    const spur = { id: "sp", role: "agent", text: "빌드 끝났어",
                   authorBotId: "b1", deliveredTo: ["b1"], createdAt: 60, ...extra };
    open(t, room([M, ran, N, A2, spur]));

    const last = t.$$("#screen-chat .msg")[4];
    const note = [...last.querySelectorAll(".meta")].find((x) => x.textContent.startsWith("↩"));
    console.log(`   ${label} : ${note.textContent}`);

    ok(note.textContent === "↩ 봇이 먼저 보냈습니다",
       `★ ${label}도 **같은 한 줄** — 어떤 날만 달라 보이면 그 차이를 믿게 된다`);
    ok(note.querySelector("button") === null,
       `★ ${label}도 **아무 데도 안 가리킨다**`);
    ok(!note.textContent.includes("답합니다"),
       `★ ${label}도 «답합니다»가 안 섞인다 — 묻지 않은 것에 답이라 하면 거짓말이다`);
  }
}

console.log("\n전부 통과");
