/**
 * **참여자 서랍** — 봇에 관한 것이 모이는 자리 (§4.2.1을 v1.1로 앞당김).
 *
 * 이 파일이 지키는 것은 하나다: **봇마다인 것은 봇마다 보여야 한다.**
 * 컨텍스트 사용량·압축·역할·세션 id는 전부 세션에 붙은 값인데(B1) 방 단위로
 * 걸어두면 봇이 둘일 때 누구 것인지 알 수 없다 — 실제로 사용량은 나중에 온
 * 봇이 앞 봇의 숫자를 덮어쓰고 있었다.
 *
 * 뒤집어서, **메시지에 대한 것은 메시지에** 둔다. 말풍선 우클릭에 압축·중단·
 * 서랍까지 달았다가 걷어낸 이유다 — 전부 봇에 대한 것이라 서랍이 제자리다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 저장소 안에서 스스로 위치를 찾는다 — 절대경로를 박으면 남의 기계에서 안 돈다
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
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

const bot = (id, agentId, extra = {}, name) => ({
  id, agentId, name: name ?? agentId, sessionId: "s" + id, sessionPrompted: true,
  approver: { kind: "user" }, answerPolicy: "ask", ...extra,
});

const room = (bots, messages) => ({
  id: "r1", title: "방", cwd: "/ws/proj", participants: bots,
  messages: messages ?? [{ id: "u1", role: "user", text: "해줘", deliveredTo: [], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

/** 방을 열고 헤더의 참여자 버튼을 누른다 */
function open(t, bots, extra = {}) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: room(bots), compactable: false, ...extra });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  return t.$("#screen-bots");
}

/** 말풍선을 우클릭하고 메뉴를 돌려준다 */
function rightClick(t, at = 0) {
  const bubble = t.$$("#screen-chat .msg")[at];
  bubble.dispatchEvent(new t.w.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
  return t.$("#screen-chat .menu.at");
}

const labelsOf = (menu) => [...menu.querySelectorAll("button")].map((b) => b.textContent);
const pick = (menu, text) => [...menu.querySelectorAll("button")].find((b) => b.textContent === text);

console.log("\n[1:1에도 서랍이 있다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);
  ok(d !== null, "★ 봇이 하나여도 연다 — 단체방이 되면 **줄이 늘 뿐** 화면이 새로 안 생긴다");
  ok(d.textContent.includes("참여자 1"), "몇 명인지 적힌다");
  ok(d.querySelectorAll(".drawer-bot").length === 1, "봇 줄 하나");
  ok(!d.textContent.includes("/ws/proj"),
     "★ 방에 대한 것은 안 쌓는다 — 보러 온 봇이 아래로 밀리면 안 된다 (방 정보로)");
  /*
   * ⏪ **덮개가 없어졌다** (2026-09-30) — 서랍이 «화면»이 되면서다.
   *
   * 덮개는 «뒤를 깔아야 앞이 떠오른다» 는 물건이었다. 화면은 뒤에 아무것도
   * 안 비치므로 깔 것이 없다. 닫는 길은 머리줄의 뒤로가기다.
   */
  const outBtn = t.$("#screen-bots .bar button");
  ok(outBtn !== null, "★ 머리줄에 돌아가기가 있다");
  outBtn.click();
  ok(t.$$(".screen.active").map((x) => x.id).includes("screen-chat"),
     "★ **누르면 채팅으로 돌아온다** — 목록이 아니라 보던 방으로");
}

console.log("\n[컨텍스트 사용량은 **봇 이름 옆**에]");
{
  const t = mount();
  const d = open(t, [
    bot("b1", "claude", { usage: { contextUsed: 62000, contextSize: 100000 } }),
    bot("b2", "codex", { usage: { contextUsed: 21000, contextSize: 100000 } }),
  ]);
  const rows = d.querySelectorAll(".drawer-bot");
  ok(rows.length === 2, "봇 둘");
  ok(rows[0].querySelector(".who .usage").textContent.includes("62%"), "★ 첫 봇은 62%");
  ok(rows[1].querySelector(".who .usage").textContent.includes("21%"),
     "★ 둘째 봇은 21% — **서로 덮어쓰지 않는다**");
  ok(rows[0].querySelector(".usage").title.includes("62,000"),
     "정확한 토큰 수는 툴팁에 — 우리가 짐작한 값이 아니다");
  ok(!rows[0].querySelector(".usage").classList.contains("full"), "62%는 아직 경고가 아니다");
}

console.log("\n[안 알려주면 **비워둔다**]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);
  ok(d.querySelector(".usage") === null,
     "★ 글자 수로 토큰을 짐작하지 않는다 — 틀린 숫자는 없는 것보다 나쁘다");
}

console.log("\n[거의 찼으면 색이 변한다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude", { usage: { contextUsed: 95, contextSize: 100 } })]);
  ok(d.querySelector(".usage").classList.contains("full"), "★ 90%부터 — 압축이 곧 필요한 구간");
}

console.log("\n[압축은 **그 봇이 할 줄 알 때만**]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude"), bot("b2", "codex")],
                 { compactable: true, compactableBots: ["b2"] });
  const rows = d.querySelectorAll(".drawer-bot");
  const btn = (r) => [...r.querySelectorAll("button")].find((b) => b.textContent === "대화 압축");
  ok(btn(rows[0]) === undefined, "★ 명령을 안 내건 봇에는 안 붙는다");
  ok(btn(rows[1]) !== undefined, "내건 봇에만 붙는다");

  btn(rows[1]).click();
  const m = t.sent.at(-1);
  ok(m.t === "compact" && m.botId === "b2",
     `★ **누구를** 압축할지 실어 보낸다 (${JSON.stringify(m)})`);
}

console.log("\n[모델·역할·세션도 봇마다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude", { modelLabel: "Opus 5", rolePrompt: "리뷰어" })]);
  const r = d.querySelector(".drawer-bot");
  /*
   * 🔴 «Opus 5 · Claude» 읽기 전용 줄은 **뺐다** (2026-09-21).
   * 바로 아래 칸 둘(에이전트·모델)이 **같은 것을 고를 수 있게** 보여주므로,
   * 한 번 더 적는 것은 줄만 늘린다.
   */
  ok(![...r.querySelectorAll(".sub")].some((e) => e.textContent.includes("Opus 5 · Claude")),
     "★ 읽기 전용 «모델 · 에이전트» 줄은 없다 — 고를 수 있는 칸이 대신한다");
  ok(r.querySelector(".session-id").textContent === "sb1", "세션 id는 그 봇의 것");
  ok(r.querySelector("textarea.role").value === "리뷰어", "역할도 그 봇의 것");

  r.querySelector("textarea.role").value = "시인";
  [...r.querySelectorAll("button")].find((b) => b.textContent === "역할 저장").click();
  const m = t.sent.at(-1);
  ok(m.t === "setRole" && m.botId === "b1" && m.rolePrompt === "시인",
     `★ 저장도 봇을 지목해서 (${JSON.stringify(m)})`);
}

console.log("\n[★ 권한은 **입력창 옆 버튼 하나로만** 연다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);
  ok(t.$("#screen-chat .perm") !== null,
     "★ 방패 버튼을 없애지 않는다 — 켜둔 걸 잊으면 안 되는 종류라 보낼 때마다 보여야 한다");

  /*
   * 🔴 서랍에도 «권한 설정» 버튼이 있었는데 **뺐다** (2026-09-21).
   * 같은 화면으로 가는 문이 둘일 이유가 없고, 권한이 **어떤지**는
   * 바로 위의 한 줄이 이미 말한다.
   */
  ok([...d.querySelectorAll("button")].every((b) => b.textContent !== "권한 설정"),
     "★ 서랍에서는 뺐다 — 같은 곳으로 가는 문이 둘이 되지 않게");
  ok(d.querySelector(".drawer-bot .perm") !== null,
     "★ 대신 **어떤지는 한 줄로** 보인다 — 열어보지 않아도 된다");
}

console.log("\n[중단은 말풍선에 남고 **서랍에는 없다**]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming", b2: "idle" } });
  const acts = [...d.querySelectorAll(".role-acts button")].map((b) => b.textContent);
  ok(!acts.includes("중단"),
     `★ 서랍을 열고 봇을 찾는 사이에 답이 끝나면 버튼만 헛돈다 (${acts.join(",")})`);
  ok(acts.includes("내보내기") && acts.at(-1) === "역할 저장",
     `★ **역할 저장이 맨 오른쪽** — 나머지는 왼쪽에 붙는다 (${acts.join(" ")})`);
}

console.log("\n[헤더의 분기 버튼]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: room([bot("b1", "claude")]), compactable: false });
  const fork = t.$$("#screen-chat .bar button").find((b) => /분기/.test(b.title));
  ok(fork !== undefined && !fork.disabled, "★ ⋮ 안에 숨기지 않는다 — 대화를 보며 정하는 것이라");

  t.send({ t: "status", roomId: "r1", status: "streaming" });
  const busy = t.$$("#screen-chat .bar button").find((b) => /분기|끝난/.test(b.title));
  ok(busy.disabled === true, "★ 도는 중에는 죽여 둔다 — 지우면 «아까 있던 게 어디 갔지»가 된다");
  ok(busy.title.includes("응답이 끝난 뒤"), "왜 못 하는지 툴팁에");
}

console.log("\n[말풍선 우클릭 = **그 메시지**에 대한 것만]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({
    t: "room", compactable: true, compactableBots: ["b1"],
    room: room(
      [bot("b1", "claude", { usage: { contextUsed: 50, contextSize: 100 } }), bot("b2", "codex")],
      [{ id: "a1", role: "agent", authorBotId: "b1", createdAt: 1, deliveredTo: ["b1"],
         text: ["이렇게 고쳤습니다", "", "```ts", "const a = 1;", "```", "", "끝입니다."].join("\n") }],
    ),
  });
  const menu = rightClick(t);
  const labels = labelsOf(menu);

  ok(labels[0] === "복사", "★ 복사가 맨 위 — 여기서 제일 자주 하는 일");
  ok(labels.includes("코드만 복사"), "★ 붙여넣으려는 건 설명이 아니라 코드다");
  ok(!labels.some((x) => /중단|압축|서랍/.test(x)),
     `★ 봇에 대한 것은 **서랍으로 보냈다** — 헤더에 있는 걸 또 두면 «어디서 하지»만 남는다 (${labels.join(",")})`);

  let copied = "";
  t.w.navigator.clipboard = { writeText: (s) => ((copied = s), Promise.resolve()) };
  pick(menu, "코드만 복사").click();
  ok(copied === "const a = 1;", `★ 펜스를 걷어낸 알맹이만 (${JSON.stringify(copied)})`);
}

console.log("\n[코드가 없으면 «코드만 복사»도 없다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", compactable: false, room: room([bot("b1", "claude")],
    [{ id: "a1", role: "agent", authorBotId: "b1", text: "그냥 말", deliveredTo: ["b1"], createdAt: 1 }]) });
  const labels = labelsOf(rightClick(t));
  ok(!labels.includes("코드만 복사"), "★ 할 수 없는 걸 권하지 않는다");
  ok(labels.includes("복사"), "복사는 있고");
}

console.log("\n[분기는 남긴다 — 헤더가 못 하는 일이라서]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", compactable: false, room: room([bot("b1", "claude")],
    [{ id: "m1", role: "user", text: "처음 질문", deliveredTo: ["b1"], createdAt: 1 },
     { id: "m2", role: "agent", authorBotId: "b1", text: "답", deliveredTo: ["b1"], createdAt: 2 }]) });
  const btn = [...rightClick(t, 0).querySelectorAll("button")].find((b) => /분기/.test(b.textContent));
  ok(btn.textContent === "이 메시지에서 분기",
     "★ 헤더는 **대화 끝에서**, 여기는 **이 지점에서** — 이름으로 차이를 드러낸다");
  btn.click();
  ok(t.$("#screen-chat .card") !== null, "분기 다이얼로그가 뜬다");
}

console.log(String.fromCharCode(10) + "[★ 다중 봇 분기 — **누가 잃는지** 이름으로 물어본다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", compactable: false,
    room: room([bot("b1", "claude"), bot("b2", "codex")],
      [{ id: "m1", role: "user", text: "해줘", deliveredTo: ["b1"], createdAt: 1 }]) });
  t.send({ t: "caps", agentId: "claude", image: true, audio: true, embeddedContext: true, fork: "yes" });
  t.send({ t: "caps", agentId: "codex", image: true, audio: true, embeddedContext: true, fork: "no" });

  t.$$("#screen-chat .bar button").find((b) => /분기/.test(b.title)).click();
  const warn = [...t.$("#screen-chat .card").querySelectorAll(".warn-row")].map((n) => n.textContent).join(" ");
  ok(warn.includes("codex는 계획과 파일 기억을"),
     `★ **잃는 봇을 이름으로** 짚는다 — 누구에게 다시 설명할지 알아야 한다`);
  ok(!warn.includes("claude는 계획"), "★ 멀줦한 봇은 안 적는다");
  ok(warn.includes("나머지 봇은 그대로 갈라집니다"),
     "★ 전부 망했다고 읽히면 안 된다 — 성공분은 간다고 말해준다");
}

console.log(String.fromCharCode(10) + "[둘 다 분기를 하면 조용하다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", compactable: false,
    room: room([bot("b1", "claude"), bot("b2", "codex")],
      [{ id: "m1", role: "user", text: "해줘", deliveredTo: ["b1"], createdAt: 1 }]) });
  t.send({ t: "caps", agentId: "claude", image: true, audio: true, embeddedContext: true, fork: "yes" });
  t.send({ t: "caps", agentId: "codex", image: true, audio: true, embeddedContext: true, fork: "yes" });

  t.$$("#screen-chat .bar button").find((b) => /분기/.test(b.title)).click();
  const warn = [...t.$("#screen-chat .card").querySelectorAll(".warn-row")].map((n) => n.textContent).join(" ");
  ok(!warn.includes("물려받지 못합니다"), "★ 잃는 게 없으면 경고하지 않는다");
  ok(warn.length > 0, "파일 공유 경고는 남는다");
}

console.log(NL + "[★ 봇 부르기 — 방 만들 때와 같은 모양]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);
  const invite = [...d.querySelectorAll("button")].find((b) => /부르기/.test(b.textContent));
  ok(invite !== undefined, "★ 1:1 방에도 있다 — 그 자리에서 단체방이 된다");
  ok(!d.textContent.includes("내보내기"),
     "★ 봇이 하나면 내보내기를 안 보여준다");

  invite.click();
  const card = t.$("#screen-invite .card");
  ok(card !== null, "★ 드롭다운이 아니라 **제 화면이 뜬다** (2026-09-30)");
  ok(t.$$(".screen.active").map((x) => x.id).includes("screen-invite"),
     "★ **참여자 위에 얹힌다** — 부르고 나면 뒤로가기 하나로 참여자로 돌아온다");
  /*
   * ⏪ **여기만 단추 줄이었다** (2026-10-07). 사용자가 짚었다 —
   * 방 만들기는 드롭다운인데 부르기만 줄지어 놓은 단추였다.
   * `agentSelect` 에 *"에이전트는 드롭다운으로"* 라고 적어두고 빠뜨렸다.
   */
  const pick = card.querySelector("select.agent-pick");
  ok(pick !== null, "★ **드롭다운으로 고른다** — 방 만들 때와 같은 모양");
  ok(pick.options.length === 2, "받아둔 것만 들어 있다");
  ok(card.querySelector("textarea.role") !== null,
     "★ 역할도 여기서 — 모델·역할은 봇에 붙는 값이다");

  card.querySelector("textarea.role").value = "너는 리뷰어";
  card.querySelector("textarea.role").dispatchEvent(new t.w.Event("input"));
  pick.value = "codex";
  pick.dispatchEvent(new t.w.Event("change"));
  const after = t.$("#screen-invite .card");
  [...after.querySelectorAll("button")].find((b) => b.textContent === "부르기").click();

  /*
   * 🔴 `at(-1)` 로 집다가 깨졌다 (2026-09-30). 서랍이 화면이 된 뒤로 부른 다음
   * **설정을 다시 묻는 줄**(`needConfig`)이 뒤에 붙는다. 마지막이 아니라
   * **찾는 것**으로 집는다 — 순서에 기대면 옆에서 한 줄만 더 보내도 깨진다.
   */
  const m = t.sent.find((x) => x.t === "addBot");
  ok(m?.t === "addBot" && m.agentId === "codex",
     `★ 고른 에이전트로 부른다 (${JSON.stringify(m)})`);
  ok(m?.rolePrompt === "너는 리뷰어",
     "★ 역할도 같이 간다 — 부른 뒤에 따로 찾아가게 하지 않는다");
}

console.log(NL + "[부르기 전에 **무엇을 모를지** 말해준다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);
  [...d.querySelectorAll("button")].find((b) => /부르기/.test(b.textContent)).click();
  const warn = t.$("#screen-invite .card .warn-row");
  ok(warn !== null && warn.textContent.includes("위 대화를 모릅니다"),
     "★ 화면에는 보이니 «알겠지»로 믿는다 — 그게 이 설계의 유일한 위험이다");
}

console.log(NL + "[봇이 둘이면 내보낼 수 있다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  const rows = d.querySelectorAll(".drawer-bot");
  const drop = [...rows[1].querySelectorAll("button")].find((b) => b.textContent === "내보내기");
  ok(drop !== undefined, "봇 줄마다 붙는다");
  drop.click();
  const m = t.sent.at(-1);
  ok(m.t === "removeBot" && m.botId === "b2",
     `★ **그 봇만** 빠진다 (${JSON.stringify(m)})`);
}

console.log(String.fromCharCode(10) + "[봇이 둘이면 내보낼 수 있다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  const rows = d.querySelectorAll(".drawer-bot");
  const drop = [...rows[1].querySelectorAll("button")].find((b) => b.textContent === "내보내기");
  ok(drop !== undefined, "봇 줄마다 붙는다");
  drop.click();
  const m = t.sent.at(-1);
  ok(m.t === "removeBot" && m.botId === "b2",
     `★ **그 봇만** 빠진다 (${JSON.stringify(m)})`);
}

console.log(String.fromCharCode(10) + "[★ 사용량은 숫자만 — 말풍선 이름 옆에도]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude", { usage: { contextUsed: 62, contextSize: 100 } })]);
  const chip = d.querySelector(".usage");
  ok(chip.textContent === "62%",
     `★ 서랍은 숫자만 (${chip.textContent})`);
  ok(chip.querySelector(".bar") === null,
     "★ 막대는 뺀다 — 숫자가 이미 정확한데 그림은 같은 말을 흐릿하게 할 뿐이다");
  ok(chip.title.includes("토큰"), "정확한 수는 툴팁에");
}

console.log(String.fromCharCode(10) + "[말풍선 이름 옆에 퍼센트]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({
    t: "room", compactable: false,
    room: room(
      [bot("b1", "claude", { usage: { contextUsed: 77, contextSize: 100 } })],
      [{ id: "a1", role: "agent", authorBotId: "b1", text: "고쳤습니다", deliveredTo: ["b1"], createdAt: 1 }],
    ),
  });
  const who = t.$("#screen-chat .msg .who");
  ok(who.textContent.includes("77%"),
     `★ 서랍을 안 열어도 보인다 — 다 차고 나서 보면 이미 압축이 돌아간 뒤다 (${who.textContent})`);
}

console.log(String.fromCharCode(10) + "[90%를 넘으면 붉어진다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude", { usage: { contextUsed: 95, contextSize: 100 } })]);
  ok(d.querySelector(".usage").classList.contains("full"),
     "★ 그때부터 «압축»이 곯 필요해지는 구간이다");
}

console.log(String.fromCharCode(10) + "[★ 말풍선은 **봇 이름**을 쓴다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  // 같은 에이전트로 봇 둘 — 에이전트 라벨로 그리면 둘을 구별 못 한다
  t.send({
    t: "room", compactable: false,
    room: room(
      [bot("b1", "claude", {}, "알파"), bot("b2", "claude", {}, "알파 2")],
      [{ id: "a1", role: "agent", authorBotId: "b2", text: "넣습니다", deliveredTo: ["b2"], createdAt: 1 }],
    ),
  });
  const who = t.$("#screen-chat .msg .who").textContent;
  ok(who.includes("알파 2"),
     `★ 말한 봇의 이름이 나온다 (${who}) — 에이전트 라벨이면 둘 다 «알파»다`);
}

console.log(String.fromCharCode(10) + "[★ 방 정보는 팔업이다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: room([bot("b1", "claude")]), compactable: false });
  t.$("#screen-chat .bar button:last-child").click();
  t.$$("#screen-chat .menu button").find((b) => b.textContent === "방 정보").click();

  ok(t.$("#screen-chat .modal") !== null,
     "★ 대화에 붙지 않고 떠오른다 — 보고 닫는 것이지 답할 것이 아니다");
  ok(t.$("#screen-chat .messages .card") === null,
     "★ 말풍선 사이에 끼지 않는다 — 스크롤에 밀리면 기록처럼 읽힌다");
  t.$("#screen-chat .modal-veil").click();
  ok(t.$("#screen-chat .modal") === null, "덮개를 누르면 닫힌다");
}

console.log(String.fromCharCode(10) + "[★ 방 정보 · 저장 위치 (사용자, 2026-10-20)]");
{
  /*
   * 경로는 호스트만 안다 — 열 때 묻고, 답이 오면 채운다. 단추는 **열지 않고 선택만**
   * 한다(revealRoomFile) — 열린 방의 기록을 손으로 고치면 깨지거나 덮인다.
   */
  const t = mount();
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: room([bot("b1", "claude")]), compactable: false });
  t.sent.length = 0;
  t.$("#screen-chat .bar button:last-child").click();
  t.$$("#screen-chat .menu button").find((b) => b.textContent === "방 정보").click();

  const ask = t.sent.filter((m) => m.t === "roomFileAsk");
  ok(ask.length === 1 && ask[0].roomId === "r1", `★ 열 때 경로를 묻는다 (${JSON.stringify(ask)})`);
  const rows = () => t.$$("#screen-chat .modal .info-row");
  const fileRow = () => rows().find((r) => r.textContent.startsWith("저장 위치"));
  ok(fileRow() !== undefined, "★ «저장 위치» 줄이 있다");
  ok(/…/.test(fileRow().querySelector(".room-file").textContent), "★ 답이 오기 전에는 «…»");

  const p = "C:\\Users\\me\\globalStorage\\taein-yoon.ai-in-one\\rooms\\r1.jsonl";
  t.send({ t: "roomFile", roomId: "r1", path: p });
  ok(fileRow().querySelector(".room-file").textContent === p, "★ 답이 오면 그 경로가 선다");
  ok(/blobs/.test(fileRow().textContent) && /손으로 고치면/.test(fileRow().textContent),
     "★ **그 파일이 전부가 아니라는 것**과 손으로 고치지 말라는 것을 같이 적는다");

  t.sent.length = 0;
  [...fileRow().querySelectorAll("button")].find((b) => /폴더에서 보기/.test(b.textContent)).click();
  ok(t.sent.length === 1 && t.sent[0].t === "revealRoomFile" && t.sent[0].roomId === "r1",
     `★ **폴더에서 보기** — 열지 않고 선택만 (${JSON.stringify(t.sent)})`);

  // 남의 방 답은 안 덮는다
  t.send({ t: "roomFile", roomId: "다른방", path: "X" });
  ok(fileRow().querySelector(".room-file").textContent === p, "★ 다른 방의 답은 이 줄을 안 바꾼다");
}

console.log("\n[★ 갱신될 때 서랍이 다시 나타나지 않는다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  /*
   * ⏪ **`.opening` 이 없어졌다** (2026-09-30).
   *
   * 서랍일 때는 «열 때만 밀려 들어오고 갱신 때는 가만히» 를 클래스로 갈랐다 —
   * 갱신이 새 엘리먼트로 갈아끼우는 것이라 매번 다시 슬라이드됐기 때문이다.
   * 화면이 되면서 **그 문제 자체가 없어졌다.** 뜨고 지는 것은 스택이 한다.
   *
   * 아래 «갱신돼도 다시 안 나타난다» 는 그대로 잰다 — 뜻은 안 바뀌었다.
   */
  ok(t.$$(".screen.active").map((x) => x.id).includes("screen-bots"),
     "★ 참여자 화면이 떴다");

  // 상태가 오면 서랍도 같이 갱신된다 (사용량·작업 중 표시가 멈추면 안 되므로)
  t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming" } });
  const now = t.$("#screen-bots");
  ok(now !== null, "서랍은 그대로 열려 있고");
  ok(!now.classList.contains("opening"),
     "★ **다시 슬라이드되지 않는다** — 갱신은 갈아끼우기라 애니메이션이 매번 다시 돌았다");
}

console.log("\n[★ 갱신돼도 보던 자리를 지킨다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  d.scrollTop = 40;
  t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming" } });
  ok(t.$("#screen-bots").scrollTop === 40,
     "★ 갈아끼우면 맨 위로 돌아간다 — 보던 자리를 옮긴다");
}

console.log("\n[★ 글을 쓰는 중이면 안 건드린다]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);

  // 역할을 쓰는 중
  const box = d.querySelector(".role-edit textarea");
  box.value = "리뷰만 해";
  box.focus();

  t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming" } });
  ok(t.$("#screen-bots .role-edit textarea") === box,
     "★ **같은 엘리먼트 그대로다** — 갈아끼우면 쓰던 글과 캐럿이 날아간다");
  ok(t.$("#screen-bots .role-edit textarea").value === "리뷰만 해", "쓰던 글도 그대로");
}

console.log("\n[★ 이름을 고치는 중에도 마찬가지]");
{
  const t = mount();
  const d = open(t, [bot("b1", "claude")]);
  d.querySelector(".drawer-bot .who .icon.tiny").click();
  const input = t.$(".drawer-bot .who input");
  input.value = "리뷰어";

  t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming" } });
  ok(t.$(".drawer-bot .who input")?.value === "리뷰어",
     "★ 고치던 이름이 안 날아간다");
}

console.log("\n전부 통과");
