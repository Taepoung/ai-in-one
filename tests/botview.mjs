/**
 * **봇별 1:1 뷰** (v2.1 · §5) — 단체방 안에서 한 봇과의 줄기만 본다.
 *
 * ★ **뷰는 방이 아니라 필터다.** 데이터는 하나고 보는 창만 다르다. 그래서
 * 별도 화면을 안 만들었다 — 화면을 나누면 «별개 공간»이라는 오해가 **구조에서**
 * 생기고, «1:1 뷰에서 보냄» 같은 표시를 만들고 싶어진다(§5가 하지 말라는 것).
 *
 * ★ v2.0 이 «멘션된 것만 전달»하므로(§4.1.1) **이 뷰가 곧 «그 봇이 실제로 본
 * 전부»** 다. 그래서 필터 규칙은 코어와 **같은 함수**(`inBotView`)를 쓴다 —
 * 어긋나는 순간 이 기능이 거짓말이 된다.
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

const SHELL = `<!DOCTYPE html><html><body><div id="app">
 <section class="screen" id="screen-list" data-active>
  <header class="bar"><h1>AI in One</h1><button class="icon" id="btn-new"></button></header>
  <div class="filter"><input type="text" id="filter"><button class="icon" id="only-here" aria-pressed="false"></button></div>
  <div class="rooms" id="rooms"></div></section>
 <section class="screen" id="screen-new"></section>
 <section class="screen" id="screen-chat"></section>
</div><script type="application/json" id="boot">__BOOT__</script></body></html>`;

const AGENTS = [
  { id: "claude", label: "Claude", color: "#d97757" },
  { id: "codex", label: "Codex", color: "#10a37f" },
];
const META = { id: "r1", title: "섞인 방", kind: "group", cwd: "/ws",
               agentIds: ["claude", "codex"], names: ["구현", "리뷰어"],
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
const BOTH = () => [bot("b1", "claude", "구현"), bot("b2", "codex", "리뷰어")];

/** 섞인 대화 — 구현 줄기 · 리뷰어 줄기 · 둘 다 · 시스템 셋 */
const MSGS = () => [
  { id: "u1", role: "user", text: "구현아 해줘", deliveredTo: ["b1"], createdAt: 1 },
  { id: "a1", role: "agent", text: "구현 답", authorBotId: "b1", deliveredTo: [], createdAt: 2 },
  { id: "u2", role: "user", text: "리뷰어야 봐줘", deliveredTo: ["b2"], createdAt: 3 },
  { id: "a2", role: "agent", text: "리뷰어 답", authorBotId: "b2", deliveredTo: [], createdAt: 4 },
  { id: "u3", role: "user", text: "둘 다 확인", deliveredTo: ["b1", "b2"], createdAt: 5 },
  { id: "s1", role: "system", text: "리뷰어의 모델이 바뀌었습니다.",
    aboutBotIds: ["b2"], deliveredTo: [], createdAt: 6 },
  { id: "s2", role: "system", text: "이제 봇이 여럿입니다 — 기억은 안 나뉩니다.",
    deliveredTo: [], createdAt: 7 },
  { id: "u4", role: "user", text: "구현아 이건 못 갔다", deliveredTo: [],
    notSentTo: ["b1"], sendFailed: "끊김", createdAt: 8 },
];
const room = (bots = BOTH(), msgs = MSGS()) => ({
  id: "r1", title: "섞인 방", cwd: "/ws", participants: bots,
  messages: msgs, unread: 0, createdAt: 1, lastActivityAt: 2,
});

function open(t, bots) {
  t.$(".room").click();
  t.send({ t: "room", room: room(bots), compactable: false });
  return t;
}
/**
 * ⏪ **이름이 아니라 «1:1로 보기» 단추다** (2026-09-30).
 *
 * v2.1 은 봇 이름 자체를 입구로 썼다. 밑줄을 긋고 `›` 를 붙여도
 * «이름인가 단추인가» 가 남아서, 압축·내보내기와 나란한 단추로 옮겼다.
 */
const goBtn = (t, n) =>
  t.$$("#screen-bots .drawer-bot").map((c) =>
    [...c.querySelectorAll("button")].find((b) => /1:1로 보기/.test(b.textContent)))[n];

/** 참여자를 열고 «1:1로 보기» 를 눌러 뷰로 들어간다 — 실제 경로 그대로 */
function enter(t, n) {
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  goBtn(t, n).click();
}
const texts = (t) => t.$$("#screen-chat .msg .bubble").map((n) => n.textContent);

console.log("\n[★ 서랍에서 이름을 누르면 그 봇의 뷰로 간다]");
{
  const t = open(mount());
  ok(t.$("#screen-chat .view-head") === null, "처음엔 방 전체다");
  enter(t, 0);

  const head = t.$("#screen-chat .view-head");
  ok(head !== null, "★ 뷰 헤더로 바뀐다");
  /*
   * 🔴 처음엔 `@구현` 만 크게 띄우고 방 이름은 부제에 흘렸다. 그랬더니
   * **여기가 어디인지 알기 힘들었다** — 방 제목은 평소 헤더에서 늘 그 자리에
   * 있는 것이라, 갑자기 사라지면 «다른 방으로 건너온 것»처럼 읽힌다.
   */
  ok(head.textContent.startsWith("섞인 방"),
     `★ **방 이름이 먼저** (${head.textContent.slice(0, 16)}) — 평소 헤더와 같은 자리`);
  ok(head.querySelector(".view-of")?.textContent === "· @구현",
     `★ 그 옆에 누구 갈래인지 (${head.querySelector(".view-of")?.textContent})`);
  ok(/1:1 뷰/.test(head.textContent), "★ 부제가 «뷰»임을 말한다 (§5)");
  /*
   * ⏪ 서랍이 **화면**이 되면서(2026-09-30) «엘리먼트가 있나» 로는 못 잰다 —
   * 칸은 늘 있고, 보이느냐는 스택이 정한다.
   */
  ok(!t.$$(".screen.active").map((x) => x.id).includes("screen-bots"),
     "★ 참여자 화면은 닫힌다 — 봇 뷰로 들어가면 거기 머물 이유가 없다");
}

console.log("\n[★ 들어갈 수 있다는 티가 난다]");
{
  const t = open(mount());
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  const go = goBtn(t, 0);

  /*
   * ⏪ **`›` 표시를 뺐다** (2026-09-30).
   *
   * 🔴 이름이 본문색에 밑줄도 없어서 눌러지는 티가 안 나던 시절의 처방이다.
   * 이름에 화살표를 붙여 «들어갈 수 있다» 를 말하려 했는데, 그 뒤로도
   * «이름인가 단추인가» 가 계속 남았다. **꾸미는 대신 자리를 옮겼다** —
   * 압축·내보내기와 나란히 서면 단추라는 게 설명 없이 읽힌다.
   */
  ok(go.tagName === "BUTTON", "★ **단추다** — 이름을 꾸며서 단추처럼 보이게 하던 것을 물렀다");
  ok(/1:1로 보기/.test(go.textContent), `★ 무엇인지 글로 말한다 (${go.textContent})`);
  ok(/주고받은 것만/.test(go.title), `★ 눌렀을 때 무엇이 되는지 (${go.title})`);

  /*
   * ★ **압축과 내보내기 사이**. 내보내기는 되돌릴 수 없는 것이라 늘 맨 끝이고,
   * 그 앞이 평범한 동작들의 자리다.
   */
  const row = [...t.$$("#screen-bots .drawer-bot")[0].querySelectorAll("button")]
    .map((b) => b.textContent).filter((x) => /압축|1:1|내보내기/.test(x));
  console.log(`   단추 차례: ${row.join(" / ")}`);
  const at = row.indexOf("1:1로 보기");
  ok(at >= 0 && (row.indexOf("내보내기") < 0 || at < row.indexOf("내보내기")),
     `★ **내보내기보다 앞에** (${row.join(" / ")})`);
}

console.log("\n[★ 그 봇이 본 것만 남는다]");
{
  const t = open(mount());
  ok(texts(t).length === 8, `방 전체에서는 다 보인다 (${texts(t).length})`);

  enter(t, 0);   // 구현
  const seen = texts(t).join(" | ");
  ok(seen.includes("구현아 해줘"), "★ 그 봇에게 간 말");
  ok(seen.includes("구현 답"), "★ 그 봇이 한 말");
  ok(seen.includes("둘 다 확인"), "★ 여럿에게 간 것도 — 그 봇도 받았다");
  ok(!seen.includes("리뷰어야 봐줘"), "★ **남에게 간 말은 없다**");
  ok(!seen.includes("리뷰어 답"), "★ **남이 한 말도 없다** — 봇은 그걸 본 적이 없다");
  ok(seen.includes("못 갔다"),
     "★ **가려다 못 간 것은 남는다** — «안 갔다»는 사실도 그 봇 이야기다");
}

console.log("\n[★ 릴레이로 받은 말은 **양쪽 뷰에** 뜬다 (v3.0 대비)]");
{
  const t = mount();
  t.$(".room").click();
  /*
   * 알파가 베타를 부르면 그 말은 «알파가 쓴 것»이면서 «베타가 받은 것»이다.
   * 🔴 글쓴이로만 가르면 **베타가 실제로 받은 말이 베타 뷰에 안 뜬다** —
   * 이 뷰가 «그 봇이 실제로 본 전부»라는 약속(§5)이 그 순간 깨진다.
   */
  const relay = { id: "rel", role: "agent", text: "리뷰어야 이것 좀 봐줘",
                  authorBotId: "b1", deliveredTo: ["b1", "b2"], createdAt: 9 };
  t.send({ t: "room", room: room(BOTH(), [...MSGS(), relay]), compactable: false });

  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  goBtn(t, 0).click();   // 구현(글쓴이)
  ok(texts(t).join(" | ").includes("리뷰어야 이것 좀"), "★ 글쓴이 뷰에 뜬다");

  t.$("#screen-chat .bar .icon").click();
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  goBtn(t, 1).click();   // 리뷰어(받은 쪽)
  ok(texts(t).join(" | ").includes("리뷰어야 이것 좀"),
     "★ **받은 봇 뷰에도 뜬다** — 실제로 받은 말이 안 보이면 뷰가 거짓말이 된다");
}

console.log("\n[★ 시스템 줄은 주인을 따라간다]");
{
  const t = open(mount());
  enter(t, 0);   // 구현
  let seen = texts(t).join(" | ");
  ok(!seen.includes("리뷰어의 모델이"),
     "★ **남의 설정 이야기는 안 보인다** — 주인이 있는 줄이다");
  ok(seen.includes("기억은 안 나뉩니다"),
     "★ **주인 없는 줄은 어디서나 보인다** — 방 전체 이야기다");

  t.$("#screen-chat .bar .icon").click();   // ← 단체방으로
  enter(t, 1);                              // 리뷰어
  seen = texts(t).join(" | ");
  ok(seen.includes("리뷰어의 모델이"), "★ 주인 쪽 뷰에서는 보인다");
}

console.log("\n[★ 말풍선 우클릭으로도 들어간다]");
{
  const t = open(mount());
  /*
   * 🔴 입구가 **참여자 서랍 하나뿐**이었다. 서랍은 «봇을 관리하는 곳»이라
   * 대화를 읽다가 *"얘랑 한 얘기만 몰아 보고 싶다"* 가 될 때 손이 거기로 안
   * 간다 — 지금 보고 있는 말풍선이 바로 그 봇 것인데도.
   */
  const bubbles = t.$$("#screen-chat .msg");
  const agentMsg = bubbles.find((n) => /리뷰어 답/.test(n.textContent));
  agentMsg.dispatchEvent(new t.w.MouseEvent("contextmenu", { bubbles: true }));

  const item = t.$$("#screen-chat .menu button")
    .find((b) => /1:1 뷰/.test(b.textContent));
  ok(item !== undefined, "★ **말풍선이 누구 것인지 이미 안다** — 고를 것이 없다");
  ok(/리뷰어/.test(item.textContent), `★ 그 봇으로 (${item.textContent})`);
  item.click();
  ok(t.$("#screen-chat .view-head")?.textContent.includes("@리뷰어") === true,
     "★ 그 봇 뷰로 들어간다");
}

console.log("\n[★ 이미 그 봇 뷰면 다시 권하지 않는다]");
{
  const t = open(mount());
  enter(t, 1);   // 리뷰어 뷰
  const agentMsg = t.$$("#screen-chat .msg").find((n) => /리뷰어 답/.test(n.textContent));
  agentMsg.dispatchEvent(new t.w.MouseEvent("contextmenu", { bubbles: true }));
  ok(!t.$$("#screen-chat .menu button").some((b) => /1:1 뷰/.test(b.textContent)),
     "★ **있는 자리로 가는 길은 안 그린다** — 누르면 아무 일도 안 나는 항목이다");
}

console.log("\n[★ 입력창이 1:1 모양이 된다]");
{
  const t = open(mount());
  ok(t.$("#screen-chat .chipbox") !== null, "방 전체에서는 칩 상자");
  enter(t, 0);
  ok(t.$("#screen-chat .chipbox") === null,
     "★ **칩 상자가 아니다** — 그 봇에게만 가므로 `@`를 칠 이유가 없다");
  ok(t.$("#screen-chat .composer textarea") !== null, "★ 한 줄 입력이다");
}

console.log("\n[★ 뷰에서 친 말은 «@그봇»을 붙인 것으로 간다]");
{
  const t = open(mount());
  enter(t, 1);   // 리뷰어
  const box = t.$("#screen-chat .composer textarea");
  box.value = "이거 봐줘";
  t.$$("#screen-chat .composer button").find((b) => /보내기/.test(b.title)).click();

  const sent = t.sent.find((m) => m.t === "sendCompose");
  ok(sent !== undefined,
     "★ **멘션 경로로 간다** — `send` 에 봇 칸을 새로 파면 길이 둘이 된다");
  ok(sent.tokens[0].kind === "mention" && sent.tokens[0].botId === "b2",
     "★ 그 봇을 지목한 것으로");
  ok(sent.tokens[1].text.trim() === "이거 봐줘", "★ 친 글이 그대로");
  ok(t.sent.find((m) => m.t === "send") === undefined, "★ 평범한 전송은 안 쓴다");
}

console.log("\n[★ 뷰 헤더에는 방 조작이 없다 — 봇 조작만]");
{
  const t = open(mount());
  enter(t, 0);
  const titles = t.$$("#screen-chat .bar button").map((b) => b.title);
  ok(!titles.some((x) => /메뉴/.test(x)),
     "★ ⋮ 가 없다 — 이름 바꾸기·나가기는 **방**에 대한 것이라 방으로 나가서 한다");
  ok(titles.some((x) => /참여자/.test(x)), "★ 참여자는 남는다 — 봇에 대한 것이다");
}

console.log("\n[★ 뷰에서 분기하면 그 봇만 (§5 결정 뒤집음)]");
{
  const t = open(mount());
  enter(t, 0);   // 구현
  /*
   * 🔴 원래는 «비활성»이었다. *"단체방 전체가 fork되나, 그 봇만 분리되나"* 하는
   * 모호함 때문이었는데 — **모호함을 없애는 길은 막는 것만이 아니라 «뜻을
   * 정해주는 것»도 있다.** 자리가 뜻을 말한다.
   */
  const fork = t.$$("#screen-chat .bar button").find((b) => /갈라|분기/.test(b.title));
  ok(fork !== undefined, "★ **분기가 있다**");
  ok(/구현만/.test(fork.title), `★ 무엇이 일어날지 단추가 말한다 (${fork.title})`);
  fork.click();

  const card = t.$("#screen-chat .card");
  ok(/구현만 갈라내기/.test(card.textContent), "★ 카드 제목도");
  ok(/이 방은 구현을\(를\) 포함해 그대로 남습니다/.test(card.textContent),
     "★ **원본이 어떻게 되는지** 말한다 — 안 그러면 «이사»로 읽는다");

  card.querySelector("button.primary").click();
  const sent = t.sent.find((m) => m.t === "fork");
  ok(sent.botId === "b1", `★ 그 봇만 가르라고 보낸다 (${sent.botId})`);
}

console.log("\n[★ 단체방에서 분기하면 전체다]");
{
  const t = open(mount());
  const fork = t.$$("#screen-chat .bar button").find((b) => /분기/.test(b.title));
  ok(fork !== undefined, "★ 방 헤더에도 있다");
  fork.click();
  t.$("#screen-chat .card button.primary").click();
  const sent = t.sent.find((m) => m.t === "fork");
  ok(sent.botId === undefined, "★ **봇을 안 지목한다** — 방 전체가 갈라진다");
}

console.log("\n[★ 상태줄도 그 봇 것만 — 중단도 그 봇만]");
{
  const t = open(mount());
  enter(t, 0);   // 구현 뷰
  t.send({ t: "status", roomId: "r1", status: "streaming",
           bots: { b1: "idle", b2: "streaming" } });

  /*
   * 🔴 구현 뷰인데 *"Codex 답하는 중"* 이라고 떴다 — **남의 턴 이야기**다.
   * 그리고 그 옆 «중단»이 방 전체를 끊었다: 구현 것만 보려고 들어온 화면에서
   * **리뷰어의 일을 죽이는** 단추였다.
   */
  const bar = t.$("#screen-chat .status").textContent;
  ok(!/Codex/.test(bar), `★ **남의 턴 이야기가 안 뜬다** (${bar})`);
  ok(!t.$("#screen-chat .status .stop"),
     "★ **중단도 안 뜬다** — 그 봇은 놀고 있다");

  // 그 봇이 도는 중이면 뜬다. 그리고 **그 봇만** 끊는다
  t.send({ t: "status", roomId: "r1", status: "streaming",
           bots: { b1: "streaming", b2: "streaming" } });
  t.$("#screen-chat .status .stop").click();
  const stop = t.sent.find((m) => m.t === "cancel");
  ok(stop.botId === "b1", `★ **그 봇만 끊는다** (${stop.botId})`);
}

console.log("\n[★ 부딪힘 띠도 그 봇이 낀 것만]");
{
  const t = open(mount());
  enter(t, 0);   // 구현
  t.send({ t: "clashes", roomId: "r1", list: [
    { path: "/ws/mine.ts", botIds: ["b1", "b2"], at: 1 },
    { path: "/ws/theirs.ts", botIds: ["b2", "b3"], at: 2 },
  ] });
  const band = t.$("#screen-chat .clashes").textContent;
  ok(/mine.ts/.test(band), "★ 내가 낀 것은 뜬다");
  ok(!/theirs.ts/.test(band),
     `★ **남들끼리 부딪힌 것은 안 뜬다** (${band}) — 남의 사정은 방으로 나가서`);
}

console.log("\n[★ ←는 방이 아니라 뷰를 푼다]");
{
  const t = open(mount());
  enter(t, 0);
  t.$("#screen-chat .bar .icon").click();
  ok(t.$("#screen-chat .view-head") === null, "★ 단체방으로 돌아온다");
  ok(texts(t).length === 8, "★ 다시 다 보인다");
  ok(t.$("#screen-chat").classList.contains("active"), "★ **방을 나가지는 않는다** — ←는 뷰만 푼다");
}

console.log("\n[★ 보던 봇이 방에서 나가면 뷰가 풀린다]");
{
  const t = open(mount());
  enter(t, 1);   // 리뷰어
  ok(t.$("#screen-chat .view-head") !== null, "뷰에 있다");

  // 리뷰어를 내보낸 방이 돌아온다
  t.send({ t: "room", room: room([bot("b1", "claude", "구현")]), compactable: false });
  ok(t.$("#screen-chat .view-head") === null,
     "★ **빈 화면을 보여주지 않는다** — 가리키던 봇이 없으면 방 전체로");
}

console.log("\n전부 통과");
