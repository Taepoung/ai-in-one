/**
 * **승인 큐** — 헤더 바로 아래에서 개별 · 선택 · 전체 (D1).
 *
 * 🔴 카드를 대화 맨 아래에 쌓고 있었다. 둘만 넘어가도 **답할 것이 뭔지
 * 흐려지고**, 대화는 자동으로 바닥까지 스크롤되는데 카드는 그보다 아래라
 * 오히려 밀렸다. 답해야 하는 것은 **대화와 같이 흐르면 안 된다.**
 *
 * 🔴 그리고 **일괄 처리에는 «항상»을 쓰지 않는다.** 여러 개를 한 번에 넘길
 * 때는 하나하나를 읽지 않는다는 뜻인데, 거기에 «앞으로 전부»까지 걸면
 * **읽지 않은 것이 영구 규칙이 된다.**
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

const AGENTS = [{ id: "claude", label: "Claude", color: "#d97757" }];
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

const OPTS = [
  { optionId: "a1", name: "이번만 허용", kind: "allow_once" },
  { optionId: "aa", name: "항상 허용", kind: "allow_always" },
  { optionId: "r1", name: "이번만 거절", kind: "reject_once" },
];
const card = (id, title, extra = {}) => ({
  id, kind: "permission", roomId: "r1",
  req: { toolCallId: "t" + id, title, readOnly: false, kind: "edit", options: OPTS, ...extra },
});

const bot = (id, name, approver = { kind: "user" }) => ({
  id, agentId: "claude", name, sessionId: "s" + id, approver, answerPolicy: "ask",
});
const room = (participants = [bot("b1", "Claude")]) => ({
  id: "r1", title: "방", cwd: "/ws", participants,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: ["b1"], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

function open(t, participants) {
  t.$(".room").click();
  t.send({ t: "room", room: room(participants), compactable: false });
}
const answers = (t) => t.sent.filter((m) => m.t === "answer");

console.log("\n[★ 헤더 바로 아래에 뜬다 — 대화와 같이 흐르지 않는다]");
{
  const t = mount();
  open(t);
  ok(t.$("#screen-chat .approvals").hidden === true, "평소엔 숨어 있다");

  t.send({ t: "ask", card: card("c1", "파일 고치기") });
  const q = t.$("#screen-chat .approvals");
  ok(q.hidden === false, "★ 승인이 오면 뜬다");
  ok(q.previousElementSibling.classList.contains("bar"),
     "★ **헤더 바로 다음**이다 — 대화는 바닥으로 스크롤되므로 아래에 두면 밀린다");
  ok(t.$("#screen-chat .messages .card") === null, "★ 대화 아래에는 이제 안 쌓인다");
  ok(q.textContent.includes("승인 대기 1"), "★ 몇 개인지 적힌다");
}

console.log("\n[★ 개별 — 줄에서 바로 «이번만»]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "파일 고치기") });

  const allow = [...t.$$("#screen-chat .approval .quick button")].find((b) => b.textContent === "허용");
  allow.click();
  const a = answers(t)[0];
  ok(a?.id === "c1", "★ 그 요청에만 답한다");
  ok(a.answer.optionId === "a1",
     `★ **«이번만»이다** (${a.answer.optionId}) — 줄에서 누르는 건 앞으로를 안 바꾼다`);
  ok(t.$("#screen-chat .approvals").hidden === true, "★ 답하면 큐가 빈다");
}

console.log("\n[★ 펴면 에이전트가 준 선택지를 그대로 — «항상»은 여기에]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "rm -rf /tmp/x", { command: "rm -rf /tmp/x" }) });

  const row = t.$("#screen-chat .approval");
  ok(row.querySelector(".perm-cmd")?.textContent === "rm -rf /tmp/x",
     "★ **무엇을 승인하는지 보인다**(D1) — 제목만으로는 rm -rf 와 ls 가 같다");

  const always = [...row.querySelectorAll(".card-actions button")].find((b) => b.textContent === "항상 허용");
  ok(always !== undefined, "★ **«항상»은 펴야 나온다**");
  always.click();
  ok(answers(t)[0].answer.optionId === "aa", "★ 고른 그대로 간다");
}

console.log("\n[★ 허용은 초록, 거절은 빨강 — 글자를 읽기 전에 알아야 한다]");
{
  /*
   * 🔴 «거절»이 흰 단추라 **글자를 읽어야만** 어느 쪽인지 알 수 있었다. 승인
   * 큐는 **여럿이 쌓이는 자리**라 하나씩 읽게 하면 안 된다 — 색이 먼저 말하고
   * 글자가 확인해 준다.
   */
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "파일 고치기") });
  t.send({ t: "ask", card: card("c2", "명령 실행") });

  const q = [...t.$$("#screen-chat .approval .quick button")];
  const yes = q.find((b) => b.textContent === "허용");
  const no = q.find((b) => b.textContent === "거절");
  ok(yes.classList.contains("ok"), "★ 허용은 초록 자리(.ok)");
  ok(no.classList.contains("no"), "★ **거절도 색이 있다** — 흰 단추가 아니다");

  const head = [...t.$$("#screen-chat .approvals-head button")];
  ok(head.find((b) => b.textContent === "전부 허용")?.classList.contains("ok"),
     "★ 전부 허용도 같은 색");
  ok(head.find((b) => b.textContent === "전부 거절")?.classList.contains("no"),
     "★ 전부 거절도 같은 색 — 한 자리에서 색이 갈려야 한다");

  /*
   * ★ **승인 큐만은 글자다** (결정 2026-09-23).
   *
   * 대기 띠의 «지금 보내기 / 빼기»에는 아이콘을 넣었다 — 서로 **다른 일**이라
   * 모양이 갈린다. 그런데 승인 큐는 같은 일이 **범위만 다르게** 네 개 있다:
   *
   *   허용 · 거절 · 전부 허용 · 전부 거절 · 선택 허용
   *
   * ✅ 와 ❎ 는 **허용과 거절**을 갈라주지만 **«전부»와 «선택»은 못 가른다.**
   * 그러면 아이콘이 같은 단추가 나란히 서고, 결국 **글자를 읽어야** 한다 —
   * 아이콘이 자리만 먹고 아무 일도 안 하는 것이다. 여기서는 **색이 종류를,
   * 글자가 범위를** 말한다.
   *
   * 🔴 그래서 이 줄은 «아직 안 붙였다»가 아니라 **붙이지 않기로 한 것**이다.
   */
  const all = [...t.$$("#screen-chat .approval .quick button"),
               ...t.$$("#screen-chat .approvals-head button")];
  const withIcon = all.filter((b) => b.querySelector("i.codicon") !== null);
  ok(withIcon.length === 0,
     `★ **승인 큐는 글자만** (아이콘 ${withIcon.length}개) — ✅❎ 는 «전부»와 «선택»을 못 가른다`);
  ok(all.length >= 4, `★ 그리고 실제로 여러 개가 나란히 선다 (${all.length}개)`);
}

console.log("\n[★ 선택 — 체크한 것만]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "하나") });
  t.send({ t: "ask", card: card("c2", "둘") });
  t.send({ t: "ask", card: card("c3", "셋") });
  ok(t.$$("#screen-chat .approval").length === 3, "셋이 줄 서 있다");

  const ticks = t.$$("#screen-chat .approval input[type=checkbox]");
  ticks[0].checked = true; ticks[0].dispatchEvent(new t.w.Event("change"));
  ticks[2].checked = true; ticks[2].dispatchEvent(new t.w.Event("change"));

  const pick = [...t.$$("#screen-chat .approvals-head button")]
    .find((b) => b.textContent === "선택 허용");
  /*
   * ⏪ 한때 «선택 2개 허용»이라 개수를 단추에 박았다 (2026-09-23 정정).
   *
   * 🔴 개수는 **바로 위 «승인 대기 N»과 체크 표시가 이미 말한다.** 단추에까지
   * 넣으면 길어지기만 하고, **고를 때마다 글자 수가 바뀌어 단추 폭이 흔들린다** —
   * 누르려는 것이 움직인다. 개수는 툴팁으로 내렸다.
   */
  ok(pick?.textContent === "선택 허용", `★ **짧게** (${pick?.textContent})`);
  ok(pick?.title.includes("2개"), `★ 개수는 툴팁에 남는다 (${pick?.title})`);
  pick.click();

  const ids = answers(t).map((m) => m.id);
  ok(ids.length === 2 && ids.includes("c1") && ids.includes("c3"),
     `★ **고른 것만** (${ids.join(",")})`);
  ok(answers(t).every((m) => m.answer.optionId === "a1"),
     "★ 일괄은 «이번만» — 읽지 않은 것이 영구 규칙이 되면 안 된다");
  ok(t.$$("#screen-chat .approval").length === 1, "★ 나머지 하나는 남는다");
}

console.log("\n[★ 전부 — 하나뿐이면 안 뜬다]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "하나") });
  ok([...t.$$("#screen-chat .approvals-head button")].every((b) => b.textContent !== "전부 허용"),
     "★ 하나면 «전부»가 뜻이 없다 — 줄에서 바로 누르면 된다");

  t.send({ t: "ask", card: card("c2", "둘") });
  const all = [...t.$$("#screen-chat .approvals-head button")].find((b) => b.textContent === "전부 허용");
  ok(all !== undefined, "★ 둘부터 뜬다");
  all.click();
  ok(answers(t).length === 2 && answers(t).every((m) => m.answer.optionId === "a1"),
     "★ 둘 다 «이번만»으로");
  ok(t.$("#screen-chat .approvals").hidden === true, "★ 큐가 빈다");
}

console.log("\n[★ 해소된 카드는 체크도 같이 걷힌다]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "하나") });
  t.send({ t: "ask", card: card("c2", "둘") });
  const ticks = t.$$("#screen-chat .approval input[type=checkbox]");
  ticks[0].checked = true; ticks[0].dispatchEvent(new t.w.Event("change"));
  // 개수는 툴팁에 있다 — 단추 글자는 «선택 허용»로 짧게 (2026-09-23)
  ok(t.$("#screen-chat .approvals-head button").title.includes("1개"), "하나 골랐다");

  // 다른 이유로 사라지면 (패널이 닫혔다거나)
  t.send({ t: "askResolved", id: "c1" });
  const head = [...t.$$("#screen-chat .approvals-head button")];
  ok(head.every((b) => !b.textContent.includes("선택")),
     "★ **없는 것을 고른 채로 두지 않는다** — 누르면 답할 데가 없다");
}

console.log("\n[★ 전부 거절도 있다]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "하나") });
  t.send({ t: "ask", card: card("c2", "둘") });

  const no = [...t.$$("#screen-chat .approvals-head button")].find((b) => b.textContent === "전부 거절");
  ok(no !== undefined,
     "★ **비대칭이면 안 된다** — 게다가 거절이 더 안전한 쪽이라 막아둘 이유가 없다");
  no.click();
  ok(answers(t).length === 2 && answers(t).every((m) => m.answer.optionId === "r1"),
     "★ 둘 다 «이번만 거절»로");
  ok(t.$("#screen-chat .approvals").hidden === true, "큐가 빈다");
}

console.log("\n[★ 누가 하려는 일인지 줄에 적힌다]");
{
  const t = mount();
  open(t, [bot("b1", "구현"), bot("b2", "리뷰어")]);
  t.send({ t: "ask", card: card("c1", "파일 고치기", { askerBotId: "b2" }) });

  const by = t.$("#screen-chat .approval .activity .by");
  ok(by?.textContent === "리뷰어",
     `★ **어느 봇 것인지** (${by?.textContent}) — 리뷰어가 파일을 고치려 하면 그것부터 이상하다`);
}

console.log("\n[1:1에서는 안 적는다 — 상대가 하나뿐이라 자명하다]");
{
  const t = mount();
  open(t);
  t.send({ t: "ask", card: card("c1", "파일 고치기", { askerBotId: "b1" }) });
  ok(t.$("#screen-chat .approval .activity .by") === null, "★ 군더더기가 된다");
}

console.log("\n[★ 원래 봇에게 맡긴 승인이면 그것도 적는다]");
{
  const t = mount();
  open(t, [bot("b1", "구현", { kind: "bot", botId: "b2" }), bot("b2", "리뷰어")]);
  t.send({ t: "ask", card: card("c1", "파일 고치기", { askerBotId: "b1" }) });

  const meant = t.$("#screen-chat .approval .activity .meant");
  ok(meant?.textContent.includes("리뷰어") === true,
     `★ **왜 나한테 왔지에 답한다** (${meant?.textContent}) — 맡김이 헛돌면 그게 신호다`);
}

console.log("\n[대상이 사용자면 안 적는다]");
{
  const t = mount();
  open(t, [bot("b1", "구현"), bot("b2", "리뷰어")]);
  t.send({ t: "ask", card: card("c1", "파일 고치기", { askerBotId: "b1" }) });
  ok(t.$("#screen-chat .approval .activity .meant") === null,
     "★ 내 큐에 있는 게 당연한 경우다");
}

console.log("\n전부 통과");
