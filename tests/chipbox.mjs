/**
 * **멘션 칩 입력창** (§4.1.2) — 단체방에서만.
 *
 * jsdom은 IME를 못 만든다. 그건 사람이 F5로 쟀고(2026-09-21, 안 깨짐), 여기서는
 * **그 밖의 전부**를 잰다: 언제 뜨고, 무엇이 칩이 되고, 누구에게 간다고 말하고,
 * 막을 때 막는가.
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

const bot = (id, agentId, name) => ({ id, agentId, name: name ?? agentId,
  sessionId: "s" + id, sessionPrompted: true, approver: { kind: "user" }, answerPolicy: "ask" });

const room = (bots) => ({
  id: "r1", title: "방", cwd: "/ws", participants: bots,
  messages: [{ id: "u1", role: "user", text: "안녕", deliveredTo: [], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

/** 방을 열고 입력창을 돌려준다 */
function open(t, bots) {
  t.$(".room").click();
  t.send({ t: "room", room: room(bots), compactable: false });
  return t.$("#screen-chat .composer textarea, #screen-chat .chipbox");
}

/** 칩 상자에 글자를 넣고 커서를 끝에 둔 뒤 input 을 쏜다 */
function type(t, box, text) {
  const node = t.w.document.createTextNode(text);
  box.append(node);
  const range = t.w.document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  const sel = t.w.document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  box.dispatchEvent(new t.w.Event("input"));
  return node;
}

const key = (t, box, k, extra = {}) =>
  box.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));

console.log(NL + "[1:1은 예전 그대로다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude")]);
  ok(box.tagName === "TEXTAREA",
     "★ 봇이 하나면 칩 상자가 아니다 — 고를 상대가 없는데 @를 치게 할 이유가 없다");
  ok(t.$("#screen-chat .compose-note").hidden, "«누구에게 가나» 줄도 숨어 있다");
}

console.log(NL + "[단체방은 칩 상자]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  ok(box.classList.contains("chipbox"), "★ 봇이 둘이면 칩 상자");
  ok(box.getAttribute("contenteditable") === "true", "contenteditable");
  ok(box.dataset.empty.includes("@"), `빈 상자에 «@로 지목»이라고 적힌다 (${box.dataset.empty})`);
}

console.log(NL + "[★ @를 치면 목록이 뜬다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@");
  const picker = t.$("#screen-chat .picker");
  ok(picker !== null, "★ 목록이 열린다");
  const labels = [...picker.querySelectorAll("button")].map((b) => b.textContent);
  ok(labels.some((l) => l.includes("@claude")) && labels.some((l) => l.includes("@codex")),
     `참여 봇이 전부 (${labels.join(" | ")})`);
  ok(labels.some((l) => l.includes("@everyone")), "★ @everyone도");
  ok(picker.querySelector("button").classList.contains("on"), "첫 줄이 골라져 있다 — Tab 한 번이면 된다");
}

console.log(NL + "[★ 친 글자로 좁혀진다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cod");
  const labels = [...t.$("#screen-chat .picker").querySelectorAll("button")].map((b) => b.textContent);
  ok(labels.length === 1 && labels[0].includes("codex"),
     `★ 부분 일치로 좁힌다 (${labels.join(" | ")})`);
}

console.log(NL + "[맞는 게 없으면 닫는다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@zzz");
  ok(t.$("#screen-chat .picker") === null,
     "★ 목록을 닫는다 — 친 글자는 남지만 **칩이 아니므로 멘션도 아니다**");
}

console.log(NL + "[★ Tab으로 칩이 된다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cod");
  key(t, box, "Tab");

  const chips = box.querySelectorAll(".chip");
  ok(chips.length === 1, "★ 칩 하나가 생긴다");
  ok(chips[0].dataset.bot === "b2",
     "★ **botId를 들고 있다** — 이름을 바꿔도 라우팅이 유지된다");
  ok(chips[0].getAttribute("contenteditable") === "false", "칩 안은 편집 대상이 아니다");
  // 칩 안의 글자(`@codex`)가 아니라 **칩 밖의** 글자를 봐야 한다
  const bare = [...box.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join("");
  ok(!bare.includes("@cod"),
     `★ 친 «@cod»는 사라졌다 — 칩이 그 자리를 대신한다 (${JSON.stringify(bare)})`);
  ok(t.$("#screen-chat .picker") === null, "목록은 닫힌다");
}

console.log(NL + "[★ 보내기 전에 누구에게 가는지 말해준다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cod");
  key(t, box, "Tab");
  type(t, box, "테스트 짜줘");

  const note = t.$("#screen-chat .compose-note");
  ok(!note.hidden && note.textContent.includes("codex"),
     `★ 보내기 전에 줄인다 — 보내고 나서 «안 갔다»는 이미 틀린 뒤다 (${note.textContent})`);
  ok(note.querySelector(".note-row .what").textContent === "테스트 짜줘",
     "★ **무엇이 갈지 그대로** 보여준다 — «1블록»으로는 어느 글인지 알 수 없다");
}

console.log(NL + "[★ 지목 없이 보내면 전원에게]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "다들 이거 봐줘");

  const note = t.$("#screen-chat .compose-note");
  ok(!note.classList.contains("bad"), "★ 막지 않는다");
  ok(note.textContent.includes("claude·codex"),
     `★ 그래도 **누구에게 가는지 적혀 있다** — 깜빡은 보내기 전에 드러난다 (${note.textContent})`);

  key(t, box, "Enter");
  const m = t.sent.find((x) => x.t === "sendCompose");
  ok(m !== undefined, "★ 나간다 — @everyone을 매번 치게 하지 않는다");
}

console.log(NL + "[★ Enter로 보낸다 — 토큰 그대로]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla");
  key(t, box, "Tab");
  type(t, box, "리뷰해줘");
  key(t, box, "Enter");

  const m = t.sent.find((x) => x.t === "sendCompose");
  ok(m !== undefined, "★ 나갔다");
  ok(m.tokens[0].kind === "mention" && m.tokens[0].botId === "b1",
     `★ 칩은 mention 토큰으로 (${JSON.stringify(m.tokens[0])})`);
  ok(m.tokens.some((tk) => tk.kind === "text" && tk.text.includes("리뷰해줘")),
     "★ 글자는 text 토큰으로 — 규칙은 코어가 정한다");
  ok(box.querySelectorAll(".chip").length === 0 && box.textContent === "",
     "보내면 상자가 비워진다");
}

console.log(NL + "[조합 중 Enter는 목록도 안 고른다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@");
  key(t, box, "Enter", { isComposing: true });
  ok(box.querySelectorAll(".chip").length === 0,
     "★ 한글 확정용 Enter로 봇이 골라지면 안 된다");
  ok(t.$("#screen-chat .picker") !== null, "목록은 그대로 열려 있다");
}

console.log(NL + "[★ 이미 넣은 봇은 목록에서 빠진다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla");
  key(t, box, "Tab");
  type(t, box, "@");
  const labels = [...t.$("#screen-chat .picker").querySelectorAll("button")].map((b) => b.textContent);
  ok(!labels.some((l) => l.includes("@claude")),
     `★ «(@Claude) @»에서 Claude가 또 뜨면 안 된다 (${labels.join(" | ")})`);
  ok(labels.some((l) => l.includes("@codex")), "남은 봇은 뜬다");
}

console.log(NL + "[Esc는 목록만 닫는다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cod");
  key(t, box, "Escape");
  ok(t.$("#screen-chat .picker") === null, "목록이 닫힌다");
  ok(box.textContent.includes("@cod"), "★ 친 글자는 그대로 남는다");
}

console.log(NL + "[★ 1:1에 봇을 부르면 그 자리에서 칩 상자로 바뀐다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude")]);
  ok(box.tagName === "TEXTAREA", "처음엔 1:1");

  // 봇을 부른 뒤의 방이 내려온다
  t.send({ t: "room", compactable: false,
    room: room([bot("b1", "claude"), bot("b2", "codex")]) });

  const now = t.$("#screen-chat .chipbox");
  ok(now !== null,
     "★ **입력창이 칩 상자로 갈린다** — 안 갈아끼우면 @로 지목할 수가 없어 단체방이 아니게 된다");
  ok(t.$("#screen-chat .composer textarea") === null, "예전 상자는 걱힌다");

  type(t, now, "@");
  ok(t.$("#screen-chat .picker") !== null, "★ 그 자리에서 바로 지목할 수 있다");

  // 다시 하나로 줄면 돌아온다
  t.send({ t: "room", compactable: false, room: room([bot("b1", "claude")]) });
  ok(t.$("#screen-chat .composer textarea") !== null,
     "★ 봇을 내보내면 다시 1:1 입력창");
}

console.log(NL + "[★ 그룹을 여러 번 — 같은 봇을 아래에서 다시 부를 수 있다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);

  // 첫 그룹: 둘 다
  type(t, box, "@cla"); key(t, box, "Tab");
  type(t, box, "@cod"); key(t, box, "Tab");
  type(t, box, NL + "다들 봐줘" + NL + NL);

  // 둘째 그룹을 여는다 — 여기서 Claude가 다시 보여야 한다
  type(t, box, "@");
  const labels = [...t.$("#screen-chat .picker").querySelectorAll("button")].map((b) => b.textContent);
  ok(labels.some((l) => l.includes("@claude")),
     `★ **아래 그룹에서 다시 부를 수 있다** — «다들 보고, Claude는 이것도» (${labels.join(" | ")})`);

  key(t, box, "Tab");
  type(t, box, NL + "너는 고쳐줘");
  key(t, box, "Enter");

  const m = t.sent.find((x) => x.t === "sendCompose");
  const mentions = m.tokens.filter((tk) => tk.kind === "mention").map((tk) => tk.botId);
  ok(mentions.join() === "b1,b2,b1",
     `★ 그룹이 둘이고 b1이 두 번 나온다 (${mentions.join()})`);
}

console.log(NL + "[같은 그룹 안에서는 여전히 한 번만]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla"); key(t, box, "Tab");
  type(t, box, "@");
  const labels = [...t.$("#screen-chat .picker").querySelectorAll("button")].map((b) => b.textContent);
  ok(!labels.some((l) => l.includes("@claude")),
     `★ 바로 옆에 붙은 칩은 뺀다 — 같은 그룹에 두 번 넣을 이유가 없다 (${labels.join(" | ")})`);
}

console.log(NL + "[★ 그룹마다 다른 색 — 어디서 갈라지는지 보이게]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla"); key(t, box, "Tab");
  type(t, box, "리뷰해줘" + NL + NL);
  type(t, box, "@cod"); key(t, box, "Tab");
  type(t, box, "문서도");

  const chips = [...box.querySelectorAll(".chip")];
  ok(chips.length === 2, "칩 둘");
  ok(chips[0].dataset.group === "0" && chips[1].dataset.group === "1",
     `★ **다른 그룹은 다른 색** (${chips.map((c) => c.dataset.group).join(",")})`);

  const rows = [...t.$$("#screen-chat .compose-note .note-row")];
  ok(rows.length === 2, "요약도 두 줄");
  ok(rows[0].dataset.group === chips[0].dataset.group,
     "★ **칩과 요약이 같은 색** — 「어느 칩 — 어떤 글 — 누구에게」가 한 줄로 맞는다");
  ok(rows[0].querySelector(".what").textContent === "리뷰해줘"
     && rows[1].querySelector(".what").textContent === "문서도",
     "★ **어느 글이 누구에게** 가는지 그대로 적힌다");
}

console.log(NL + "[★ 연속 칩은 한 그룹이라 같은 색]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla"); key(t, box, "Tab");
  type(t, box, "@cod"); key(t, box, "Tab");
  type(t, box, "둘 다 봐줘");

  const groups = [...box.querySelectorAll(".chip")].map((c) => c.dataset.group);
  ok(groups[0] === groups[1],
     `★ 사이에 공백만 있으면 한 그룹이다 (${groups.join(",")}) — 규칙은 코어가 정하고 화면은 칠하기만 한다`);
  ok(t.$$("#screen-chat .compose-note .note-row").length === 1, "요약도 한 줄");
}

console.log(NL + "[★ ⏪ 문장 중간 칩도 그룹을 연다 (2026-09-23 정정)]");
{
  /*
   * 🔴 예전에는 *"중간 칩은 참조지 라우팅이 아니다"* 라 색을 안 줬다. 규칙이
   * 바뀌었다 — **칩은 자동완성에서 일부러 고른 것**이라 전부 라우팅이다.
   * 참조는 **글자로** 치면 되고, 글자는 칩이 아니라 색도 그룹도 안 받는다.
   */
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla"); key(t, box, "Tab");
  type(t, box, "이거 ");
  type(t, box, "@cod"); key(t, box, "Tab");
  type(t, box, "저거");

  const chips = [...box.querySelectorAll(".chip")];
  ok(chips[0].dataset.group === "0", "첫 칩은 그룹을 연다");
  ok(chips[1].dataset.group === "1",
     `★ **중간 칩도 제 그룹을 연다** (${chips[1].dataset.group}) — 갈 곳이 둘이면 색도 둘이어야 한다`);
  ok(t.$$("#screen-chat .compose-note .note-row").length === 2,
     "★ 요약도 두 줄 — «어느 글이 누구에게»가 보내기 전에 보인다");
}

console.log(NL + "[★ 칩만 꽂고 아직 안 썼으면 오류가 아니다]");
{
  const t = mount();
  const box = open(t, [bot("b1", "claude"), bot("b2", "codex")]);
  type(t, box, "@cla"); key(t, box, "Tab");

  const note = t.$("#screen-chat .compose-note");
  ok(!note.classList.contains("bad"),
     "★ **지목이 먼저고 지시가 나중이다** — 그 한 박자를 오류로 찍으면 진짜 경고까지 무시하게 된다");
  ok(note.textContent.includes("claude") && note.textContent.includes("적어주세요"),
     `★ 대신 다음에 할 일을 알려준다 (${note.textContent})`);
}

console.log(NL + "전부 통과");
