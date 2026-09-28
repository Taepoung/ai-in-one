/**
 * **에이전트 바꾸기 — 서랍 안, 모델 바로 위** (§4.2.1).
 *
 * 🔴 처음에는 «할 수 있는 것» 버튼 줄에 넣고 **모달**을 띄웠다. 두 군데가 틀렸다:
 *
 * 1. **자리.** 에이전트는 모델과 **같은 종류**다 — «이 봇이 무엇으로 도는가».
 *    서랍 둘째 줄이 이미 «Opus · Claude Code»로 둘을 나란히 적는데 고치는
 *    자리만 따로 떨어져 있었다
 * 2. **모달.** 서랍을 닫고 떠서 **맥락을 잃었다.** 서랍은 «이 봇에 대한 것이
 *    다 모이는 자리»인데 거기서 튕겨 나오면 안 된다
 *
 * 다만 바꾸는 것 자체는 **세션을 버리는 일**이라 바로 안 바꾼다 — 고르면
 * 그 자리 아래에 무엇을 잃는지 펴고 거기서 확인받는다.
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
const META = { id: "r1", title: "방", kind: "direct", cwd: "/ws", agentIds: ["claude"],
               unread: 0, createdAt: 1, lastActivityAt: 2 };

function mount(agents = AGENTS) {
  const sent = [];
  const boot = { rooms: [META], agents, reducedMotion: true, screen: "list",
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
const room = (bots) => ({
  id: "r1", title: "방", cwd: "/ws", participants: bots,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: [bots[0].id], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});
/** 에이전트가 모델 목록을 줄 때 */
const MODEL = {
  agentId: "claude",
  options: [{ configId: "model", category: "model", name: "모델", current: "opus",
              values: [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }] }],
};
/** 갈아탈 쪽의 목록 — 값이 겹치지 않아야 «따라갔나»를 잴 수 있다 */
const MODEL_CODEX = {
  agentId: "codex",
  options: [{ configId: "cfg-model", category: "model", name: "모델", current: "gpt5",
              values: [{ id: "gpt5", name: "GPT-5" }, { id: "mini", name: "Mini" }] }],
};

/** 방을 열고 서랍을 편다 */
function drawer(t, bots = [bot("b1", "claude", "구현")], { status, config, configs } = {}) {
  t.$(".room").click();
  t.send({ t: "room", room: room(bots), compactable: false });
  // 설정은 **봇 단위**다 — 그 에이전트를 쓰는 봇에게만 붙는다
  const send = (c) => {
    for (const b of bots) if (b.agentId === c.agentId) {
      t.send({ t: "config", roomId: "r1", botId: b.id, ...c });
    }
    // 아직 방에 없는 에이전트는 **방을 빼고** — 갈아타기 미리보기가 그 길이다
    if (!bots.some((b) => b.agentId === c.agentId)) t.send({ t: "config", ...c });
  };
  if (config) send(config);
  for (const c of configs ?? []) send(c);
  if (status) t.send({ t: "status", roomId: "r1", status: "streaming", bots: status });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  return t.$("#screen-chat .drawer");
}
const fields = (d) => [...d.querySelectorAll(".drawer-bot .field label")].map((e) => e.textContent);
const pickAgent = (t, id) => {
  const sel = t.$(".drawer-bot .field select");
  sel.value = id;
  sel.dispatchEvent(new t.w.Event("change"));
  return sel;
};

console.log("\n[★ 서랍 안, 모델 바로 위에 있다]");
{
  const t = mount();
  const d = drawer(t, undefined, { config: MODEL });
  ok(fields(d).join(",") === "에이전트,모델",
     `★ **에이전트가 모델 위**다 (${fields(d).join(" → ")}) — 둘은 «이 봇이 무엇으로 도는가»로 같은 종류다`);
  ok(d.querySelector(".drawer-bot .field select").value === "claude", "지금 것이 골라져 있다");
  ok([...d.querySelectorAll("button")].every((b) => b.textContent !== "에이전트 바꾸기"),
     "★ 버튼 줄에는 이제 없다 — 자리가 옮겨졌다");
  ok([...d.querySelectorAll("button")].every((b) => b.textContent !== "권한 설정"),
     "★ «권한 설정»도 뺐다 — 입력창 옆 방패가 같은 화면을 연다");
}

console.log("\n[★ 고르면 그 자리에서 «무엇을 잃나»가 펴진다 — 모달이 아니다]");
{
  const t = mount();
  const d = drawer(t);
  ok(t.$(".swap-ask") === null, "평소엔 아예 없다");

  pickAgent(t, "codex");
  const ask = t.$(".swap-ask");
  ok(ask !== null, "★ 고르면 나타난다");
  ok(t.$("#screen-chat .modal") === null, "★ **모달이 아니다**");
  ok(t.$("#screen-chat .drawer") !== null,
     "★ **서랍이 그대로 열려 있다** — 여기가 이 봇에 대한 것이 다 모이는 자리다");

  const gone = ask.querySelector(".swap-what .gone").textContent;
  ok(gone.includes("세션") && gone.includes("계획"), `★ 세션을 버린다고 말한다 (${gone})`);
  ok(gone.includes("모델") && gone.includes("권한"), "★ 모델·권한·설정값도 — setAgent 가 하는 그대로");

  const kept = ask.querySelector(".swap-what .kept").textContent;
  ok(kept.includes("대화"), "★ 대화는 남는다");
  ok(kept.includes("resume"), "★ 되돌릴 길도 — 세션을 지우지는 않는다");
}

console.log("\n[★ 폴백이라는 것을 미리 말한다]");
{
  const t = mount();
  drawer(t);
  pickAgent(t, "codex");
  const warn = [...t.$$(".swap-ask .warn")].map((e) => e.textContent).join(" ");
  ok(warn.includes("Codex") && warn.includes("위 대화를 모릅니다"), "★ 새 에이전트는 모른다");
  ok(warn.includes("글자만"),
     "★ **«대화 넘겨서 시작»은 글자만 옮긴다** — 알고 고르는 것과 겪는 것은 다르다");
  ok(warn.includes("계획"), "★ 무엇이 안 따라오는지까지");
}

console.log("\n[★ 확인해야 바뀐다]");
{
  const t = mount();
  drawer(t);
  pickAgent(t, "codex");
  ok(t.sent.find((m) => m.t === "setAgent") === undefined,
     "★ **고른 것만으로는 안 바뀐다** — 되돌릴 수 없는 일이다");

  const labels = [...t.$$(".swap-ask .acts button")].map((b) => b.textContent);
  ok(labels.join(" | ") === "대화 넘겨서 바꾸기 | 기록만 두고 바꾸기 | 그대로 두기",
     `★ **세 갈래다** (${labels.join(" | ")}) — 무엇을 잃는지 방금 읽은 자리에서 정한다`);

  [...t.$$(".swap-ask .acts button")][0].click();
  const posted = t.sent.find((m) => m.t === "setAgent");
  ok(posted?.botId === "b1" && posted.agentId === "codex" && posted.roomId === "r1",
     "★ 그 봇을 그 에이전트로");
  ok(posted.refeed === true,
     "★ **«대화를 넘길지»도 같이 간다** — 바꾼 뒤에 또 묻지 않는다");
}

console.log("\n[★ «그대로 두기»는 고른 것을 되돌린다]");
{
  const t = mount();
  drawer(t);
  pickAgent(t, "codex");
  [...t.$$(".swap-ask .acts button")].find((b) => b.textContent === "그대로 두기").click();

  ok(t.sent.find((m) => m.t === "setAgent") === undefined, "안 바꾼다");
  ok(t.$(".drawer-bot .field select").value === "claude",
     "★ **칸도 되돌아간다** — 안 바꿨는데 칸만 바뀌어 있으면 거짓말이다");
  ok(t.$(".swap-ask") === null, "경고도 사라진다");
}

console.log("\n[다시 지금 것을 고르면 접힌다]");
{
  const t = mount();
  drawer(t);
  pickAgent(t, "codex");
  ok(t.$(".swap-ask") !== null, "나와 있다");
  pickAgent(t, "claude");
  ok(t.$(".swap-ask") === null, "★ 같은 것으로 되돌리면 물어볼 게 없다");
}

console.log("\n[★ 답하는 중에는 못 바꾼다 — 그 답이 갈 곳이 없어진다]");
{
  const t = mount();
  drawer(t, undefined, { status: { b1: "streaming" } });
  pickAgent(t, "codex");
  const warn = [...t.$$(".swap-ask .warn")].map((e) => e.textContent).join(" ");
  ok(warn.includes("답하는 중"), "★ 왜 안 되는지 말한다");
  const gos = [...t.$$(".swap-ask .acts button")].filter((b) => b.textContent.includes("바꾸기"));
  ok(gos.length === 2 && gos.every((b) => b.disabled === true),
     "★ 둘 다 잠긴다 — 코어도 거절하지만 누르게 두지 않는다");
}

console.log("\n[★ 에이전트가 하나뿐이면 칸이 없다]");
{
  const t = mount([AGENTS[0]]);
  const d = drawer(t, undefined, { config: MODEL });
  ok(!fields(d).includes("에이전트"),
     "★ 바꿀 상대가 없는데 칸만 있으면 열어보고 빈 목록을 본다");
  ok(fields(d).includes("모델"), "모델은 그대로");
}

console.log("\n[★ 기록만 두고 바꾸기 — 되먹임을 끈 채로]");
{
  const t = mount();
  drawer(t);
  pickAgent(t, "codex");
  [...t.$$(".swap-ask .acts button")][1].click();
  const posted = t.sent.find((m) => m.t === "setAgent");
  ok(posted.refeed === false,
     "★ **대화는 화면에만 남는다** — 새 에이전트는 백지에서 시작");
}

console.log("\n[★ 갈아탈 에이전트의 모델을 같이 고른다]");
{
  const t = mount();
  drawer(t, undefined, { configs: [MODEL, MODEL_CODEX] });
  pickAgent(t, "codex");

  const sels = t.$$(".drawer-bot .field select");
  const model = sels[1];
  ok(model.disabled === false,
     "★ **잠그지 않는다** — 고르는 건 버릴 세션이 아니라 **새 에이전트**의 모델이다");
  ok([...model.options].map((o) => o.textContent).join(",") === "GPT-5,Mini",
     `★ 고른 에이전트의 목록이다 (${[...model.options].map((o) => o.textContent).join(",")})`);

  model.value = "mini";
  model.dispatchEvent(new t.w.Event("change"));
  ok(t.sent.find((m) => m.t === "setConfig") === undefined,
     "★ **아직 안 건다** — 그 세션은 아직 없다");

  [...t.$$(".swap-ask .acts button")][0].click();
  const posted = t.sent.find((m) => m.t === "setAgent");
  ok(posted.model?.value === "mini" && posted.model.configId === "cfg-model",
     `★ **확정할 때 같이 간다** (${JSON.stringify(posted.model)}) — 한 번의 결정이다`);
}

console.log("\n[★ 에이전트를 다시 고르면 모델 선택은 버린다]");
{
  const t = mount();
  drawer(t, undefined, { configs: [MODEL, MODEL_CODEX] });
  pickAgent(t, "codex");
  const model = t.$$(".drawer-bot .field select")[1];
  model.value = "mini";
  model.dispatchEvent(new t.w.Event("change"));

  pickAgent(t, "claude");   // 되돌렸다가
  pickAgent(t, "codex");    // 다시 고르면
  [...t.$$(".swap-ask .acts button")][0].click();
  ok(t.sent.find((m) => m.t === "setAgent").model === undefined,
     "★ 다른 에이전트의 모델 값을 들고 있으면 안 된다");
}

console.log("\n[★ 평소의 모델 바꾸기는 **봇을 실어 보낸다**]");
{
  const t = mount();
  drawer(t, [bot("b1", "claude", "구현"), bot("b2", "claude", "리뷰어")], { config: MODEL });
  // 둘째 봇의 모델 칸
  const sels = t.$$(".drawer-bot")[1].querySelectorAll(".field select");
  const model = sels[sels.length - 1];
  model.value = "sonnet";
  model.dispatchEvent(new t.w.Event("change"));

  const posted = t.sent.find((m) => m.t === "setConfig");
  ok(posted?.botId === "b2",
     `★ **그 봇의 것이다** (${posted?.botId}) — 없으면 첫 봇이 바뀐다`);
}

console.log("\n전부 통과");
