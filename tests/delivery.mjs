/**
 * **누구에게 갔나** (§4.1.1) · **아직 줄에 서 있나** (§4.3).
 *
 * §4.1.1이 «이 설계의 유일한 위험»이라 못 박은 게 «화면엔 다 보이는데 봇은
 * 서로 모른다»다. 우리는 멘션된 봇에게만 전달하므로 단체방의 말풍선은
 * **보이는 것보다 좁게** 갔다.
 *
 * 🔴 처음에는 그걸 말풍선 **아래** «→ Claude» 한 줄로 적었다. **안 읽혔다** —
 * 10px 회색 글씨가 말풍선 밖에 붙으면 눈이 그냥 지나간다. 막으려고 넣은
 * 표시가 안 읽히면 **없는 것과 같다.** 그래서 **쓸 때 보이던 칩 그대로**
 * 말풍선 안으로 옮겼다. 아래 줄에는 **곧 사라질 상태**만 남는다.
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

const room = (bots, messages) => ({
  id: "r1", title: "방", cwd: "/ws", participants: bots, messages,
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

const BOTH = [bot("b1", "claude", "Claude"), bot("b2", "codex", "Codex")];
const msg = (id, to, extra = {}) =>
  ({ id, role: "user", text: "이 코드 봐줘", deliveredTo: to, createdAt: 1, ...extra });

function open(t, r) {
  t.$(".room").click();
  t.send({ t: "joinDone", roomId: "r1" });
  t.send({ t: "room", room: r, compactable: false });
}

/** 말풍선 안의 받는 이 칩들 */
const toChips = (t) => t.$$("#screen-chat .msg.user .bubble .chip.to");

console.log("\n[★ 받는 이가 말풍선 «안»에 칩으로 있다]");
{
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1"])]));

  const chips = toChips(t);
  ok(chips.length === 1, "★ 받은 봇만큼 칩이 하나");
  ok(chips[0].textContent === "@Claude",
     `★ **쓸 때 보이던 칩 그대로** (${chips[0].textContent}) — 입력창과 말풍선이 같아진다`);
  ok(t.$("#screen-chat .msg.user .bubble").textContent.includes("이 코드 봐줘"),
     "글도 그대로");
  ok(t.$("#screen-chat .delivery") === null,
     "★ **아래 작은 줄은 없다** — 안 읽히는 자리였고, 이제 말풍선이 말한다");
}

console.log("\n[★ 글과 한 줄로 흐른다 — 머리말이 아니다]");
{
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1"])]));
  const para = t.$("#screen-chat .msg.user .bubble p");
  ok(para !== null, "문단이 있다");
  ok(para.querySelector(".chip.to") !== null,
     "★ **첫 문단 안에** 꽂힌다 — 말풍선에 그냥 붙이면 칩이 자기 줄을 차지한다");
  ok(para.firstChild.textContent.includes("@Claude"), "★ 글 맨 앞에");
}

console.log("\n[★ 안 받은 봇은 안 나온다]");
{
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1"])]));
  ok(!toChips(t).some((c) => c.textContent.includes("Codex")),
     "★ 화면에 보인다고 Codex가 아는 게 아니다 (§4.1.1)");
}

console.log("\n[셋 중 둘에게 간 것은 칩이 둘 — 쓴 순서 그대로]");
{
  const t = mount();
  /*
   * ⏪ 예전에는 «둘 다에게 간 것»으로 이걸 쟀는데, **전원이면 이제 @everyone
   * 한 장으로 접힌다**(아래). 그래서 봇을 하나 더 두어 «전원이 아닌 여럿»으로
   * 다시 잰다 — 접히지 않는 쪽의 순서 보장은 그대로 지켜야 한다.
   */
  const three = [...BOTH, bot("b3", "claude", "Gemini")];
  open(t, room(three, [msg("u1", ["b1", "b2"])]));
  ok(toChips(t).map((c) => c.textContent).join(" ") === "@Claude @Codex",
     `★ 쓴 순서 그대로 (${toChips(t).map((c) => c.textContent).join(" ")})`);
}

console.log("\n[★ ⏪ 1:1에서도 칩이 붙는다 (2026-09-23 정정)]");
{
  /*
   * 🔴 *"상대가 하나뿐이라 자명하다"* 고 안 붙였는데 — **1:1 방은 도중에
   * 단체방이 된다**(§4.2). 봇을 하나 부르면 참여자가 둘이 되고, 그 순간
   * **지난 말풍선들이 갑자기 칩을 얻었다.** 과거 기록의 생김새가 나중 일
   * 때문에 바뀌는 셈이다 — 그건 일관성이 아니라 그 반대다.
   */
  const t = mount();
  open(t, room([bot("b1", "claude", "Claude")], [msg("u1", ["b1"])]));
  ok(toChips(t).map((c) => c.textContent).join() === "@Claude",
     `★ **한 명이어도 한 장** (${toChips(t).map((c) => c.textContent).join()}) — 나중에 봇을 불러도 이 말풍선은 그대로다`);
}
console.log("\n[★ 에이전트의 말에는 안 붙는다]");
{
  const t = mount();
  open(t, room(BOTH, [
    { id: "a1", role: "agent", authorBotId: "b1", text: "했어", deliveredTo: [], createdAt: 1 },
  ]));
  ok(t.$("#screen-chat .chip.to") === null,
     "★ 봇의 말은 **아무에게도 안 간다**(§4.1.1). §4.4가 «v2.0은 표시 없음»으로 정했다");
}

console.log("\n[★ 프롬프트는 안 건드린다 — 그릴 때만 만든다]");
{
  const t = mount();
  const r = room(BOTH, [msg("u1", ["b1", "b2"])]);
  open(t, r);
  ok(r.messages[0].text === "이 코드 봐줘",
     "★ **`Message.text`에 칩을 안 넣는다** — 넣으면 에이전트에게 가는 글이 바뀌고, 여럿에게 간 블록이면 «Codex도 받았다»를 Claude에게 알려주는 꼴이 된다");
}

console.log("\n[★ 한 명이라도 받았으면 제자리 — 답이 질문 위로 가면 안 된다]");
{
  /*
   * 🔴 «대기 중이면 바닥»만 보면 단체방에서 깨진다. 한 말이 **한 봇에게는 가고
   * 한 봇은 기다리는** 일이 흔한데, 그때도 바닥으로 내리면 답이 질문 위에 놓인다.
   *
   * 자리를 정하는 것은 «**대화에 들어온 시각**»이다 — 한 명이라도 받았으면
   * 이미 들어온 것이다.
   */
  const t = mount();
  open(t, room(BOTH, [
    { id: "u1", role: "user", text: "둘 다 봐줘", deliveredTo: ["b1", "b2"],
      placedAt: 5, createdAt: 5 },
    { id: "a1", role: "agent", text: "구현의 답", authorBotId: "b1",
      deliveredTo: ["b1"], createdAt: 6 },
  ]));
  const order = t.$$("#screen-chat .msg .bubble")
    .map((n) => n.textContent.replace(/[@][^ ]+ ?/g, "").trim());
  ok(order[0] === "둘 다 봐줘" && order[1] === "구현의 답",
     `★ **질문이 답 위에** (${order.join(" | ")}) — 자리를 정하는 것은 «대화에 들어온 시각»이다`);
}

console.log("\n[★ 보내고 나면 그 자리에 머문다 — 위로 안 튄다]");
{
  /*
   * 🔴 «대기 중이면 맨 아래»만으로는 부족하다. 보내는 순간 조건이 풀려
   * 말풍선이 **위로 튄다** — 이미 본 것이 두 번 움직인다. 간 시각(sentAt)이
   * 박히면 내려간 자리에 그대로 머문다.
   */
  const t = mount();
  const base = [
    { id: "u1", role: "user", text: "오래", deliveredTo: ["b1"], placedAt: 1, createdAt: 1 },
    { id: "a2", role: "agent", text: "리뷰어 답", authorBotId: "b2", deliveredTo: ["b2"], createdAt: 4 },
  ];
  // 큐에서 나가면서 sentAt 이 박힌 뒤의 방
  open(t, room(BOTH, [
    ...base,
    { id: "u2", role: "user", text: "급한 거 먼저", deliveredTo: ["b1"], createdAt: 3, placedAt: 9 },
  ]));

  const order = t.$$("#screen-chat .msg .bubble").map((n) => n.textContent.replace(/@\S+\s*/g, "").trim());
  ok(order.at(-1) === "급한 거 먼저",
     `★ **여전히 맨 아래** (${order.join(" | ")}) — 대기가 풀려도 안 올라간다`);
}

console.log("\n[★ 빼도 그 자리에 머문다 — 누른 것이 달아나면 안 된다]");
{
  /*
   * 🔴 처음에 이 값을 `sentAt`(«간 시각»)이라 불렀더니 **경우를 하나
   * 빠뜨렸다**: 「빼기」로 물린 말은 **안 갔지만 줄에서는 나왔다.** 그래서
   * 자리를 못 잡고 **위로 튀었다** — 누른 말풍선이 눈앞에서 달아났다.
   *
   * 자리를 정하는 것은 «간 시각»이 아니라 **«줄에서 나온 시각»** 이다.
   */
  const t = mount();
  open(t, room(BOTH, [
    { id: "u1", role: "user", text: "오래", deliveredTo: ["b1"], placedAt: 1, createdAt: 1 },
    { id: "u2", role: "user", text: "줄에 선 말", deliveredTo: ["b1"], createdAt: 3,
      placedAt: 20, notSentTo: ["b1"], sendFailed: "보내기 전에 뺐습니다." },
    { id: "a1", role: "agent", text: "리뷰어 답", authorBotId: "b2", deliveredTo: ["b2"], createdAt: 9 },
  ]));

  const order = t.$$("#screen-chat .msg .bubble")
    .map((n) => n.textContent.replace(/[@][^ ]+ ?/g, "").trim());
  ok(order.at(-1) === "줄에 선 말",
     `★ **뺀 뒤에도 맨 아래** (${order.join(" | ")}) — 쓴 시각(3)이 아니라 나온 시각(20)`);
  ok(t.$$("#screen-chat .chip.to").length === 1,
     "★ 못 간 곳은 칩에서 빠진다 — 남은 건 «오래» 의 칩 하나");
}

console.log("\n[★ 말풍선 아래 띠가 통째로 사라졌다 (v3.0 1-E)]");
{
  /*
   * ⏪ 여기 «⏳ 대기 중» 띠가 있었고, 그 안에 «지금 보내기»(끼어들기)와
   * «빼기»(줄에서 빼기)가 나란히 있었다.
   *
   * 셋이 차례로 사라졌다 — 단추 둘은 **중지가 넷이면 각각이 MCP 큐·권한
   * 대기·심사 줄과 어떤 관계인지 따로 정의해야 해서**(1-D), 띠는 **큐 자체가
   * 엇갈림을 만들어서**(1-E).
   *
   * 🔴 이제 **말풍선이 있으면 이미 간 것**이다. 아직 안 간 글은 애초에
   * 말풍선이 아니라 입력창 위 예약 칸에 있다.
   */
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1"])]));
  ok(t.$("#screen-chat .delivery") === null, "★ **띠가 없다** — 말풍선이 있으면 간 것이다");
}

console.log("\n[★ 말풍선의 중단도 같은 아이콘 — 그리고 방 전체를 멈춘다]");
{
  /*
   * 🔴 **«■» 흉내는 걷어냈다.** 말풍선의 중단은 `::before` 로 ■ 를 그렸는데,
   * 위 상태줄의 «중단»과 **같은 일인데 모양이 달랐다.**
   *
   * ⏪ 그리고 이제 «이 봇만»이 아니다 — 봇이 여럿이어도 **방이 통째로**
   * 멈춘다. 자리는 그대로 두고 **글자가 하는 일을 말한다**: 「이 봇만」이
   * 남아 있으면 거짓말이 된다.
   */
  const t = mount();
  open(t, room(BOTH, [{ id: "s1", role: "agent", text: "쓰는 중", authorBotId: "b1",
                        deliveredTo: ["b1"], streaming: true, createdAt: 5 }]));
  const stopBot = t.$$("#screen-chat .stop-bot")[0];
  ok(stopBot?.querySelector("i.codicon-debug-stop") != null,
     "★ 말풍선의 «중단»도 **같은 아이콘** — ■ 흉내가 아니라 `debug-stop`");
  ok(stopBot.textContent === "전부 중단",
     `★ **글자가 하는 일을 말한다** (${stopBot.textContent}) — 「이 봇만」이면 거짓말이다`);

  stopBot.click();
  const sent = t.sent.find((m) => m.t === "stopAll");
  ok(sent?.roomId === "r1", "★ 봇을 안 지목한다 — 방이 통째로");
  ok(sent !== undefined && !("botId" in sent),
     "★ **중지 메시지에 봇 칸이 아예 없다** — 있으면 누군가 다시 쓰게 된다");
}

console.log("\n[★ ⏪ 못 간 곳은 칩에서 뺀다 (2026-09-23 정정)]");
{
  /*
   * 🔴 예전에는 그어서 남겼다 — «지우지 않는다»는 §0 뺄셈 규칙 때문이었다.
   * 그런데 **뺄셈 규칙은 «사라지면 안 된다»지 «여기 있어야 한다»가 아니다.**
   * 안 갔다는 사실은 말풍선 아래에 **글과 «다시 보내기»로** 더 분명히 남는다.
   *
   * 빼고 나면 칩 줄의 뜻이 하나로 좁아진다 — **여기 있으면 갔다.**
   */
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1", "b2"], {
    notSentTo: ["b2"], sendFailed: "Codex에게 보내기 전에 중단했습니다.",
  })]));

  const chips = toChips(t).map((c) => c.textContent);
  ok(chips.join() === "@Claude", `★ **받은 쪽만 남는다** (${chips.join(" ")})`);
  ok(t.$$("#screen-chat .chip.to.lost").length === 0, "★ 그어서 남기지 않는다");

  // 안 갔다는 사실은 **글로** 남고, 그 자리에 다시 보내기가 붙는다
  const err = t.$("#screen-chat .msg .meta.error")?.textContent ?? "";
  ok(/Codex/.test(err), `★ **누구에게 안 갔는지 글로** (${err})`);
  ok(t.$("#screen-chat .msg .retry") !== null, "★ 그 자리에 «다시 보내기»");
}

console.log("\n[★ 아무도 못 받았으면 칩이 한 장도 없다]");
{
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1", "b2"], {
    notSentTo: ["b1", "b2"], sendFailed: "Claude·Codex에게 보내기 전에 중단했습니다.",
  })]));
  ok(toChips(t).length === 0, "★ 아무도 못 받았으니 «받은 사람»이 없다");
  ok(t.$("#screen-chat .msg .retry") !== null, "★ 대신 다시 보내기가 있다");
}
console.log("\n[★ 내보낸 봇도 자리를 남긴다]");
{
  const t = mount();
  // b2를 내보낸 뒤 — 과거 메시지는 그대로 남는다
  open(t, room([bot("b1", "claude", "Claude"), bot("b3", "codex", "리뷰어")],
               [msg("u1", ["b1", "b2"])]));
  const chips = toChips(t);
  ok(chips.length === 2, "★ 둘에게 갔던 사실은 안 지워진다 (§0의 뺄셈 규칙)");
  ok(chips[1].classList.contains("gone"),
     "★ 이름은 잃었지만 **갔었다는 것은 남는다** — `removeBot`이 participants에서 빼기 때문");
}

console.log("\n[★ 전원에게 가도 칩은 하나씩 — «@everyone» 으로 접지 않는다]");
{
  /*
   * ⏪ 한때 «전원이면 @everyone 한 장»으로 접었다. 짧아서 좋아 보였는데,
   * «전원»은 **«지금 명단»에 기대는 말**이다. 명단이 바뀌면 같은 메시지가
   * 다르게 읽힌다 — **기록이 나중 일 때문에 흔들린다.**
   *
   * 개별 칩은 deliveredTo 그대로라 **언제 봐도 같다.**
   */
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1", "b2"])]));
  const chips = [...t.$$("#screen-chat .chip.to")].map((c) => c.textContent);
  ok(chips.join() === "@Claude,@Codex",
     `★ **받은 사람이 그대로 보인다** (${chips.join(" ")})`);
}
console.log("\n[★ 나간 봇도 이름으로 남는다]");
{
  /*
   * 🔴 예전에는 «@나간 봇» 이라는 **익명**이었다 — removeBot 이 participants
   * 에서 빼면서 이름이 통째로 사라졌기 때문이다. 그러면 대화를 다시 읽을 때
   * *"누구한테 시킨 거였지"* 에 답할 수 없다. 기록은 우리 것이고(§0),
   * 떠났다고 그 사람이 한 말이 익명이 되지는 않는다.
   */
  const t = mount();
  const r = room([bot("b1", "claude", "구현")], [
    { id: "u1", role: "user", text: "둘 다 봐줘", deliveredTo: ["b1", "b2"], createdAt: 1 },
    { id: "a1", role: "agent", text: "리뷰어가 한 말", authorBotId: "b2",
      deliveredTo: ["b2"], createdAt: 2 },
  ]);
  r.left = [{ id: "b2", name: "리뷰어", at: 5 }];
  open(t, r);

  const chips = [...t.$$("#screen-chat .chip.to")].map((c) => c.textContent);
  ok(chips.join() === "@구현,@리뷰어 (나감)",
     `★ **이름 + (나감)** (${chips.join(" ")}) — 멘션이 사라지지 않는다`);

  const whos = t.$$("#screen-chat .msg .who").map((n) => n.textContent);
  ok(whos.some((w) => w.includes("리뷰어 (나감)")),
     `★ **나간 봇이 한 말도 이름이 남는다** (${whos.join(" | ")})`);
}

console.log("\n[★ 지목 없이 보내도 받은 봇들이 칩으로 뜬다]");
{
  /*
   * 지목 없이 보내면 전원에게 간다(§4.1.2). 쓴 사람은 아무것도 안 적었지만
   * **어디로 갔는지는 남아야 한다** — 지목을 안 한 것과 안 간 것은 다르다.
   */
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1", "b2"])]));
  const chips = [...t.$$("#screen-chat .chip.to")].map((c) => c.textContent);
  ok(chips.join() === "@Claude,@Codex",
     `★ **안 적었어도 누가 받았는지 남는다** (${chips.join(" ")})`);
}
console.log("\n[★ 나간 봇 자리도 그대로]");
{
  const t = mount();
  open(t, room(BOTH, [msg("u1", ["b1", "b2", "b9"])]));
  const chips = [...t.$$("#screen-chat .chip.to")].map((c) => c.textContent);
  ok(chips.join() === "@Claude,@Codex,@나간 봇",
     `★ **셋에게 간 말이 둘로 보이지 않는다** (${chips.join(" ")}) — §0 뺄셈 규칙`);
}
console.log("\n[★ 한 번에 써도 멘션 기준으로 말풍선이 갈린다]");
{
  const t = mount();
  /*
   * 🔴 코어 주석은 *"composeGroupId 로 묶어 **화면이 붙여 그린다**"* 고 적고
   * 있었는데 **화면은 그 값을 한 번도 읽지 않는다.** 실제로는 처음부터 블록마다
   * 말풍선 하나였고, **그게 맞다** — 붙여 놓으면 «어느 줄이 누구에게 갔는지»를
   * 눈으로 되짚어야 한다.
   */
  const g = "g1";
  open(t, room(BOTH, [
    { id: "m1", role: "user", text: "이 코드 봐줘", deliveredTo: ["b1", "b2"],
      composeGroupId: g, createdAt: 1 },
    { id: "m2", role: "user", text: "문서도 업데이트해줘", deliveredTo: ["b2"],
      composeGroupId: g, createdAt: 2 },
  ]));

  const msgs = t.$$("#screen-chat .msg");
  ok(msgs.length === 2, `★ **블록마다 말풍선 하나** (${msgs.length})`);

  const chipsOf = (n) => [...n.querySelectorAll(".chip.to")].map((c) => c.textContent).join(",");
  ok(chipsOf(msgs[0]) === "@Claude,@Codex", `★ 첫 블록은 둘에게 (${chipsOf(msgs[0])})`);
  ok(chipsOf(msgs[1]) === "@Codex",
     `★ **둘째 블록은 한 쪽에만** (${chipsOf(msgs[1])}) — 붙여 두면 이걸 눈으로 되짚어야 한다`);
  ok(msgs[0].textContent.includes("이 코드") && !msgs[0].textContent.includes("문서도"),
     "★ 글도 섞이지 않는다");
}

console.log("\n[★ 봇이 봇에게 건 말도 «누구에게»를 단다 (v3.0 대비)]");
{
  const t = mount();
  /*
   * 릴레이(§7)가 들어오면 알파가 베타에게 거는 말이 생긴다. 그건 «봇이 봇에게
   * 한 말»이라 말풍선이고, 그렇다면 사용자 말과 똑같이 **받는 이가 보여야**
   * 한다 — 안 보이면 그 말풍선만 «누구에게 갔는지 알 수 없는 말»이 된다.
   */
  const relay = { id: "rel", role: "agent", text: "이것 좀 봐줘",
                  authorBotId: "b1", deliveredTo: ["b1", "b2"], createdAt: 9 };
  const plain = { id: "ans", role: "agent", text: "평범한 답",
                  authorBotId: "b1", deliveredTo: ["b1"], createdAt: 10 };
  open(t, room(BOTH, [relay, plain]));

  const nodes = t.$$("#screen-chat .msg");
  const relayNode = nodes.find((n) => /이것 좀 봐줘/.test(n.textContent));
  const plainNode = nodes.find((n) => /평범한 답/.test(n.textContent));

  const chips = [...relayNode.querySelectorAll(".chip.to")].map((c) => c.textContent);
  ok(chips.join() === "@Codex",
     `★ **받는 이가 보인다** (${chips.join(" ")}) — 글쓴이 자신은 뺀다`);
  ok(plainNode.querySelector(".chip.to") === null,
     "★ **평범한 답에는 안 단다** — «나에게 갔다»는 군더더기다 (오늘 화면은 안 바뀐다)");
}

console.log("\n[★ 봇이 나에게 한 말에도 칩을 단다]");
{
  /*
   * 🔴 여태 «칩이 없으면 나에게 한 말»이었다. **없는 것으로 구별하면 약하다** —
   * 긴 대화를 훑을 때 «빠뜨린 것»과 구별이 안 된다. 봇끼리 말하기(§7)가
   * 들어오면 그 차이가 매 줄 필요해진다.
   *
   * ★ **3인칭이다.** 칩은 **보내는 쪽 말풍선 안**에 들어가므로 «@나» 라고 쓰면
   * 그 «나»가 **말하는 봇**으로 읽힌다.
   */
  const t = mount();
  const toMe = { id: "a1", role: "agent", text: "고쳤어", authorBotId: "b1",
                 deliveredTo: ["b1"], replyToIds: ["u1"], toUser: true, createdAt: 9 };
  const toBot = { id: "a2", role: "agent", text: "이것 좀 봐줘", authorBotId: "b1",
                  deliveredTo: ["b1", "b2"], createdAt: 10 };
  open(t, room(BOTH, [msg("u1", ["b1"]), toMe, toBot]));

  const nodes = t.$$("#screen-chat .msg");
  const mine = nodes.find((n) => /고쳤어/.test(n.textContent));
  const other = nodes.find((n) => /이것 좀 봐줘/.test(n.textContent));

  const chips = (n) => [...n.querySelectorAll(".chip.to")].map((c) => c.textContent);
  console.log(`   나에게: ${chips(mine).join(" ")} · 봇에게: ${chips(other).join(" ")}`);

  /*
   * ★ **괄호를 두른 이유**: 그냥 «사용자» 면 **봇 이름이 «사용자»일 때 두 칩이
   * 똑같이 읽힌다** — 칩을 단 이유가 거기서 무너진다. 봇 이름에서는 괄호를
   * 걷어내므로(`cleanBotName`) 이 모양은 **봇이 가질 수 없다.**
   *
   * ⏪ **`@` 를 붙인다** (2026-09-29). 한때 «부를 수 있는 이름이 아니니 모양이
   * 달라야 한다» 며 뺐는데, 🔴 화면에서는 반대로 작동했다 — 바로 옆 봇 칩이
   * `@이름` 인데 혼자 `(사용자)` 라 **같은 줄에서 같은 일을 하는 칩 둘이
   * 다른 말투**였고, 멘션으로 안 읽혔다. 가르는 일은 **괄호가 이미 하고
   * 있으므로** `@` 까지 뺄 필요가 없었다.
   */
  ok(chips(mine).join() === "@(사용자)",
     `★ **나에게 한 말에 «@(사용자)»** (${chips(mine).join(" ")})`);
  ok(chips(mine)[0].startsWith("@") && chips(other)[0].startsWith("@"),
     "★ **둘 다 «@» 로 시작한다** — 같은 줄의 같은 일이면 말투가 같아야 한다");
  ok(chips(other).join() === "@Codex",
     `★ 봇에게 한 말은 그 봇 이름 (${chips(other).join(" ")})`);
  ok(mine.querySelector(".chip.to.me") !== null,
     "★ **모양이 갈린다** — 같으면 결국 글자를 읽어야 하고, 그러면 단 보람이 없다");
  ok(other.querySelector(".chip.to.me") === null, "★ 봇 칩에는 안 붙는다");
}

console.log("\n[★ 1:1 에서는 안 단다 — 받을 사람이 나뿐이다]");
{
  /*
   * 받을 사람이 나밖에 없으면 «@사용자»가 아무것도 안 말해준다. 1:1 에서
   * 이름을 생략하는 것과 같은 이유다(C9).
   */
  const t = mount();
  const solo = [bot("b1", "claude", "Claude")];
  const toMe = { id: "a1", role: "agent", text: "고쳤어", authorBotId: "b1",
                 deliveredTo: ["b1"], replyToIds: ["u1"], toUser: true, createdAt: 9 };
  open(t, room(solo, [msg("u1", ["b1"]), toMe]));

  const mine = t.$$("#screen-chat .msg").find((n) => /고쳤어/.test(n.textContent));
  console.log(`   칩: ${[...mine.querySelectorAll(".chip.to")].map((c) => c.textContent).join(" ") || "(없음)"}`);
  ok(mine.querySelector(".chip.to") === null,
     "★ **아무 칩도 없다** — 군더더기를 안 단다");
}

console.log("\n전부 통과");
