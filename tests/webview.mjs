/**
 * 웹뷰를 jsdom에 띄우고 실제로 눌러본다.
 *
 * 확장 번들과 달리 웹뷰는 **화면 그 자체**라 여기서만 잡히는 버그가 있다
 * (방을 만들고 안 들어가지는 것, 헤더에 사용량이 중복으로 쌓이는 것 등).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 저장소 안에서 스스로 위치를 찾는다 — 절대경로를 박으면 남의 기계에서 안 돈다
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
// scratchpad가 프로젝트 밖이라 베어 스펙이로는 못 찾는다. 직접 가리킨다.
const { JSDOM } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "jsdom", "lib", "api.js")).href
);

const ok = (c, m) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ok -", m);
};

const AGENTS = [
  { id: "claude", label: "Claude", description: "Claude Code", color: "#d97757" },
  { id: "codex", label: "Codex", description: "OpenAI Codex CLI", color: "#10a37f" },
];

/**
 * 호스트가 내려보내는 에이전트 목록.
 *
 * 로그인이 끝났다는 소식은 **따로 오는 게 아니라** 이걸 다시 내려보내는
 * 것으로 온다(`state: "ready"`) — 그래서 로그인 흐름을 재려면 이게 필요하다.
 */
const agentsMsg = (over = {}) => ({
  t: "agents",
  list: AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    managed: true,
    available: true,
    state: "ready",
    loggedIn: true,
    canLogout: true,
    size: 1024 * 1024,
    ...(over[a.id] ?? {}),
  })),
});

const boot = (rooms = [], screen = "list") => ({
  rooms,
  agents: AGENTS,
  reducedMotion: true,
  screen,
  cwd: "/ws",
  hasWorkspace: true,
});

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

/** 웹뷰를 띄우고, 보낸 메시지를 모으는 핸들을 돌려준다 */
function mount(bootState) {
  const sent = [];
  const dom = new JSDOM(SHELL.replace("__BOOT__", JSON.stringify(bootState)), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const w = dom.window;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};

  w.eval(fs.readFileSync(path.join(ROOT, "dist", "webview.js"), "utf8"));

  const $ = (sel) => w.document.querySelector(sel);
  return {
    w,
    sent,
    $,
    $$: (sel) => [...w.document.querySelectorAll(sel)],
    send: (msg) => w.dispatchEvent(new w.MessageEvent("message", { data: msg })),
    key: (k) => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true })),
    screenOf: () =>
      ["list", "new", "chat"].find((n) => $(`#screen-${n}`).classList.contains("active")),
  };
}

/**
 * 목록에서 방을 눌러 들어간 상태를 만든다.
 *
 * `room` 메시지만 보내면 내용은 그려지지만 **화면은 바뀌지 않는다** —
 * 목록을 보는 중에 다른 방 갱신이 왔다고 끌려 들어가면 안 되기 때문이다.
 */
function enter(t, over = {}) {
  t.$(".room").click();
  t.send({ t: "room", room: room(over), compactable: false });
  /*
   * ★ **붙는 화면을 지나야 채팅이다** (2026-10-13).
   *
   * 방을 누르면 「붙는 중」 화면에 선다. 「다 붙었다」는 **코어만** 아는
   * 것이라(`joinDone`) 화면이 추론하지 않는다 — 여기서도 그 줄을 보낸다.
   */
  t.send({ t: "joinDone", roomId: "r1" });
  return t;
}

/** 방 만들기 화면의 **설정 줄 라벨**만 (에이전트·역할은 폼 고정 항목) */
const labelsOf = (t) =>
  t.$$("#screen-new fieldset.bot .field > label")
    .map((l) => l.textContent)
    .filter((x) => x !== "에이전트" && x !== "역할 (선택)");

const room = (over = {}) => ({
  id: "r1",
  title: "리팩터링",
  cwd: "/ws",
  participants: [{ id: "b1", agentId: "claude", name: "Claude", sessionId: "s1",
                   approver: { kind: "user" }, answerPolicy: "ask" }],
  messages: [],
  unread: 0,
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
  ...over,
});

const msg = (over = {}) => ({
  id: "m1",
  role: "agent",
  text: "안녕하세요",
  deliveredTo: [],
  createdAt: Date.now(),
  ...over,
});

const meta = (over = {}) => ({
  id: "r1",
  title: "리팩터링",
  kind: "direct",
  cwd: "/ws",
  agentIds: ["claude"],
  unread: 0,
  createdAt: 1,
  lastActivityAt: 2,
  ...over,
});

function main() {
  console.log("\n[첫 페인트 — 목록이 이미 있다 (F8)]");
  {
    const t = mount(boot([meta({ unread: 3 })]));
    ok(t.screenOf() === "list", "목록 화면");
    ok(t.$(".room-title").textContent === "리팩터링", "방 이름이 그려짐");
    ok(t.$(".badge").textContent === "3", "안 읽음 배지 3");
  }

  console.log("\n[목록 한 줄 — 유형 아이콘 · 제목 · 시각 / 누구와 · 폴더 (B5·B10)]");
  {
    const t = mount(boot([meta({ models: ["Opus 5"], cwd: "/other/repo" })]));

    // 색 점이 아니라 모양이다 — 색 점은 «봇 둘»과 «작업 중»이 충돌해서 뺐다
    ok(t.$(".room .dot") === null, "**색 점이 없다**");
    ok(t.$(".room-icon .codicon-comment") !== null, "1:1은 말풍선 아이콘");

    // 둘째 줄은 **부를 이름만** — 모델은 툴팁으로 접는다(§0)
    ok(t.$(".room-who").textContent === "Claude",
       `**제목 아래는 누구와** (${t.$(".room-who").textContent})`);
    ok(t.$(".room-who").title === "Claude · Opus 5",
       `★ **모델은 툴팁에** (${t.$(".room-who").title})`);
    ok(t.$(".room-cwd").textContent.includes("repo"), "**폴더는 시각 아래로**");
    ok(t.$(".room-cwd").classList.contains("elsewhere"), "다른 프로젝트면 표시가 다르다");

    // 순서까지 확인한다 — 제목 아래가 폴더면 옮긴 의미가 없다
    const spans = t.$$(".room-main span");
    ok(spans.indexOf(t.$(".room-who")) < spans.indexOf(t.$(".room-cwd")),
       "누구와가 먼저, 폴더가 나중");
  }

  console.log("\n[모델을 아직 모르면 에이전트 이름만]");
  {
    const t = mount(boot([meta()]));
    ok(t.$(".room-who").textContent === "Claude",
       "한 번도 안 연 방은 모델이 없다 — 지어내지 않는다");

    const g = mount(boot([meta({ kind: "group", agentIds: ["claude", "codex"],
      models: ["Opus 5", ""] })]));
    ok(g.$(".room-icon .codicon-organization") !== null, "단체방은 다른 아이콘");
    ok(g.$(".room-who").textContent === "Claude, Codex", "줄에는 이름만");
    ok(g.$(".room-who").title === "Claude · Opus 5, Codex",
       `★ 툴팁에는 **아는 모델만** 붙는다 — 모르면 지어내지 않는다 (${g.$(".room-who").title})`);
  }

  console.log("\n[작업 중이면 그게 먼저다 — 폴더는 그대로 남는다]");
  {
    const t = mount(boot([meta()]));
    t.send({ t: "status", roomId: "r1", status: "streaming" });
    ok(t.$(".room-who .busy").textContent === "답하는 중…", "왼쪽은 하는 일이 가져간다");
    ok(t.$(".room-cwd") !== null, "**폴더는 안 밀려난다** — 자리가 다르다");
  }

  console.log("\n[방을 만들면 바로 그 방으로 들어간다]");
  {
    const t = mount(boot([], "new"));
    ok(t.screenOf() === "new", "만들기 화면으로 열림");
    t.$("#screen-new .actions .primary").click();
    ok(t.sent.some((m) => m.t === "createRoom"), "createRoom 전송됨");

    /*
     * ★ **만든 방도 붙는 화면을 거친다** (사용자, 2026-10-15):
     * *"새로운 방 만들때, 방 진입시 로딩화면이 안뜨음, 같은 과정이
     * 되어야될거 같은데"*.
     *
     * 🔴 만든 방도 세션을 붙이는 것은 마찬가지다(Antigravity 는 17초).
     * 그동안 빈 대화창에 서 있으면 «다 된 것» 으로 보여 글을 치게 되고,
     * 그 한 마디는 봇이 아직 없어 **줄에 서 있다가 나중에** 간다.
     */
    t.send({ t: "room", room: room(), compactable: false });
    ok(t.$("#screen-joining").classList.contains("active"),
       "★ **붙는 화면이 먼저다** — 들어가는 두 길의 모양이 같다");
    ok(t.$("#screen-joining h1").textContent.startsWith("리팩터링"), "제목은 거기서도 보인다");

    t.send({ t: "joinDone", roomId: "r1" });
    t.send({ t: "room", room: room(), compactable: false });
    ok(t.screenOf() === "chat", "★ 다 붙으면 채팅이다");
    ok(t.$("#screen-chat h1").textContent.startsWith("리팩터링"), "제목이 헤더에");
  }

  console.log("\n[★ 목록에서 누르면 **붙는 화면을 지나** 채팅이다 (2026-10-13)]");
  {
    /*
     * 🔴 여태 채팅이 **바로** 열리고 뒤에서 붙었다. 그래서 셋이 어긋났다:
     * 쓸 수 있는 것처럼 보이고, 실패가 말풍선으로 기록에 박히고, 처음 쓰는
     * 방에서 모델이 없어졌으면 **보던 채팅에서 fix 로 끌려갔다.**
     */
    const t = mount(boot([meta()]));
    t.$(".room").click();
    ok(t.sent.some((m) => m.t === "open" && m.roomId === "r1"), "open 전송");
    ok(t.$("#screen-joining").classList.contains("active"),
       "★ **붙는 화면에 선다** — 아직 세션이 없는데 입력창을 열어두면 거짓말이다");

    t.send({ t: "room", room: room(), compactable: false });
    ok(t.$("#screen-joining").classList.contains("active"),
       "★ 방이 와도 **그것만으로는 안 넘어간다**");

    t.send({ t: "joinDone", roomId: "r1" });
    ok(t.screenOf() === "chat",
       "★ **끝났다고 해야 넘어간다** — «다 붙었다» 를 화면이 추론하지 않는다");
  }

  console.log("\n[★ 점은 «글자가 오나» 가 아니라 **«턴을 쥐고 있나»** 다 (2026-10-13)]");
  {
    /*
     * 🔴 점을 그리는 조건이 `m.streaming` 이었다. 그 칸은 **턴이 정상으로
     * 끝날 때에만** 내려가므로, CLI 가 중간에 죽으면 아무도 안 내린다 —
     * 상태는 `error` 가 되고 「프로세스가 종료되어…」 까지 뜨는데 **그 바로
     * 위에서 점이 돈다.** 그냥 고장이다.
     *
     * 멈추는 조건을 하나씩 더하는 대신 **묻는 것을 바꿨다.**
     */
    const live = msg({ id: "a1", streaming: true, authorBotId: "b1" });
    const t = enter(mount(boot([meta()])), { messages: [live] });

    /* 🔴 상태 줄에도 같은 class 의 점이 있다 — **말풍선 안쪽**만 센다 */
    const dots = () => t.$$("#screen-chat .bubble .typing").length;

    t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming" } });
    ok(dots() > 0, "글자가 오는 중 — 점이 돈다");

    t.send({ t: "status", roomId: "r1", status: "tool", bots: { b1: "tool" } });
    ok(dots() > 0,
       "★ **도구를 돌리는 중에도 돈다** — 글자는 안 오지만 일하고 있다");

    /*
     * ⏪ **승인 대기도 돈다** (2026-10-13 정정). 하루 전엔 여기서 멈췄다 —
     * «점이 돌면 사용자는 자기를 기다리는 줄 모른다». 그런데 그 일은 **승인
     * 카드**가 한다(큐 자리에 붙박이로 뜬다). 점까지 그 일을 하려 들면
     * 규칙이 둘이 된다.
     *
     * 그리고 «멈췄다»는 **우리 눈에만** 그렇다 — 저쪽 턴은 `prompt` 안에서
     * 열린 채 살아 있고, 답을 주면 바로 이어진다. 점이 꺼지면 사용자는
     * «끝났거나 죽었다»로 읽는다.
     */
    t.send({ t: "status", roomId: "r1", status: "permission", bots: { b1: "permission" } });
    ok(dots() > 0,
       "★ **승인을 기다려도 돈다** — 턴은 열린 채다. «기다린다» 는 카드가 말한다");

    t.send({ t: "status", roomId: "r1", status: "error", bots: { b1: "error" } });
    ok(dots() === 0,
       "★ **CLI 가 죽어도 멈춘다** — 여기가 고장나 있던 자리다 (streaming 은 true 인 채다)");
  }

  console.log("\n[★ 붙는 일은 **두 칸**이다 — 띄우기와 세션 (2026-10-13)]");
  {
    /*
     * 🔴 「여는 중…」 한 줄이면 Antigravity 의 17.5초가 **통째로 한 덩어리**로
     * 보인다 — 12.5초는 띄우는 데, 5초는 세션에 쓰는데 그걸 모르면 멈춘 것
     * 같다. 단위도 다르다: CLI 는 **에이전트마다** 하나고, 세션은 봇마다다.
     */
    const t = mount(boot([meta()]));
    t.$(".room").click();
    t.send({ t: "room", room: room(), compactable: false });

    t.send({ t: "joinStep", roomId: "r1", botId: "b1", step: "start" });
    ok(t.$("#screen-joining").textContent.includes("띄우는 중"),
       "★ **띄우는 칸이 보인다** — 여기가 12.5초짜리다");
    ok(t.$("#screen-joining").textContent.includes("Claude"),
       "★ 어느 **에이전트**를 띄우는지 적는다 — 봇 이름이 아니다");

    t.send({ t: "joinStep", roomId: "r1", botId: "b1", step: "session" });
    const say = t.$("#screen-joining").textContent;
    ok(say.includes("세션을 여는 중") && !say.includes("띄우는 중"),
       "★ **다음 칸으로 넘어간다**");
  }

  console.log("\n[★ 「응답이 중단되었습니다」 를 **두 번 말하지 않는다** (2026-10-13)]");
  {
    /*
     * 🔴 사용자가 받은 것: 똑같은 줄이 **두 번.**
     *
     * 끊긴 답이 **빈 답**이면 `healAfterCrash` 가 둘을 같이 세운다 —
     * `truncated` 와 `error = "응답이 중단되었습니다."`. 말풍선이 통째로
     * 비는 것보다는 낫기 때문인데, 그 둘의 **글자까지 똑같아서** 나란히 떴다.
     */
    const dead = msg({ id: "a1", text: "", truncated: true, error: "응답이 중단되었습니다." });
    const t = enter(mount(boot([meta()])), { messages: [dead] });
    const says = t.$$("#screen-chat .meta")
      .map((e) => e.textContent)
      .filter((x) => x.includes("응답이 중단되었습니다"));
    ok(says.length === 1, `★ **한 번만 말한다** (${says.length}번)`);

    /* 글이 있으면 «여기서 잘렸다» 는 따로 뜻이 있다 — 그건 그대로 뜬다 */
    const cut = msg({ id: "a2", text: "여기까지 쓰다가", truncated: true });
    const t2 = enter(mount(boot([meta()])), { messages: [cut] });
    ok(t2.$$("#screen-chat .meta").some((e) => e.textContent.includes("응답이 중단되었습니다")),
       "★ **자를 글이 있으면 말한다** — 「잘렸다」 는 글이 있어야 하는 말이다");
  }

  console.log("\n[★ 못 붙은 봇 — **붙는 화면은 기다리고, fix 가 정한다** (2026-10-13)]");
  {
    /*
     * 고치는 길이 **까닭마다 다르다.** 한 덩어리로 «실패» 라고만 하면 화면이
     * 무슨 단추를 달아야 할지 모른다.
     *
     * 🔴 한때 그 단추들이 **붙는 화면에** 달려 있었다([로그인]·[고치기]).
     * 그러면 아직 붙는 중인 봇 옆에서 결정을 내리게 되고, 돌아와 보면 그
     * 사이에 다른 봇도 걸려 있다. 자리를 둘로 나눈다 — **붙는 화면은
     * 기다리는 자리**(그 자리 재시도만), **`fix` 는 정하는 자리.**
     */
    const t = mount(boot([meta()]));
    t.$(".room").click();
    t.send({ t: "room", room: room(), compactable: false });
    t.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "other", why: "시간이 지났습니다" });

    const scr = t.$("#screen-joining");
    ok(scr.classList.contains("active") && scr.textContent.includes("시간이 지났습니다"),
       "★ **붙는 중에는 그 줄에 적는다** — 아직 다른 봇을 기다릴 수 있다");
    const waiting = [...scr.querySelectorAll(".auth-acts button")].map((b) => b.textContent);
    ok(waiting.join() === "다시 시도",
       `★ 기다리는 자리에는 **[다시 시도] 하나**뿐 (${waiting.join(",")})`);

    t.send({ t: "joinDone", roomId: "r1" });
    const fix = t.$("#screen-fix");
    ok(fix.classList.contains("active"),
       "★ **다 끝난 뒤에 한 번** fix 로 — 걸린 봇이 한꺼번에 카드로 선다");
    ok(fix.textContent.includes("시간이 지났습니다"),
       "★ **까닭을 그대로 적는다** — 기록이 아니라 이 화면에");
    ok(!fix.querySelector(".fix-bot select"),
       "★ **고르개는 안 뜬다** — 모델은 멀쩡하다. 띄우면 «모델을 바꾸라는 건가» 가 된다");

    const btns = [...fix.querySelectorAll(".fix-bot button")].map((b) => b.textContent);
    ok(btns.join() === "다시 시도,내보내기", `★ 할 수 있는 것이 둘뿐 (${btns.join(",")})`);
    /*
     * 🔴 **「그냥 들어가기」를 안 둔다** (2026-10-13).
     *
     * 반쯤 깨진 봇을 달고 들어가면 **상태가 헷갈린다** — 멘션은 되는데 답이
     * 안 오고, 그 까닭이 어디에도 안 적혀 있다. 답은 둘뿐이다: **고치거나,
     * 내보내거나.**
     */
    ok(!btns.includes("그냥 들어가기"),
       "★ **반쯤 깨진 채로는 안 들여보낸다** — 고치거나 내보내거나다");

    [...fix.querySelectorAll(".fix-bot button")].find((b) => b.textContent === "다시 시도").click();
    const sent = t.sent.filter((x) => x.t === "retryJoin").pop();
    ok(sent?.botId === "b1", `★ **그 봇만** 다시 (${JSON.stringify(sent)})`);
    ok(t.$("#screen-joining").classList.contains("active"),
       "★ 그리고 **기다리는 자리로 돌아간다** — 세워두면 아무 일도 안 일어난 것 같다");
  }

  console.log("\n[★ 다른 곳이 세션을 쓰고 있다 — 다시 시도 · 새 세션으로 시작 · 내보내기 (2026-10-20)]");
  {
    /*
     * 사용자: *"[다시 시도] · [내보내기] + 새로운 세션으로 시작하는 옵션들"*.
     * 권하는 쪽은 [다시 시도] — 저쪽만 닫으면 그 세션 그대로다. 새로 시작하는 단추는
     * 갈아타기와 같은 말(무엇을 실어 보내나). 요약은 방에 요약이 있을 때만.
     */
    const t = mount(boot([meta()]));
    t.$(".room").click();
    t.send({ t: "room", room: room({ messages: [
      { id: "u1", role: "user", text: "안녕", deliveredTo: ["b1"], createdAt: 1 },
    ] }), compactable: false });
    t.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "inUse",
             why: "다른 곳(앱 · CLI · 다른 창)에서 이 세션을 쓰고 있어 이어받지 못했습니다." });
    t.send({ t: "joinDone", roomId: "r1" });
    const fix = t.$("#screen-fix");
    ok(fix.classList.contains("active"), "★ fix 에서 받는다 — 새 세션으로 뚫고 들어가지 않는다");
    const btns = [...fix.querySelectorAll(".fix-bot button")].map((b) => b.textContent);
    ok(btns.join() === "다시 시도,대화 넘겨서 새로 시작,기록만 두고 새로 시작,내보내기",
       `★ 고를 것 — 요약이 없는 방이라 «요약만» 은 없다 (${btns.join(",")})`);
    ok(fix.querySelector(".fix-bot .agent-go")?.textContent === "다시 시도",
       "★ **권하는 쪽은 [다시 시도]** — 저쪽만 닫으면 이 세션 그대로다");
    ok(/지우지 않습니다/.test(fix.textContent), "★ 새로 시작해도 저쪽 세션은 안 지운다고 적는다");

    t.sent.length = 0;
    [...fix.querySelectorAll(".fix-bot button")].find((b) => b.textContent === "기록만 두고 새로 시작").click();
    const sent = t.sent.filter((x) => x.t === "freshSession");
    ok(sent.length === 1 && sent[0].botId === "b1" && sent[0].carry === "none",
       `★ 고른 대로 보낸다 (${JSON.stringify(sent)})`);

    // 요약이 있는 방이면 «요약만» 도 선다
    const t2 = mount(boot([meta()]));
    t2.$(".room").click();
    t2.send({ t: "room", room: room({ messages: [
      { id: "c1", role: "system", text: "— 압축 —", summary: "앞의 요약", deliveredTo: [], createdAt: 1 },
    ] }), compactable: false });
    t2.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "inUse", why: "쓰고 있음" });
    t2.send({ t: "joinDone", roomId: "r1" });
    const btns2 = [...t2.$$("#screen-fix .fix-bot button")].map((b) => b.textContent);
    ok(btns2.includes("요약만 넘겨서 새로 시작"), `★ 요약이 있으면 «요약만» 도 (${btns2.join(",")})`);

    // 다른 까닭(other)에는 새 세션 단추가 없다 — 쓰고 있음일 때만
    const t3 = mount(boot([meta()]));
    t3.$(".room").click();
    t3.send({ t: "room", room: room(), compactable: false });
    t3.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "other", why: "시간이 지났습니다" });
    t3.send({ t: "joinDone", roomId: "r1" });
    ok(![...t3.$$("#screen-fix .fix-bot button")].some((b) => /새로 시작/.test(b.textContent)),
       "★ «쓰고 있음» 이 아니면 새로 시작 단추는 없다");
  }

  console.log("\n[★ 로그인이 풀린 봇 — **그 자리에서 띄우고, 마치면 저절로 붙는다** (4.5-U)]");
  {
    /*
     * 자격은 **우리 것이 아니다**(P3). 진짜 로그인은 VS Code 가 띄우는
     * 터미널(또는 ACP 가 여는 브라우저)에서 일어난다 — 우리 창 밖이다.
     *
     * 🔴 그래서 처음엔 로봇 화면으로 **보냈다.** 그러면 같은 단추를 **한 번 더**
     * 눌러야 했고, 그 사이 로봇 화면이 보여주는 것은 없었다. 사용자:
     * *"그자리에서 로그인 되면서 에이전트 화면에도 업데이트 되면 좋겠는데"*.
     */
    const t = mount(boot([meta()]));
    t.$(".room").click();
    t.send({ t: "room", room: room(), compactable: false });
    t.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "auth", why: "로그인이 필요합니다" });
    t.send({ t: "joinDone", roomId: "r1" });

    const fix = t.$("#screen-fix");
    const btn = (name) =>
      [...fix.querySelectorAll(".fix-bot button")].find((b) => b.textContent === name);
    const btns = [...fix.querySelectorAll(".fix-bot button")].map((b) => b.textContent);
    ok(btns.join() === "로그인,다시 확인,내보내기",
       `★ **줄이 까닭마다 갈린다** — 여기만 [로그인] 이 선다 (${btns.join(",")})`);

    btn("로그인").click();
    const did = t.sent.filter((m) => m.t === "agentDo").pop();
    ok(did?.what === "login" && did.agentId === "claude",
       `★ **그 자리에서 쏜다** — 로봇 화면의 그 단추와 같은 것이다 (${JSON.stringify(did)})`);
    ok(fix.classList.contains("active"),
       "★ 화면은 **그대로다** — 어차피 포커스는 터미널로 간다");
    ok(fix.textContent.includes("저절로 다시 붙습니다"),
       "★ **다음에 무슨 일이 일어나는지 적는다** — 돌아왔을 때 아무 말도 없으면 «눌린 건가» 가 된다");
    ok(btn("로그인").disabled, "★ 두 번 띄우지 않는다");

    /*
     * 로그인이 끝났다는 소식은 **목록으로** 온다 — 호스트가 터미널이 닫히면
     * 바로, 안 닫으면 20초 뒤에 다시 내려보낸다.
     */
    t.send(agentsMsg());
    const again = t.sent.filter((m) => m.t === "retryJoin").pop();
    ok(again?.botId === "b1",
       `★ **저절로 다시 붙는다** — [다시 확인] 을 또 누르게 하지 않는다 (${JSON.stringify(again)})`);
    ok(t.$("#screen-joining").classList.contains("active"),
       "★ 그리고 **기다리는 자리로** — 다시 붙는 데 길면 수십 초다");
  }

  console.log("\n[★ 보던 중에 끊겨도 **보인다** (4.5-V, 2026-10-13)]");
  {
    /*
     * 🔴 한 번 들어간 방은 다시 들어갈 때 **붙는 화면을 안 지난다**(`joined`) —
     * 바로 채팅이다. 그런데 호스트는 그동안 세션을 다시 붙이고 있고, **그게
     * 실패하면 아무 데도 안 보였다.** 잘 되면 상태 줄로 지나가지만 실패는
     * 지나갈 자리가 없다.
     */
    const t = enter(mount(boot([meta()])));
    ok(t.screenOf() === "chat", "들어와 있다");

    t.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "other", why: "세션을 열지 못했습니다" });
    const scr = t.$("#screen-joining");
    ok(scr.classList.contains("active") && scr.textContent.includes("세션을 열지 못했습니다"),
       "★ **끊긴 것이 화면으로 올라온다** — 전에는 아무 데도 안 보였다");

    t.key("Escape");
    ok(t.screenOf() === "chat",
       "★ **얹은 것이다** — 뒤로 누르면 보던 채팅이 그대로 있다");
  }

  console.log("\n[★ 로봇 화면에서는 **끌어내지 않는다**]");
  {
    /*
     * 🔴 목록이 올 때마다 막힌 방이 있으면 `go(\"fix\")` 를 했다. 그런데
     * 로그인·받기·지우기는 **거기서 하는 일**이라, 하던 중에 화면이
     * 갈아끼워지면 일이 날아간다. 대신 **뒤에 깔린 자리를 바꿔둔다.**
     */
    const t = mount(boot([meta()]));
    t.$(".room").click();
    t.send({ t: "room", room: room(), compactable: false });
    t.send({ t: "joinFail", roomId: "r1", botId: "b1", kind: "auth", why: "로그인이 필요합니다" });
    t.send({ t: "joinDone", roomId: "r1" });
    t.send({ t: "nav", screen: "agents" });

    /* 아직 로그인 전이다 — 목록이 와도 그대로 둔다 */
    t.send(agentsMsg({ claude: { state: "needLogin", loggedIn: false } }));
    ok(t.$$(".screen.active").map((x) => x.id).includes("screen-agents"),
       "★ **하던 일이 안 날아간다**");
    ok(!t.sent.some((m) => m.t === "retryJoin"),
       "★ 아직 로그인이 안 됐으면 **다시 붙이지도 않는다** — ready 만 본다");

    t.key("Escape");
    ok(t.$("#screen-fix").classList.contains("active"),
       "★ 뒤로 가면 **그때 맞는 화면**이 나온다 — 비워둔 화면으로 돌아가지 않는다");
  }

  console.log("\n[★ 기록만 읽기 — **붙이지 않고** 연다]");
  {
    /*
     * 「잠깐 뭐라고 했더라」 보러 들어온 사람에게 **Antigravity 17초**를
     * 물릴 이유가 없다 — 기록은 우리 것이라 CLI 가 없어도 읽힌다.
     */
    const t = mount(boot([meta()]));
    const row = t.$(".room");
    row.dispatchEvent(new t.w.MouseEvent("contextmenu", { bubbles: true }));
    const items = [...t.$$("#screen-list .menu button")].map((b) => b.textContent);
    ok(items.includes("기록만 읽기"), `★ 우클릭에 있다 (${items.join(",")})`);

    [...t.$$("#screen-list .menu button")].find((b) => b.textContent === "기록만 읽기").click();
    ok(t.sent.some((m) => m.t === "peek" && m.roomId === "r1"),
       "★ **붙이지 말라고 말한다** — open 이 아니다");
    ok(t.screenOf() === "chat", "★ 그리고 바로 채팅이다 — 기다릴 것이 없다");

    /*
     * ★ **보기만 하는 방에는 손댈 것이 없다** (사용자, 2026-10-15):
     * *"기록만 읽기 방에서 입력창 제거. 참여자 서랍 버튼, 분기버튼, ...버튼
     * 제거, 뒤로가기랑 방 정보만 보이게"*.
     *
     * 🔴 셋 다 **방에 붙어 있어야** 뜻이 있다. 눌리면 «왜 아무 일도 안
     * 일어나지»가 되고, 어떤 것은 붙이는 일을 몰래 시작한다 — 17초를
     * 피하려고 들어온 자리에서 그러면 들어온 까닭이 사라진다.
     */
    t.send({ t: "room", room: room(), compactable: false });
    const bar = t.$("#screen-chat .bar");
    const icons = [...bar.querySelectorAll("button")].map((b) => b.title);
    ok(icons.join() === "목록", `★ **뒤로가기 하나뿐** (${icons.join(" · ")})`);
    ok(bar.querySelector("h1") !== null, "★ 방 정보는 남는다");
    ok(t.$("#screen-chat .composer").hidden === true,
       "★ **입력창이 없다** — 보낼 곳이 없는데 서 있으면 눌러 보게 된다");
    ok(bar.querySelector("h1 .sub").textContent.includes("기록만"),
       `★ **왜 없는지 적는다** (${bar.querySelector("h1 .sub").textContent}) — 아니면 고장으로 보인다`);

    /* 제대로 들어가면 도로 생긴다 — 표시는 방에 붙는 것이 아니라 «지금 보는 길»이다 */
    t.$("#screen-chat .bar button").click();
    t.$(".room").click();
    t.send({ t: "joinDone", roomId: "r1" });
    t.send({ t: "room", room: room(), compactable: false });
    ok(t.$("#screen-chat .composer").hidden === false,
       "★ 들어가면 입력창이 돌아온다");
    ok([...t.$$("#screen-chat .bar button")].length > 1,
       "★ 단추들도 돌아온다");
  }

  console.log("\n[스트리밍 중 입력창이 살아 있다]");
  {
    const t = mount(boot());
    t.send({ t: "room", room: room(), compactable: false });
    const box = t.$("#screen-chat .composer textarea");
    box.value = "쓰던 중이었어요";
    box.focus();

    for (let i = 0; i < 10; i++) {
      t.send({ t: "msg", roomId: "r1", message: msg({ text: "답".repeat(i), streaming: true }) });
    }
    const after = t.$("#screen-chat .composer textarea");
    ok(after === box, "입력창 노드가 그대로다 (다시 만들지 않는다)");
    ok(after.value === "쓰던 중이었어요", "쓰던 글이 남아 있다");
    ok(t.w.document.activeElement === box, "포커스도 유지된다");
  }

  console.log("\n[표 — 에이전트가 비교·요약에 자주 쓴다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", createdAt: 1, deliveredTo: [], text:
        "비교:\n\n| 이름 | 값 | 비고 |\n|---|:-:|---:|\n| A | 1 | 좋음 |\n| B | 2 | `코드` |\n\n끝." },
    ]}});

    ok(t.$("table") !== null, "**표로 그려진다** — 예전엔 |---|가 그대로 나왔다");
    ok(t.$$("th").map((x) => x.textContent).join(",") === "이름,값,비고", "머리 줄");
    ok(t.$$("tbody tr").length === 2, "본문 2줄");
    ok(t.$$("tbody tr")[1].querySelector("code") !== null, "칸 안의 서식도 산다");
    ok(t.$$("th")[1].style.textAlign === "center", "`:-:`는 가운데");
    ok(t.$$("th")[2].style.textAlign === "right", "`--:`는 오른쪽");
    ok(t.$(".table-wrap") !== null, "좁으면 표만 가로 스크롤");
    ok(t.$$("p").some((p) => p.textContent.includes("끝")), "표 뒤 문단도 이어진다");
  }

  console.log("\n[구분선이 없으면 표가 아니다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", createdAt: 1, deliveredTo: [], text: "a | b 를 비교했다" },
    ]}});
    ok(t.$("table") === null, "**파이프만 있는 문장을 표로 만들지 않는다**");
  }

  console.log("\n[칸이 모자란 줄도 버리지 않는다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", createdAt: 1, deliveredTo: [], text:
        "| A | B |\n|---|---|\n| 하나 |" },
    ]}});
    ok(t.$("table") !== null, "표는 그린다");
    ok(t.$$("tbody td").length === 2, "**모자란 칸은 비워 채운다** — 통째로 안 보이는 것보단 낫다");
  }

  console.log("\n[폴더가 안 열려 있으면 «다른 프로젝트» 말을 안 한다 (B9)]");
  {
    // `boot.cwd`는 워크스페이스가 없으면 홈으로 떨어진다. 그걸 기준으로
    // 비교하면 **사용자가 직접 고른 폴더**를 두고 경고하게 된다.
    const t = enter(mount({ ...boot([meta()]), hasWorkspace: false, cwd: "/home/me" }));
    t.send({ t: "room", compactable: false, room: { ...room(), cwd: "/work/repo" } });
    ok(t.$(".banner") === null, "**안 사라지는 상자가 생기지 않는다**");
  }

  console.log("\n[폴더가 열려 있으면 여전히 알려준다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), cwd: "/other/repo" } });
    ok(t.$(".banner") !== null, "다른 폴더의 방이면 말해준다");
    ok(t.$(".banner").textContent.includes("repo"), "어느 폴더인지도");
  }

  console.log("\n[같은 봇이 이어서 말하면 이름을 한 번만 (C1)]");
  {
    const t = enter(mount(boot([meta()])));
    const at = (n) => 1000 * 60 * n;
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", authorBotId: "b1", text: "하나", deliveredTo: [], createdAt: at(1) },
      { id: "a2", role: "agent", authorBotId: "b1", text: "둘", deliveredTo: [], createdAt: at(2) },
      { id: "u1", role: "user", text: "고마워", deliveredTo: [], createdAt: at(3) },
      { id: "a3", role: "agent", authorBotId: "b1", text: "셋", deliveredTo: [], createdAt: at(4) },
      { id: "a4", role: "agent", authorBotId: "b1", text: "한참 뒤", deliveredTo: [], createdAt: at(60) },
    ]}});

    const names = t.$$(".msg.agent").map((n) => n.querySelector(".who") !== null);
    ok(names.join(",") === "true,false,true,true",
       `**이어지면 생략, 끊기면 다시** (${names.join(",")})`);
    ok(t.$$(".msg.grouped").length === 1, "묶인 건 하나뿐");
    ok(t.$$(".msg.agent")[1].querySelector(".bubble") !== null, "말풍선은 그대로 있다");
  }

  console.log("\n[다른 봇이 끼면 이름이 다시 나온다 (v2.0 대비)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", authorBotId: "b1", text: "나", deliveredTo: [], createdAt: 1 },
      { id: "a2", role: "agent", authorBotId: "b2", text: "나도", deliveredTo: [], createdAt: 2 },
      { id: "a3", role: "agent", authorBotId: "b1", text: "다시 나", deliveredTo: [], createdAt: 3 },
    ]}});
    const names = t.$$(".msg.agent").map((n) => n.querySelector(".who") !== null);
    ok(names.every(Boolean), "**봇이 바뀌면 매번 이름** — 누가 한 말인지가 제일 중요하다");
  }

  console.log("\n[활동은 «무엇을 했는지»가 보여야 한다 (C3)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "했습니다", deliveredTo: [], createdAt: 1, tools: [
        { id: "t1", title: "Bash", kind: "execute", status: "completed",
          command: "rm -rf build && npm run build", at: 1000 * 60 * 63 },
        { id: "t2", title: "Read", kind: "read", status: "completed", paths: ["/ws/a.ts"] },
      ]},
    ]}});

    /*
     * ⏪ **접는 묶음이었다** — `▸ 활동 2개` 를 펴고, 그 안의 줄을 또 펴야
     * 명령이 보였다. 사용자: *"활동 드랍테이블 삭제 및 각 활동을 알약으로"*.
     * 🔴 두 번 눌러야 보이는 것은 **안 보는 것**과 비슷하다.
     */
    ok(t.$(".tool-group") === null, "★ **접는 묶음이 없다**");
    const pills = t.$$(".act-pill");
    ok(pills.length === 2, `★ **활동 하나 = 알약 하나** (${pills.length})`);
    ok(pills[0].querySelector(".what").textContent === "Bash",
       `★ 글자는 **도구 이름** (${pills[0].querySelector(".what").textContent})`);

    pills[0].click();
    ok(t.$(".modal .act-in code").textContent === "rm -rf build && npm run build",
       "★ **누르면 명령이 그대로** — `Bash`만으로는 아무것도 못 판단한다 (D1)");
    ok(t.$(".modal .at") !== null, "언제 했는지도 — 팝업 머리에");

    /*
     * ★ **제목은 제 상자에 있어야 한다** (2026-09-28).
     *
     * 🔴 맨 텍스트로 두고 `.activity`(flex) 에 `text-overflow: ellipsis` 를
     * 걸어 놨었다 — **flex 컨테이너에는 안 먹는다.** 긴 제목이 «…» 도 없이
     * 잘렸고, flex 항목이 기본으로 안 줄어들어 **뒤의 시각·승인 도장이 밖으로
     * 밀려났다.** 「무엇을 승인했나」가 화면에서 사라지는 셈이다.
     *
     * jsdom 은 폭을 못 재므로 **구조**를 못 박는다 — 제목이 제 상자에 있고,
     * 시각이 그 **형제로** 남아 있는지. 줄임은 CSS 가 `.what` 에서만 한다.
     */
    const what2 = pills[1].querySelector(".what");
    ok(what2 !== null, "★ **제목이 제 상자에 있다** — 여기서만 줄어들게 하려면 상자가 있어야 한다");
    ok(what2.textContent === "Read", `★ 둘째도 도구 이름 («${what2.textContent}»)`);
  }

  console.log("\n[들어간 것과 나온 것이 같이 보인다 (C3)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "했습니다", deliveredTo: [], createdAt: 1, tools: [
        { id: "t1", title: "Bash", kind: "execute", status: "completed", at: 1000 * 60 * 63,
          command: "npm test", output: "12 passed\n0 failed" },
        { id: "t2", title: "Bash", kind: "execute", status: "failed",
          command: "npm run build", output: "error TS2304" },
      ]},
    ]}});

    /* 알약은 **순서대로** 선다 — 먼저 한 것이 왼쪽이다 (C3) */
    const pills = t.$$(".act-pill");
    ok(pills.length === 2, `알약 둘 (${pills.length})`);
    pills[0].click();
    ok(t.$(".modal .act-in code").textContent === "npm test", "**들어간 것** — 실행한 명령");
    ok(t.$(".modal .act-out code").textContent.includes("12 passed"),
       "**나온 것** — 결과가 명령 아래 붙는다");
  }

  console.log("\n[실패한 건 결과가 펼쳐진다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "", deliveredTo: [], createdAt: 1, tools: [
        { id: "t1", title: "Bash", kind: "execute", status: "failed",
          command: "npm run build", output: "error TS2304" },
      ]},
    ]}});
    /*
     * ⏪ **«실패는 접지 않는다»** 였다. 알약에는 접고 말고가 없으므로 그
     * 말을 **색으로** 한다 — 훑다가 빨간 알약 하나가 눈에 걸리면 그걸 누른다.
     */
    const bad = t.$(".act-pill.failed");
    ok(bad !== null, "★ **실패는 색으로 말한다**");
    bad.click();
    ok(t.$(".modal .act-out code").textContent.includes("error TS2304"),
       "★ 누르면 **왜 실패했는지**가 나온다");
  }

  console.log("\n[계획이 화면에 나온다 — 여태 받아서 버리고 있었다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "이렇게 하겠습니다", deliveredTo: [], createdAt: 1,
        plan: { entries: [
          { text: "테스트 읽기", status: "completed" },
          { text: "구현", status: "in_progress" },
          { text: "정리", status: "pending" },
        ]}},
    ]}});

    ok(t.$(".plan") !== null, "**계획이 보인다**");
    const items = t.$$(".plan-item").map((n) => n.textContent.trim());
    ok(items.length === 3, `항목 셋 (${items.length})`);
    ok(t.$(".plan-item.completed") !== null, "끝난 것");
    ok(t.$(".plan-item.in_progress") !== null, "하는 중");
    ok(t.$(".plan") .closest(".msg") !== null, "말풍선에 딸려 붙는다");

    /*
     * ★ **접혀 있고, 머리줄이 약속을 들고 있다** (§5-N, 2026-10-14).
     *
     * ⏪ 여태 다 펴 두었다. 근거가 *"계획은 결과가 아니라 약속"* 이었는데,
     * 🔴 **열두 칸짜리 계획이 말풍선마다 붙으면 정작 봇이 한 말이 화면
     * 밖으로 나간다.** 약속은 머리줄로 옮긴다 — 지금 하는 칸이 거기 떠 있다.
     */
    ok(t.$(".plan").tagName === "DETAILS", "★ 접을 수 있는 물건이다");
    ok(t.$(".plan").open === false, "★ **접힌 채로 온다**");
    const head = t.$(".plan-head").textContent;
    ok(head.includes("구현"), `★ 머리줄이 **지금 하는 칸**을 말한다 (${head.trim()})`);
    ok(!head.includes("테스트 읽기"),
       "🔴 **맨 앞 칸이 아니다** — 끝난 칸이 머리에 있으면 멈춘 것처럼 보인다");
    ok(head.includes("(1/3)"), `★ 어디까지 왔나 (${head.trim()})`);
  }

  console.log("\n[★ 펼쳐 두면 **글자가 와도** 안 접힌다 (§5-N)]");
  {
    const t = enter(mount(boot([meta()])));
    const msg = (text) => ({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text, deliveredTo: [], createdAt: 1,
        plan: { entries: [
          { text: "테스트 읽기", status: "completed" },
          { text: "구현", status: "in_progress" },
        ]}},
    ]}});
    t.send(msg("이렇게"));
    t.$(".plan-head").click();
    ok(t.$(".plan").open === true, "전제 — 눌러서 폈다");

    /*
     * 🔴 **이 화면은 글자가 올 때마다 다시 그린다.** `<details>` 는 새로
     * 만들어지면 닫힌 채라, 기억해 두지 않으면 **보는 눈앞에서 접힌다.**
     * 체크해 둔 승인(`ticked`)이 겪은 것과 같은 자리다.
     */
    t.send(msg("이렇게 하겠습니다"));
    ok(t.$(".plan").open === true, "★ **편 채로 남는다** — 다음 조각이 와도");
    ok(t.$$(".plan-item").length === 2, "전제 — 다시 그려진 것이 맞다");
  }

  console.log("\n[마크다운 계획도 그대로]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "", deliveredTo: [], createdAt: 1,
        plan: { markdown: "## 순서\n\n1. 하나\n2. 둘" } },
    ]}});
    ok(t.$(".plan-body h4, .plan-body h3, .plan-body h5") !== null, "제목이 렌더된다");
    ok(t.$(".plan-body ol li") !== null, "목록도");
  }

  console.log("\n[말과 활동이 번갈아 나온다 — 한 덩어리로 뭉치지 않는다 (C3)]");
  {
    const t = enter(mount(boot([meta()])));
    const text = "먼저 테스트를 봅니다.\n\n돌려보겠습니다.\n\n통과했습니다.";
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text, deliveredTo: [], createdAt: 1, tools: [
        { id: "t1", title: "Read", kind: "read", status: "completed",
          textAt: text.indexOf("돌려보겠습니다") },
        { id: "t2", title: "Bash", kind: "execute", status: "completed",
          command: "npm test", textAt: text.indexOf("통과했습니다") },
      ]},
    ]}});

    /*
     * ⏪ **조각마다 말풍선이었다** — 글·활동·글이면 상자가 셋. 사용자:
     * *"그 색을 고른 말풍선이 전체를 감싸야함"*. 🔴 상자가 갈리면 **고른
     * 색이 조각마다 끊긴다.** 이제 한 턴은 **상자 하나**고, 그 안에서
     * 글·활동이 번갈아 선다 — 지키려던 것(C3)은 그대로다.
     */
    ok(t.$$(".msg.agent .bubble").length === 1,
       `★ **말풍선 하나가 전체를 감싼다** (${t.$$(".msg.agent .bubble").length})`);
    ok(t.$$(".msg.agent .acts").length === 2, "활동 묶음은 둘 — 자리가 둘이므로");

    const order = [...t.$(".msg.agent .bubble").children]
      .map((n) => (n.classList.contains("say") ? "말" : n.classList.contains("acts") ? "활동" : ""))
      .filter(Boolean)
      .join(">");
    ok(order === "말>활동>말>활동>말",
       `**말 → 활동 → 말 순서로 놓인다** (${order})`);

    const says = t.$$(".msg.agent .say").map((b) => b.textContent.trim());
    ok(says[0].includes("먼저 테스트를"), "첫 조각");
    ok(says[2].includes("통과했습니다"), "마지막 조각");
    ok(t.$$(".time").length === 1, "시각은 **마지막 조각에만** — 중간에 붙으면 끝난 줄 안다");
  }

  console.log("\n[위치를 모르는 옛 기록은 예전처럼 맨 뒤에]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "했습니다", deliveredTo: [], createdAt: 1, tools: [
        { id: "t1", title: "Bash", kind: "execute", status: "completed" },
      ]},
    ]}});
    ok(t.$$(".msg.agent .bubble").length === 1, "말풍선 하나");
    const kids = [...t.$(".msg.agent .bubble").children].map((n) => n.className);
    ok(kids.indexOf("say") < kids.indexOf("acts"),
       "**활동이 뒤에 온다** — 자리를 모르면 글 뒤다. 기록을 고치지 않는다");
  }

  console.log("\n[복구 실패는 영구적이지 않다 — 다시 붙어볼 수 있다 (F7)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: {
      ...room(), contextLost: true, lostSessionId: "s-예전",
      messages: [{ id: "u1", role: "user", text: "하던 얘기", deliveredTo: [], createdAt: 1 }],
    }});

    const labels = t.$$(".banner.warn button").map((b) => b.textContent);
    ok(labels[0] === "다시 시도",
       `**다시 붙어보는 게 먼저** — 되면 계획·메모리까지 돌아온다 (${labels.join(",")})`);

    t.$$(".banner.warn button")[0].click();
    ok(t.sent.some((m) => m.t === "retryResume" && m.roomId === "r1"), "재시도가 나간다");
  }

  console.log("\n[이어붙일 대상이 없으면 그 버튼은 없다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: {
      ...room(), contextLost: true,
      messages: [{ id: "u1", role: "user", text: "하던 얘기", deliveredTo: [], createdAt: 1 }],
    }});
    const labels = t.$$(".banner.warn button").map((b) => b.textContent);
    /*
     * ★ **갈래가 셋이 됐다** (2026-10-02) — 사용자가 갈아타기와 통일을
     * 요청했다. 세션이 끕긴 것도 **무엇을 실어 다시 시작할지**를 정하는
     * 일이라 같은 셋이어야 한다. «다시 시도» 는 이어붙일 세션이 있을
     * 때만 뜨므로 여기엔 없다 — 그게 이 칸이 재는 것이다.
     */
    ok(labels.join(",") === "대화 넘겨서 시작,요약만 넘겨서 시작,기록만 두고 시작",
       `못 할 일은 권하지 않는다 — «다시 시도» 가 없다 (${labels.join(",")})`);
  }

  console.log("\n[방 정보에 세션 id가 보인다 (B12)]");
  {
    const t = enter(mount(boot([meta()])));
    const bot = { id: "b1", agentId: "claude", name: "Claude", sessionId: "s-abc-123",
      sessionPrompted: true, approver: { kind: "user" }, answerPolicy: "ask" };
    t.send({ t: "room", compactable: false, room: { ...room(), participants: [bot] } });

    t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();


    ok(t.$(".session-id").textContent === "s-abc-123", "**세션 id가 그대로 보인다**");
    ok(!t.$("#screen-bots").textContent.includes("복구 대상이 아닙니다"),
       "써본 세션에는 군더더기를 안 붙인다");

    let copied = "";
    t.w.navigator.clipboard = { writeText: (s) => ((copied = s), Promise.resolve()) };
    t.$(".session-id").click();
    ok(copied === "s-abc-123", "**눌러서 복사** — `claude --resume`에 그대로 쓴다");
  }

  console.log("\n[아직 말 안 건 세션은 복구 대상이 아니라고 말해준다]");
  {
    const t = enter(mount(boot([meta()])));
    const bot = { id: "b1", agentId: "claude", name: "Claude", sessionId: "s-ghost",
      approver: { kind: "user" }, answerPolicy: "ask" };
    t.send({ t: "room", compactable: false, room: { ...room(), participants: [bot] } });
    t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();

    ok(t.$("#screen-bots").textContent.includes("복구 대상이 아닙니다"),
       "**왜 복구가 안 되는지**를 여기서 알 수 있다");
  }

  console.log("\n[압축 지점은 메모가 아니라 선이다 (C11)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", text: "옛날 얘기", deliveredTo: [], createdAt: 1 },
      { id: "s1", role: "system", mark: "compaction", deliveredTo: [], createdAt: 2,
        text: "여기까지 압축됨 — 위쪽은 에이전트가 요약으로 기억합니다" },
      { id: "a2", role: "agent", text: "요즘 얘기", deliveredTo: [], createdAt: 3 },
    ]}});

    ok(t.$(".cut-line") !== null, "**선으로 그린다** — 말풍선이 아니라");
    ok(t.$(".cut-line").textContent.includes("압축"), "왜 그어졌는지 적힌다");
    const notes = t.$$(".msg.system .bubble");
    ok(notes.length === 0, "평범한 시스템 메모로 안 그린다");
  }

  console.log("\n[폴더가 없으면 고르게 한다 — 홈에 풀어놓지 않는다 (B9)]");
  {
    const t = mount({ ...boot([], "new"), hasWorkspace: false, cwd: "/home/me" });
    const create = t.$("#screen-new .actions .primary");
    ok(create.disabled === true, "**폴더를 고르기 전엔 못 만든다**");
    /*
     * 🔴 «흐린 글씨 중 `.bot-bent` 가 아닌 것» 으로 집고 있었다. 이름 겹침
     * 안내가 없어지자(2026-09-30) 그 셀렉터가 **에이전트 설명**을 집었다 —
     * 그것도 `.field` 안의 `.dim` 이기 때문이다. 제 이름으로 집는다.
     */
    ok(t.$("#screen-new .cwd-why").textContent.includes("열린 폴더가 없습니다"),
       "왜 잠겼는지 말한다");

    t.send({ t: "cwdPicked", path: "/work/repo" });
    ok(create.disabled === false, "**고르면 풀린다** — 값만 넣으면 이벤트가 안 나서 잠겨 있었다");

    create.click();
    const sent = t.sent.find((m) => m.t === "createRoom");
    ok(sent.cwd === "/work/repo", "고른 폴더로 만든다");
  }

  console.log("\n[폴더가 열려 있으면 그대로 진행한다]");
  {
    const t = mount(boot([], "new"));
    ok(t.$("#screen-new .actions .primary").disabled === false, "막지 않는다");
  }
  console.log("\n[코드 블록 — 복사 버튼]");
  {
    const t = enter(mount(boot([meta()])));
    const fence = "```bash\nnpm test\n```";
    t.send({ t: "room", compactable: false, room: { ...room(), messages: [
      { id: "a1", role: "agent", createdAt: 1, deliveredTo: [], text: `이렇게:\n\n${fence}` },
    ]}});

    ok(t.$("pre code").textContent === "npm test", "코드가 그대로");
    ok(t.$(".code-lang").textContent === "bash", "언어를 보여준다");
    const copy = t.$(".code-bar .copy");
    ok(copy !== null, "**복사 버튼이 있다** — 여러 줄을 드래그하게 두지 않는다");

    let copied = "";
    t.w.navigator.clipboard = { writeText: (s) => ((copied = s), Promise.resolve()) };
    copy.click();
    ok(copied === "npm test", `클립보드로 간다 (${JSON.stringify(copied)})`);
  }

  console.log("\n[마크다운]");
  {
    const t = mount(boot());
    const text = "**굵게** 와 `코드`\n\n- 하나\n- 둘\n\n```js\nconst a = 1;\n```";
    t.send({ t: "room", room: room({ messages: [msg({ id: "a", text })] }), compactable: false });
    const b = t.$("#screen-chat .bubble");
    ok(b.querySelector("strong")?.textContent === "굵게", "굵게");
    ok(b.querySelector("code")?.textContent === "코드", "인라인 코드");
    ok(b.querySelectorAll("li").length === 2, "목록 2개");
    ok(b.querySelector("pre code")?.textContent === "const a = 1;", "코드 블록");
  }

  console.log("\n[file.ts:42 는 눌러서 연다 (E9)]");
  {
    const t = mount(boot());
    const text = "src/core/store.ts:42 를 보세요";
    t.send({ t: "room", room: room({ messages: [msg({ id: "a", text })] }), compactable: false });
    const ref = t.$("#screen-chat .file-ref");
    ok(ref?.textContent === "src/core/store.ts:42", "링크로 바뀜");
    ref.click();
    ok(
      t.sent.some((m) => m.t === "openFile" && m.path === "src/core/store.ts" && m.line === 42),
      "경로와 줄 번호가 함께 간다",
    );
  }

  console.log("\n[Esc — 도는 중엔 중단, 아니면 목록으로 (C6)]");
  {
    const t = enter(mount(boot([meta()])));
    ok(t.screenOf() === "chat", "방에 들어와 있다");
    t.send({ t: "status", roomId: "r1", status: "streaming" });
    t.key("Escape");
    ok(t.sent.some((m) => m.t === "stopAll"), "중지가 나간다");
    ok(t.screenOf() === "chat", "방에 그대로 있다");

    t.send({ t: "status", roomId: "r1", status: "idle" });
    t.key("Escape");
    ok(t.screenOf() === "list", "이번엔 목록으로");
  }

  console.log("\n[권한 설정 — 입력창 옆에서 올라온다 (D2)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1", options: [
      { configId: "mode", name: "Mode", category: "mode", current: "default", values: [
        { id: "default", name: "Manual", description: "Always ask before making changes" },
        { id: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
      ]},
    ]});

    ok(t.$(".composer .perm") !== null, "입력창 옆에 권한 버튼");
    ok(t.$(".composer .auto") === null, "자율 모드 버튼은 없어졌다");
    /*
   * ⏪ 권한이 **화면**이 되면서(2026-09-30) «엘리먼트가 있나» 로는 못 잰다 —
   * 칸은 늘 있다. 보이느냐는 스택이, 그려졌느냐는 자식이 말한다.
   */
    ok(t.$("#screen-perm").firstElementChild === null, "처음엔 안 그려져 있다");

    t.$(".composer .perm").click();
    const sheet = t.$("#screen-perm");
    ok(sheet.firstElementChild !== null, "**누르면 그려진다**");
    ok(t.$$(".screen.active").map((x) => x.id).includes("screen-perm"),
       "**그리고 그 화면으로 간다**");

    const labels = t.$$("#screen-perm .field > label").map((l) => l.textContent);
    ok(labels.join(",") === "권한 모드,승인 주체,루프모드",
       `**봇 : 권한 모드 : 승인 주체** (${labels.join(",")})`);
    /*
     * ★ **맨 위는 «봇끼리 부르기»** (v3.0 2-F). 그것도 권한이고, 봇별
     * 권한보다 **위에** 있는 결정이다 — 꺼져 있으면 아래 줄이 다 무의미하다.
     * 그래서 봇 칸을 찾을 때는 그 줄을 빼고 본다.
     */
    const first = sheet.querySelector(".sheet-bot");
    ok(first.classList.contains("relay"),
       `★ **맨 위가 봇끼리 부르기** (${first.querySelector(".name")?.textContent})`);
    const botBox = sheet.querySelector(".sheet-bot:not(.relay)");
    ok(botBox.querySelector(".who").textContent.includes("Claude"), "봇 이름이 머리에");

    // 권한 모드는 에이전트 목록 그대로
    const mode = botBox.querySelectorAll("select")[0];
    ok([...mode.options].map((o) => o.textContent).join(",") === "Manual,Accept edits",
       "에이전트가 준 이름 그대로");
    ok(mode.parentElement.querySelector(".dim").textContent === "Always ask before making changes",
       "설명도 따라온다");

    mode.value = "acceptEdits";
    mode.dispatchEvent(new t.w.Event("change"));
    const sent = t.sent.find((m) => m.t === "setConfig");
    ok(sent.configId === "mode" && sent.value === "acceptEdits", "**바로 세션에 적용된다**");

    t.$("#screen-perm .bar .icon").click();
    ok(t.$$(".screen.active").map((x) => x.id).includes("screen-chat"),
       "**돌아가면 보던 방으로** — 목록이 아니다");
  }

  console.log("\n[승인 주체 · 질문도 같은 자리에서]");
  {
    const t = enter(mount(boot([meta()])));
    t.$(".composer .perm").click();
    const selects = t.$$("#screen-perm select");

    // 방에 다른 봇이 없으면 사용자뿐
    const who = selects[0];
    ok([...who.options].map((o) => o.textContent).join(",") === "사용자",
       "1:1이라 승인 주체는 사용자뿐");
    /*
     * ⏪ 여기 *"다른 봇에게 맡기는 것은 v3.0에서"* 가 붙어 있었다. **지금이
     * v3.0이다** — 낡은 안내는 «기능이 없다»고 거짓말을 한다.
     */
    ok(!t.$("#screen-perm").textContent.includes("v3.0에서"),
       "★ **«v3.0에서» 라는 낡은 안내가 없다** — 그 v3.0 이 지금이다");

    const ask = selects[1];
    ask.value = "auto";
    ask.dispatchEvent(new t.w.Event("change"));
    const sent = t.sent.find((m) => m.t === "setPolicy");
    ok(sent.answerPolicy === "auto" && sent.botId !== undefined, "봇을 지목해서 보낸다");
  }

  console.log("\n[★ 승인 주체 — 방에 있는 봇이 그대로 선택지다 (v3.0 3-P)]");
  {
    /*
     * 🔴 코어(`askBotApprover`)·큐·`verdict`·가로채기가 다 서 있는데 **화면이
     * 안 닿아서** 아무도 못 켜고 있었다. 목록은 방의 참여자 그 자체다 —
     * 따로 들고 있으면 봇을 부르고 내보낼 때마다 **방과 어긋난다.**
     */
    const three = [
      { id: "b1", agentId: "claude", name: "Claude", sessionId: "s1",
        approver: { kind: "user" }, answerPolicy: "ask" },
      { id: "b2", agentId: "claude", name: "리뷰어", sessionId: "s2",
        approver: { kind: "user" }, answerPolicy: "ask" },
      { id: "b3", agentId: "claude", name: "테스터", sessionId: "s3",
        approver: { kind: "user" }, answerPolicy: "ask" },
    ];
    /** 봇 칸에서 **승인 주체** 줄만 — 권한 모드 줄은 설정이 와야 `select` 가 된다 */
    const whoOf = (box) =>
      [...box.querySelectorAll(".field")]
        .find((f) => f.querySelector("label")?.textContent === "승인 주체")
        ?.querySelector("select");

    const t = enter(mount(boot([meta()])), { participants: three });
    t.send({ t: "mcp", state: { at: "ready", url: "http://127.0.0.1:1/mcp" } });
    t.$(".composer .perm").click();

    const boxes = t.$$("#screen-perm .sheet-bot:not(.relay)");
    ok(boxes.length === 3, `세 봇이 다 그려진다 (${boxes.length})`);

    const who = whoOf(boxes[0]);
    ok([...who.options].map((o) => o.textContent).join(",") === "사용자,리뷰어,테스터",
       `★ **방의 다른 봇이 그대로 선택지다** (${[...who.options].map((o) => o.textContent).join(",")})`);
    ok(![...who.options].some((o) => o.value === "b1"),
       "★ **자기는 빠진다** — 같은 맥락이 «해도 된다»고 하는 건 심사가 아니라 메아리다");

    who.value = "b2";
    who.dispatchEvent(new t.w.Event("change"));
    const sent = t.sent.filter((m) => m.t === "setPolicy").pop();
    ok(sent.botId === "b1" && sent.approver.kind === "bot" && sent.approver.botId === "b2",
       `★ **누구의 설정을 누구에게** 둘 다 실린다 (${JSON.stringify(sent)})`);

    // 저장된 값이 다시 내려오면 그대로 골라져 있다
    const t2 = enter(mount(boot([meta()])), {
      participants: [{ ...three[0], approver: { kind: "bot", botId: "b3" } }, three[1], three[2]],
    });
    t2.send({ t: "mcp", state: { at: "ready", url: "http://127.0.0.1:1/mcp" } });
    t2.$(".composer .perm").click();
    const back = whoOf(t2.$$("#screen-perm .sheet-bot:not(.relay)")[0]);
    ok(back.value === "b3", `★ **저장된 것이 골라져 있다** (${back.value})`);
    ok(t2.$("#screen-perm").textContent.includes("테스터의 큐로"),
       "★ 그리고 **무슨 일이 벌어지는지** 적는다 — 규칙이 아니라 결과를");
  }

  console.log("\n[★ 승인 주체 — 길이 안 서면 새로 고르지 못한다 (v3.0 3-P)]");
  {
    /*
     * 🔴 심사는 심사 봇의 **큐**로 가고, 큐를 읽는 길은 MCP 서버다. 서버가
     * 없으면 고를 수는 있는데 매 요청이 조용히 사용자에게 되돌아온다 —
     * **고른 적 없는 설정이 켜져 있는 것**처럼 보인다.
     */
    const two = [
      { id: "b1", agentId: "claude", name: "Claude", sessionId: "s1",
        approver: { kind: "bot", botId: "b2" }, answerPolicy: "ask" },
      { id: "b2", agentId: "claude", name: "리뷰어", sessionId: "s2",
        approver: { kind: "user" }, answerPolicy: "ask" },
    ];
    const t = enter(mount(boot([meta()])), { participants: two });
    t.send({ t: "mcp", state: { at: "failed", why: "닿지 않습니다" } });
    t.$(".composer .perm").click();

    /*
     * 🔴 **「봇끼리 부르기」의 이름을 빌려 쓰면 안 된다.** 저 토글의 「끔」은
     * `say` 만 막고 심사는 그대로 돈다 — 두 축이 섞여 보이면 «대화를 껐으니
     * 심사도 꺼졌겠지» 가 된다.
     */
    const whoField = [...t.$$("#screen-perm .sheet-bot:not(.relay) .field")]
      .find((f) => f.querySelector("label")?.textContent === "승인 주체");
    ok(!whoField.textContent.includes("봇끼리 부르"),
       `★ **relay 토글의 이름을 안 빌린다** (${whoField.querySelector(".bad")?.textContent})`);

    const box = t.$$("#screen-perm .sheet-bot:not(.relay)")[1];
    const who = [...box.querySelectorAll(".field")]
      .find((f) => f.querySelector("label")?.textContent === "승인 주체")
      .querySelector("select");
    const claude = [...who.options].find((o) => o.value === "b1");
    ok(claude.disabled === true,
       "★ **길이 안 서면 새로 못 고른다** — 골라도 매번 조용히 사용자에게 되돌아온다");
    ok(box.querySelector(".field .bad") !== null,
       "★ 그리고 **왜 안 되는지** 그 줄에서 말한다");

    // 이미 골라둔 쪽은 막지 않는다 — 막으면 화면이 «사용자»라고 거짓말한다
    const mine = t.$$("#screen-perm .sheet-bot:not(.relay)")[0];
    const kept = [...mine.querySelectorAll(".field")]
      .find((f) => f.querySelector("label")?.textContent === "승인 주체")
      .querySelector("select");
    ok(kept.value === "b2",
       `★ **이미 골라둔 것은 그대로 보인다** (${kept.value}) — 숨기면 화면이 거짓말한다`);
  }

  console.log("\n[맥락이 끊겼으면 화면이 말해준다 (F7)]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), contextLost: true, messages: [
      { id: "u1", role: "user", text: "열두글자짜리요청", deliveredTo: [], createdAt: 1 },
      { id: "a1", role: "agent", text: "네", deliveredTo: [], createdAt: 2 },
      { id: "s1", role: "system", text: "이전 세션이 에이전트에서 사라졌습니다.", deliveredTo: [], createdAt: 3 },
    ]}});

    const banner = t.$(".banner.warn");
    ok(banner !== null, "**어긋났다고 알린다** — 예전 대화가 보이니 안 말하면 다 안다고 믿는다");
    ok(banner.textContent.includes("모릅니다"), "에이전트가 모른다고 분명히 말한다");
    ok(banner.textContent.includes("메시지 2개"), "**«많이»가 아니라 셈한 값** (시스템 메시지는 뺀다)");
    ok(banner.textContent.includes("9자"), `글자 수도 (${banner.textContent.slice(0, 60)})`);

    const buttons = [...banner.querySelectorAll("button")].map((b) => b.textContent);
    ok(buttons.join(",") === "대화 넘겨서 시작,요약만 넘겨서 시작,기록만 두고 시작",
       `고르게 한다 — 갈아타기와 같은 셋 (${buttons.join(",")})`);

    banner.querySelectorAll("button")[0].click();
    const sent = t.sent.find((m) => m.t === "refeed");
    ok(sent.accept === true && sent.roomId === "r1", "**우리가 정하지 않는다** — 돈이 드는 쪽이다");
  }

  console.log("\n[다 안 들어갈 수도 있다 — 이전 세션이 얼마나 찼었는지로 말한다]");
  {
    const msgs = [{ id: "u1", role: "user", text: "긴 대화", deliveredTo: [], createdAt: 1 }];

    const small = enter(mount(boot([meta()])));
    small.send({ t: "room", compactable: false, room: {
      ...room(), contextLost: true, messages: msgs,
      usage: { contextUsed: 10, contextSize: 100 },
    }});
    ok(!small.$(".banner.warn").textContent.includes("압축이 필요"),
       "여유 있으면 겁주지 않는다");

    const big = enter(mount(boot([meta()])));
    big.send({ t: "room", compactable: false, room: {
      ...room(), contextLost: true, messages: msgs,
      usage: { contextUsed: 70, contextSize: 100 },
    }});
    const text = big.$(".banner.warn").textContent;
    ok(text.includes("70%"), `**측정값으로 말한다** (${text.slice(-60)})`);
    ok(text.includes("압축이 필요"), "곧 압축이 필요할 수 있다고 알린다");
  }

  console.log("\n[이어가기를 고르면 약속이 보인다 — 턴을 안 쓰니 아니면 티가 안 난다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), refeedPending: true } });
    ok(t.$(".banner") !== null, "배너가 남는다");
    ok(t.$(".banner").textContent.includes("다음 메시지에"), "언제 전달되는지 말한다");
    ok(t.$(".banner.warn") === null, "경고는 아니다 — 이미 정해졌다");
  }

  console.log("\n[정하고 나면 조용해진다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "room", compactable: false, room: { ...room(), contextLost: false, refeedPending: false } });
    ok(t.$(".banner") === null, "**다시 묻지 않는다**");
  }

  console.log("\n[방마다 값이 따로 논다 — 세션이 방마다 다르니까 (B1)]");
  {
    const t = mount(boot([meta(), meta({ id: "r2", title: "다른 방" })]));

    t.$$(".room")[0].click();
    t.send({ t: "room", room: room(), compactable: false });
    ok(t.sent.some((m) => m.t === "needConfig" && m.roomId === "r1"),
       "**방 값을 부른다** — 에이전트 기본값이 아니라");

    t.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1", options: [
      { configId: "mode", name: "Mode", category: "mode", current: "plan", values: [
        { id: "default", name: "Manual" }, { id: "plan", name: "Plan" },
      ]},
    ]});
    t.$(".composer .perm").click();
    ok(t.$$("#screen-perm select")[0].value === "plan", "이 방은 계획 모드");

    // 다른 방의 값이 와도 이 방 시트는 안 바뀐다
    t.send({ t: "config", agentId: "claude", roomId: "r2", botId: "b1", options: [
      { configId: "mode", name: "Mode", category: "mode", current: "default", values: [
        { id: "default", name: "Manual" }, { id: "plan", name: "Plan" },
      ]},
    ]});
    ok(t.$$("#screen-perm select")[0].value === "plan",
       "**다른 방 값이 흘러들지 않는다** — 예전엔 캐시가 하나라 섞였다");
  }

  console.log("\n[설정이 늦게 오면 시트가 받아서 다시 그린다 (D2)]");
  {
    // 실제 순서다. CLI를 띄워야 모드를 알 수 있어서 **시트가 먼저 열린다.**
    const t = enter(mount(boot([meta()])));

    t.$(".composer .perm").click();
    ok(t.$("#screen-perm") !== null, "설정이 없어도 시트는 열린다");
    ok(t.$("#screen-perm .dim").textContent.includes("불러오는 중"),
       "«없다»가 아니라 «불러오는 중»이라고 한다");
    ok(t.sent.filter((m) => m.t === "needConfig" && m.agentId === "claude").length > 0,
       "**열어 보는 것 자체가 요청이다**");

    t.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1", options: [
      { configId: "mode", name: "Mode", category: "mode", current: "default", values: [
        { id: "default", name: "Manual", description: "Always ask" },
      ]},
    ]});

    const labels = t.$$("#screen-perm .field > label").map((l) => l.textContent);
    ok(labels.includes("권한 모드"), `**늦게 온 설정이 시트에 들어간다** (${labels.join(",")})`);
    ok(t.$("#screen-perm") !== null, "다시 그려도 시트는 열린 채로");
  }

  console.log("\n[★ 봇끼리 부르기 — 왜 안 되는지 말하고, 다시 해볼 수 있다 (v3.0 2-F)]");
  {
    /*
     * 🔴 그 길은 MCP 서버 위에 서 있는데 **루프백이 막힌 기계가 있다.**
     * 조용히 안 되면 사용자는 «왜 안 부르지»를 영영 못 푼다.
     *
     * 그리고 **자동으로 다시 안 한다** — 「몇 초마다」라는 숫자가 하나 생기고,
     * 그 숫자는 아무도 고를 수 없다: 짧으면 막힌 기계에서 계속 두드리고,
     * 길면 고친 사람이 기다린다.
     */
    const t = enter(mount(boot([meta()])));
    t.send({ t: "mcp", state: { at: "failed", why: "묶이긴 했는데 닿지 않습니다 (방화벽)" } });
    t.$(".composer .perm").click();

    const row = t.$("#screen-perm .sheet-bot.relay");
    ok(row !== null, "★ 권한 설정 **맨 위에** 있다 — 그것도 권한이다");
    ok(row.textContent.includes("방화벽"),
       `★ **왜 안 되는지 말한다** (${row.querySelector(".bad")?.textContent})`);

    const before = t.sent.filter((m) => m.t === "retryMcp").length;
    row.querySelector("button.link").click();
    ok(t.sent.filter((m) => m.t === "retryMcp").length > before,
       "★ **다시 시도가 있다** — 자동으로 되풀이하지 않는 대신 사람이 누른다");

    // 서면 그 자리에서 바뀐다 — 누른 사람에 대한 답이다
    t.send({ t: "mcp", state: { at: "ready", url: "http://127.0.0.1:1/mcp" } });
    const now = t.$("#screen-perm .sheet-bot.relay");
    ok(now.querySelector(".bad") === null && now.querySelector(".relay-pick") !== null,
       `★ **서면 그 자리에서 바뀐다** — 길이 섰으니 고를 것이 뜬다 (${now.textContent})`);
    ok(now.querySelector("button.link") === null, "★ 그리고 [다시 시도] 가 걷힌다");
  }

  console.log("\n[★ 봇끼리 부르기 — 세 칸과 상한 (v3.0 4-L)]");
  {
    /*
     * 🔴 **상한이 «무조건 허용» 옆에만 있으면 거짓말이 된다.** 알림 턴은
     * 승인과 무관하게 돌아서 「물어봄」에서도 고리가 생길 수 있다 — 언제나
     * 걸리므로 **언제나 보여야** 한다.
     */
    const t = enter(mount(boot([meta()])), { relay: "always", depthCap: 12 });
    t.send({ t: "mcp", state: { at: "ready", url: "http://127.0.0.1:1/mcp" } });
    t.$(".composer .perm").click();

    const row = t.$("#screen-perm .sheet-bot.relay");
    const pills = row.querySelectorAll(".relay-pick button.pill");
    ok(pills.length === 3, `★ 세 칸이다 (${[...pills].map((b) => b.textContent).join(" · ")})`);
    ok([...pills].filter((b) => b.classList.contains("on")).length === 1,
       "★ **지금 어느 칸인지 하나만 켜져 있다**");
    [...pills].find((b) => b.textContent === "물어봄").click();
    const set = t.sent.filter((m) => m.t === "setRelay").pop();
    ok(set?.relay === "ask", `★ 누르면 그대로 간다 (${JSON.stringify(set)})`);

    const cap = row.querySelector("input.cap");
    ok(cap?.value === "12", `★ **깊이 상한이 같은 자리에 보인다** (${cap?.value})`);
    /*
     * 🔴 «다리» 는 **우리끼리 쓰던 말**이었다 — 화면 어디에도 풀어둔 데가 없어
     * 숫자를 고치는 사람이 **무엇을 고치는지 몰랐다.** 설계가 내내 부르던
     * 이름(«깊이»)이 그 자리에 있어야 한다.
     */
    ok(row.textContent.includes("깊이") && !row.textContent.includes("다리"),
       `★ **«깊이» 라고 적혀 있다** (${row.querySelector(".cap-row")?.textContent})`);
    cap.value = "30";
    cap.dispatchEvent(new t.w.Event("change"));
    const capped = t.sent.filter((m) => m.t === "setRelayDepth").pop();
    ok(capped?.depth === 30, `★ 고치면 그대로 간다 (${JSON.stringify(capped)})`);

    /*
     * 🔴 **«무조건 허용» 에서만 걸리는 값**이라 다른 칸에서는 흐리게 둔다.
     * 숨기면 «언제 쓰이는 값이지»가 되고, 그냥 두면 «지금도 걸리나»가 된다.
     */
    t.send({ t: "room", room: room({ relay: "ask", depthCap: 12 }) });
    t.$(".composer .perm").click();
    const quiet = t.$("#screen-perm .sheet-bot.relay input.cap");
    ok(quiet.disabled === true, "★ «물어봄» 에서는 못 고친다 — 걸리지 않는 값이다");
  }

  console.log("\n[설정을 못 불러온 것과 모드가 없는 것은 다른 화면이다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1", options: [], error: "claude를 찾을 수 없습니다" });
    t.$(".composer .perm").click();
    ok(t.$("#screen-perm .warn").textContent.includes("찾을 수 없습니다"),
       "**고칠 수 있는 문제라고 말해 준다**");

    const before = t.sent.filter((m) => m.t === "needConfig").length;
    // ★ 맨 위의 «봇끼리 부르기» 에도 [다시 시도] 가 있다 — **봇 칸 안에서** 고른다
    t.$("#screen-perm .sheet-bot:not(.relay) button.link").click();
    ok(t.sent.filter((m) => m.t === "needConfig").length > before,
       "**다시 시도가 있다** — 깔고 나서 방을 닫았다 열게 하지 않는다");
    ok(t.$("#screen-perm .dim").textContent.includes("불러오는 중"), "누르면 다시 불러온다");

    const u = enter(mount(boot([meta()])));
    u.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1", options: [
      { configId: "model", name: "Model", category: "model", current: "a", values: [{ id: "a", name: "A" }] },
    ]});
    u.$(".composer .perm").click();
    ok(u.$("#screen-perm .warn") === null, "설정은 왔는데 mode만 없으면 경고가 아니다");
    ok(u.$("#screen-perm .dim").textContent.includes("알려주지 않습니다"), "그냥 없다고 한다");
  }

  console.log("\n[방 만들기에는 권한이 없다 — 방 안에서 바꾼다]");
  {
    const t = mount(boot([], "new"));
    t.send({ t: "config", agentId: "claude", options: [
      { configId: "mode", name: "Mode", category: "mode", current: "default",
        values: [{ id: "default", name: "Manual" }] },
      { configId: "model", name: "Model", category: "model", current: "opus",
        values: [{ id: "opus", name: "Opus 5" }] },
    ]});
    const labels = labelsOf(t);
    ok(!labels.includes("권한"), `**권한 칸이 빠졌다** (${labels.join(",")})`);
    ok(labels.includes("모델"), "모델은 남는다");
  }

  console.log("\n[검색 결과를 누르면 그 방으로 (H3)]");
  {
    const t = mount(boot());
    t.$("#filter").value = "캐시";
    t.$("#filter").dispatchEvent(new t.w.Event("input"));
    t.send({
      t: "searchResults",
      query: "캐시",
      hits: [
        {
          roomId: "r1", roomTitle: "리팩터링", messageId: "a",
          role: "agent", snippet: "LRU 캐시를 쓰면", createdAt: 1,
        },
      ],
    });
    ok(t.$(".hit-snippet mark")?.textContent === "캐시", "찾은 말이 강조됨");
    t.$(".hit").click();
    ok(t.sent.some((m) => m.t === "open" && m.roomId === "r1"), "그 방을 연다");
  }

  console.log("\n[에이전트가 한 일 — 기록되고, 접혀 있고, 실패는 펼쳐진다 (C3)]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: "Read(src/store.ts)", kind: "read", status: "completed", paths: ["/ws/src/store.ts"] },
      { id: "t2", title: "Bash(npm test)", kind: "execute", status: "completed" },
    ] })] });

    const pills = t.$$("#screen-chat .act-pill");
    ok(pills.length === 2, `활동이 **알약 둘**로 기록된다 (${pills.length})`);
    ok(pills.every((p) => p.querySelector(".what") !== null), "제목이 제 상자에");
    ok(t.$("#screen-chat .codicon-terminal") !== null, "종류에 맞는 아이콘");
    /* 알약은 **세는 것이 아니라 보는 것**이다 — «활동 2개» 같은 숫자가 없다 */
    ok(!t.$("#screen-chat .bubble").textContent.includes("활동 2개"),
       "★ 개수로 뭉개지 않는다 — 무엇을 했는지가 그대로 보인다");
  }

  console.log("\n[실패한 활동은 **색으로** 말한다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: "Read(a.ts)", kind: "read", status: "completed" },
      { id: "t2", title: "Bash(npm test)", kind: "execute", status: "failed" },
    ] })] });

    /*
     * ⏪ **«접지 않는 것»으로 말했다** — 실패만 묶음 밖에 꺼내 뒀다. 알약에는
     * 접고 말고가 없으므로 그 말을 **색**이 한다.
     */
    const failed = t.$("#screen-chat .act-pill.failed");
    ok(failed !== null, "**실패는 바로 눈에 띈다**");
    ok(t.$$("#screen-chat .act-pill").length === 2, "둘 다 그 자리에 있다");
  }

  console.log("\n[아직 도는 중이면 펼쳐둔다 — 멈춘 것처럼 보이면 안 된다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", streaming: true, tools: [
      { id: "t1", title: "Read(a.ts)", kind: "read", status: "in_progress" },
    ] })] });
    /*
     * ⏪ **«도는 중이면 펼쳐둔다»** 였다 — 접어두면 멈춘 것처럼 보이므로.
     * 알약은 접는 것이 아니라 **늘 보이는 것**이라 그 걱정이 사라졌다.
     */
    ok(t.$("#screen-chat .act-pill") !== null, "도는 중에도 그 자리에 보인다");
    ok(t.$("#screen-chat .act-pill.in_progress") !== null, "★ 도는 중이라고 표가 난다");
  }

  console.log("\n[★ 파일 변경도 **활동 알약**이다 (2026-10-14)]");
  {
    /*
     * 🔴 사용자: *"봇2 파일 1개 변경 → 활동인데 안잡힘"*. 활동을 알약으로
     * 바꾸면서 **여기만 접는 상자로 남아 있었다** — 「무엇을 했나」 중 하나인데
     * 혼자 다른 모양이면 눈이 두 규칙을 외운다.
     */
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", files: [
      { path: "/ws/src/store.ts", kind: "edit", added: 3, removed: 1, newSha256: "abc" },
    ] })] });

    const pill = t.$("#screen-chat .act-pill");
    ok(pill !== null, "★ **알약이다** — 접는 상자가 아니라");
    ok(pill.textContent.includes("파일 1개 변경"), `★ 무엇을 했는지 (${pill.textContent})`);
    /*
     * 🔴 **말풍선 «아래»다** (사용자, 2026-10-14). 활동 알약과 같은 모양이지만
     * 자리가 다르다 — 활동은 글 사이에 끼는 **그 순간의 일**이고, 이것은 턴이
     * 끝난 뒤의 **결과**다. 안에 넣으면 마지막 문장 뒤에 붙어 말의 일부처럼
     * 읽힌다.
     */
    ok(pill.closest(".bubble") === null, "★ **말풍선 아래**에 있다");
    ok(pill.closest(".msg") !== null, "★ 그래도 그 말풍선의 것이다");

    pill.click();
    t.$(".modal .file").click();
    ok(t.sent.some((x) => x.t === "diffFile" && x.path === "/ws/src/store.ts"),
       "★ 누르면 **바뀐 내용**으로 — 변경 전후가 남아 있으면 diff 다");
  }

  console.log("\n[파일 하나면 눌러서 연다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: "Read(store.ts)", kind: "read", status: "completed", paths: ["/ws/src/store.ts"] },
    ] })] });
    /*
     * ⏪ **알약을 누르면 바로 열렸다** — 파일이 하나뿐인 활동은 그랬다.
     * 이제는 **모든 알약이 같은 일**을 한다(팝업). 규칙이 둘이면 «이건
     * 열리고 저건 안 열리네» 가 되고, 그 차이는 화면에 안 보인다.
     */
    t.$("#screen-chat .act-pill").click();
    t.$(".modal .file").click();
    ok(t.sent.some((m) => m.t === "openFile" && m.path === "/ws/src/store.ts"), "openFile 전송");
  }

  console.log("\n[★ 알약은 도구 이름 — 제목이 명령 전체여도 (사용자, 2026-10-23)]");
  {
    /*
     * 🔴 사용자: *"search로만 나와야하는데 길게 나옴 … 이것 때문에 말풍선이 넘침"*.
     * Claude 어댑터 0.90 은 `title` 에 미리보기(명령 전체, `Search "…"`)를 싣는다.
     */
    const cmd = "python3 -I - <<'EOF'\np='models.txt'\ns=open(p).read()\nEOF";
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: 'Search "GLM-4-9B-0414 maximum output tokens max_tokens context length"',
        name: "WebSearch", kind: "fetch", status: "completed" },
      { id: "t2", title: cmd, name: "Bash", kind: "execute", status: "completed", command: cmd },
      // 이름을 안 주는 에이전트 — 길면 종류로 줄인다
      { id: "t3", title: "Running a very long command line that goes on and on", kind: "execute", status: "completed" },
      { id: "t4", title: "Running view_file", kind: "read", status: "completed" },
    ] })] });
    const what = t.$$("#screen-chat .act-pill .what").map((w) => w.textContent);
    ok(what[0] === "WebSearch", `★ **검색은 이름만** (${what[0]})`);
    ok(what[1] === "Bash", `★ **명령은 이름만** (${what[1]})`);
    ok(what[2] === "Shell", `★ 이름이 없고 길면 종류로 (${what[2]})`);
    ok(what[3] === "Running view_file", `짧은 제목은 그대로 (${what[3]})`);

    t.$$("#screen-chat .act-pill")[0].click();
    ok(t.$(".modal .act-title")?.textContent.includes("GLM-4-9B-0414 maximum"), "★ 원문은 눌러서 본다 — 버리지 않는다");
  }

  console.log("\n[사용량은 화면에 없다 — 압축 배너만 남는다 (B14)]");
  {
    const t = enter(mount(boot([meta()])));
    const usage = {
      totalTokens: 45200, inputTokens: 30000, outputTokens: 12000,
      contextUsed: 45200, contextSize: 200000, cost: { amount: 0.07, currency: "USD" },
    };
    t.send({ t: "msg", roomId: "r1", message: msg(), usage });

    const sub = t.$("#screen-chat .sub").textContent;
    ok(sub === "Claude · /ws", `**헤더에 토큰이 없다** (${sub})`);

    t.$$("#screen-chat .bar .icon").at(-1).click();
    t.$$(".menu button")[0].click();
    const rows = t.$$(".info-row").map((r) => r.textContent);
    ok(!rows.some((r) => /토큰|컨텍스트|비용|캐시/.test(r)), `방 정보에도 없다 (${rows.join(" | ")})`);
  }

  console.log("\n[다만 컨텍스트가 차면 압축을 권한다 — 그건 할 일이다 (C11)]");
  {
    const t = enter(mount(boot([meta()])), { messages: [msg({ id: "m0" })] });
    t.send({ t: "room", room: {
      id: "r1", title: "리팩터링", cwd: "/ws",
      participants: [{ id: "b1", agentId: "claude", name: "Claude", sessionId: "s1",
                       approver: { kind: "user" }, answerPolicy: "ask" }],
      messages: [msg({ id: "m0" })], unread: 0, createdAt: 1, lastActivityAt: 1,
      usage: { contextUsed: 190000, contextSize: 200000 },
    }, compactable: true });

    const banner = t.$("#screen-chat .banner.warn");
    ok(banner !== null, "90%를 넘으면 배너가 뜬다");
    ok(banner.textContent.includes("95%"), `찬 정도를 말해준다 (${banner.textContent.trim()})`);
    banner.querySelector("button").click();
    ok(t.sent.some((m) => m.t === "compact"), "누르면 압축한다");
  }

  console.log("\n[답한 카드는 사라진다 — 쌓이면 안 된다 (D1)]");
  {
    const t = enter(mount(boot([meta()])));
    const ask = (id) => t.send({ t: "ask", card: { id, kind: "permission", roomId: "r1", req: {
      title: "파일 수정", readOnly: false, kind: "edit",
      options: [{ optionId: "y", name: "허용", kind: "allow_once" },
                { optionId: "n", name: "거부", kind: "reject_once" }],
    }}});

    ask("p1");
    ok(t.$$(".approval").length === 1, "줄에 하나");
    t.$(".approval .quick button").click();
    ok(t.$$(".approval").length === 0, "**답하면 사라진다**");
    ok(t.sent.some((m) => m.t === "answer" && m.id === "p1"), "답은 나갔다");

    // 승인이 여러 번 일어나도 쌓이지 않는다
    for (const id of ["p2", "p3", "p4"]) {
      ask(id);
      ok(t.$$(".approval").length === 1, `${id}: 항상 한 줄만`);
      t.$(".approval .quick button").click();
    }
    ok(t.$$(".approval").length === 0, "**다 답하면 아무것도 안 남는다**");
    ok(t.$("#screen-chat .approvals").hidden === true, "큐도 접힌다");
  }

  console.log("\n[우리가 답하지 않고 끝난 카드도 치운다]");
  {
    const t = enter(mount(boot([meta()])));
    t.send({ t: "ask", card: { id: "z1", kind: "permission", roomId: "r1", req: {
      title: "파일 수정", readOnly: false, options: [{ optionId: "y", name: "허용", kind: "allow_once" }],
    }}});
    ok(t.$$(".approval").length === 1, "떠 있다");

    t.send({ t: "askResolved", id: "z1" });
    ok(t.$$(".approval").length === 0,
       "**답할 수 없게 된 카드는 남기지 않는다** — 셸이 알려준다");
  }

  console.log("\n[승인 카드 — 무엇을 승인하는지 보여준다 (D1)]");
  {
    const t = enter(mount(boot([meta()])));

    // 터미널 명령: 제목만으로는 rm -rf와 ls가 같아 보인다
    t.send({ t: "ask", card: { id: "p1", kind: "permission", roomId: "r1", req: {
      title: "터미널 명령", readOnly: false, kind: "execute",
      command: "rm -rf build && npm run build",
      options: [{ optionId: "y", name: "허용", kind: "allow_once" },
                { optionId: "n", name: "거부", kind: "reject_once" }],
    }}});
    ok(t.$(".approval .perm-cmd code").textContent === "rm -rf build && npm run build",
       "**실행할 명령이 그대로 보인다** — 펴면 나온다");
    ok(t.$(".approval .codicon-terminal") !== null, "종류에 맞는 아이콘");

    // 파일 수정: 경로 + 바뀔 내용
    t.send({ t: "ask", card: { id: "p2", kind: "permission", roomId: "r1", req: {
      title: "파일 수정", readOnly: false, kind: "edit",
      paths: ["/ws/src/core/store.ts"],
      diff: { path: "/ws/src/core/store.ts", oldText: "const a = 1;", newText: "const a = 2;" },
      options: [{ optionId: "y", name: "허용", kind: "allow_once" }],
    }}});
    const card = t.$$(".approval").at(-1);
    ok(card.querySelector(".file") !== null, "건드릴 파일이 보인다");
    ok(card.querySelector(".preview code").textContent === "const a = 2;",
       "바뀔 내용을 펼쳐 볼 수 있다");
    card.querySelector(".file").click();
    ok(t.sent.some((m) => m.t === "openFile" && m.path === "/ws/src/core/store.ts"),
       "파일을 눌러 에디터에서 열 수 있다");

    // 아무것도 없으면 제목만 — 깨지지 않는다
    t.send({ t: "ask", card: { id: "p3", kind: "permission", roomId: "r1", req: {
      title: "도구 사용", readOnly: true,
      options: [{ optionId: "y", name: "허용", kind: "allow_once" }],
    }}});
    const bare = t.$$(".approval").at(-1);
    ok(bare.querySelector(".perm-cmd") === null, "명령이 없으면 안 그린다");
    ok(bare.querySelector(".codicon-shield") !== null, "종류를 모르면 기본 아이콘");
  }

  console.log("\n[첨부 칩 — 빼기 가능]");
  {
    const t = mount(boot());
    t.send({ t: "room", room: room(), compactable: false });
    t.send({
      t: "attached",
      roomId: "r1",
      attachments: [
        { sha256: "a".repeat(64), mimeType: "text/plain", name: "log.txt", byteSize: 2048 },
      ],
    });
    ok(t.$(".chips .chip-name").textContent === "log.txt", "칩이 생김");
    ok(t.$(".chips .chip-size").textContent === "2KB", "크기 표시");
    t.$(".chip-x").click();
    ok(t.$(".chips").hidden === true, "빼면 칩 줄이 사라짐");
  }

  console.log("\n[★ 창이 뜨면 **로그인부터 확인한다** (2026-10-13)]");
  {
    /*
     * 🔴 우리 짐작은 «자격 파일이 있나» 뿐이라 **만료 · 다른 데서 로그아웃 ·
     * 철회**를 하나도 못 본다. 그걸 모른 채 들어가면 긴 글을 다 쓰고 **보낼
     * 때** 막히고, 그때 뜨는 것은 CLI 원문이다.
     */
    const t = mount({ ...boot([], "auth"), auth: [
      { id: "claude", label: "Claude", at: "asking" },
      { id: "agy", label: "Antigravity", at: "yes", guessed: true },
    ]});
    const scr = t.$("#screen-auth");
    ok(scr.classList.contains("active"), "★ **첫 화면이 확인 화면이다**");
    ok(!t.$("#screen-list").classList.contains("active"),
       "★ 목록이 안 보인다 — 번쩍했다 덮이면 사용자 눈엔 **버벅인 것**이다");
    ok(scr.textContent.includes("확인 중"), "묻는 중이라고 말한다");
    ok(scr.textContent.includes("파일로만 확인"),
       "★ **물어본 것과 파일만 본 것을 가른다** — 같이 적으면 «확인했다» 가 거짓말이 된다");

    t.send({ t: "auth", stuck: false, list: [
      { id: "claude", label: "Claude", at: "yes" },
      { id: "agy", label: "Antigravity", at: "yes", guessed: true },
    ]});
    ok(!t.$("#screen-auth").textContent.includes("확인 중"), "답이 오면 걷힌다");

    t.send({ t: "nav", screen: "list" });
    ok(t.$("#screen-list").classList.contains("active"), "★ 끝나면 원래 가려던 화면으로");
    ok(!t.$("#screen-auth").classList.contains("behind"),
       "★ **확인 화면은 뒤에 안 남는다** — 돌아갈 자리가 아니다");
  }

  console.log("\n[★ 낡은 것이 있으면 로봇 화면으로 — **확인 화면을 밟고 넘어간다**]");
  {
    /*
     * 핀이 올라갔으면 창이 뜰 때 로봇 화면으로 보낸다(`landingFor`). 그 길은
     * **확인 화면 위를 지나간다** — 창은 거기서 시작하기 때문이다.
     *
     * 🔴 사용자가 짚었다: *"로딩창에서 로봇 화면으로 전환될때, 화면이
     * 왼쪽으로 다 안넘어감"*. `["auth"]` 위에 얹으면 확인 화면이
     * `behind`(-24%) 로 남아 **덜 빠진 것처럼** 보이고, 더 나쁜 것은
     * **뒤로가기가 끝난 로딩 화면으로** 돌아간다는 것이다 — 거기엔 나갈
     * 길이 없다.
     */
    const t = mount({ ...boot([], "auth"), auth: [
      { id: "claude", label: "Claude", at: "asking" },
    ]});
    ok(t.$("#screen-auth").classList.contains("active"), "전제 — 확인 화면에서 시작한다");

    t.send({ t: "nav", screen: "agents" });
    const auth = t.$("#screen-auth");
    ok(t.$("#screen-agents").classList.contains("active"), "★ 로봇 화면이 선다");
    ok(!auth.classList.contains("active") && !auth.classList.contains("behind"),
       "★ **확인 화면은 뒤에도 안 남는다** — 스택에서 아예 빠진다");

    /* 그리고 뒤로가기는 **목록**이다 — 끝난 로딩 화면이 아니라 */
    t.$("#screen-agents .bar button").click();
    ok(t.$("#screen-list").classList.contains("active"),
       "★ **뒤로가면 목록** — 바닥을 깔아줬으므로 갇히지 않는다");
  }

  console.log("\n[★ 다 떴다고 알린다 — **먼저 보낸 것이 사라지므로**]");
  {
    /*
     * 🔴 호스트와 웹뷰는 **다른 프로세스**다. 웹뷰는 HTML 을 받고 스크립트를
     * 돌려야 받을 사람이 생기는데, 그 전에 던진 것은 **그냥 사라진다.**
     * (`Boot.screen` 이 있는 까닭이 그거다.)
     *
     * 로그인 확인은 **0.1초에 끝날 수도 있다** — Codex 만 깔려 있으면 그렇다.
     * 그러면 `auth(끝)` 과 `nav` 가 통째로 그 구멍에 빠지고 사용자는 **확인
     * 화면에 영영 갇힌다.** 「다시 시도」도 안 나온다 — 호스트는 기한을 안
     * 넘겼다고 믿으니까.
     *
     * ⚠️ **빠를수록 터진다.** 평소엔 멀쩡하다가 잘 돌아갈 때 갇히는 모양이라
     * 재현이 어렵다. 그래서 «늦게라도 알린다» 를 여기서 못으로 박는다.
     */
    const t = mount(boot());
    ok(t.sent.some((m) => m.t === "ready"),
       "★ **스크립트가 다 돌면 알린다** — 호스트가 들고 있던 것을 그때 다시 준다");
  }

  console.log("\n[★ 낡은 에이전트가 있으면 **그 화면으로 보낸다** (2026-10-13)]");
  {
    /*
     * 🔴 여태 낡았다는 것을 **로봇 화면 안에서만** 말했다 — 띠도 뱃지도
     * 알림도 없다. 안 열어보면 영영 모르고, 그동안 옛 어댑터가 멀쩡히 돈다.
     * 핀을 올리는 까닭은 **새 모델**인데 사용자는 옛 모델에 묶인 채
     * 알아챌 방법이 없다.
     *
     * ★ **막지는 않는다.** 모델이 없어진 것(`fix`)과 달리 앱은 돈다 —
     * 띄워주는 것까지만 하고, 뒤로 가면 목록이 나온다.
     */
    const t = enter(mount(boot([meta()])));
    t.send({ t: "nav", screen: "agents" });
    ok(t.$$(".screen.active").map((x) => x.id).includes("screen-agents"),
       "★ **로봇 화면이 뜬다**");
    ok(t.sent.some((m) => m.t === "agentsAsk"),
       "★ 그리고 **지금 상태를 다시 묻는다** — 낡음 표시가 그 답으로 그려진다");

    t.key("Escape");
    ok(!t.$$(".screen.active").map((x) => x.id).includes("screen-agents"),
       "★ **얹은 것이라 뒤로 하나면 빠져나온다** — 막는 화면이 아니다");
  }

  console.log("\n[★ 기한을 넘기면 **사람에게 묻는다**]");
  {
    /*
     * 🔴 **조용히 넘어가지 않는다.** 그러면 «로그인했는데 왜 안 되지» 가
     * 나중에 터지고, 그때는 왜인지 알 길이 없다.
     */
    const t = mount({ ...boot([], "auth"), auth: [{ id: "codex", label: "Codex", at: "asking" }]});
    t.send({ t: "auth", stuck: true, list: [{ id: "codex", label: "Codex", at: "asking" }]});
    const scr = t.$("#screen-auth");
    ok(scr.textContent.includes("답이 없습니다"), "★ **답이 없다고 말한다**");
    ok(scr.textContent.includes("Codex"), "★ 누가 안 답했는지 **이름으로**");

    const btns = [...scr.querySelectorAll(".auth-acts button")];
    ok(btns.map((b) => b.textContent).join(",") === "다시 시도,그냥 들어가기",
       `★ 고를 수 있다 (${btns.map((b) => b.textContent).join(",")})`);
    btns[0].click();
    ok(t.sent.some((m) => m.t === "authRetry"), "★ [다시 시도] 가 간다");
    btns[1].click();
    ok(t.sent.some((m) => m.t === "authSkip"), "★ [그냥 들어가기] 도 간다");
  }

  console.log("\n[★ 옆 방에 다녀오면 **옛 «답하는 중» 을 안 들고 온다** (2026-11-18)]");
  {
    /*
     * 🔴 상태는 **보는 방 것만** 받는다. 다른 방에 있는 사이 봇이 끝나면 그 소식은
     * 버려지고, 돌아왔을 때 화면은 여전히 «답하는 중» 이라 친 말을 **예약으로**
     * 올렸다 — 사용자 눈에는 «바로 안 나가고 멈춰 있다».
     */
    const t = mount(boot());
    t.send({ t: "room", room: room(), compactable: false });
    t.send({ t: "status", roomId: "r1", status: "streaming", bots: { b1: "streaming" } });
    // 옆 방에 갔다가 (그 사이 r1 의 «끝났다» 는 이 화면에 안 온다)
    t.send({ t: "room", room: room({ id: "r2", participants: [
      { id: "b2", agentId: "codex", name: "Codex", sessionId: "s2",
        approver: { kind: "user" }, answerPolicy: "ask" }] }), compactable: false });
    // 돌아온다 — 상태 소식 없이
    t.send({ t: "room", room: room(), compactable: false });
    const box = t.$("#screen-chat .composer textarea");
    box.value = "돌아와서 친 말";
    t.$("#screen-chat button.send").click();
    const last = t.sent.filter((m) => m.t === "send" || m.t === "stage").pop();
    ok(last?.t === "send", `★ **바로 보낸다** — 예약으로 안 올린다 (${last?.t})`);
  }

  /*
   * ★ **Claude in Chrome** (사용자, 2026-11-19: *"Claude in Chrome 은 지원하게 할 수 있어?"*).
   * 켤 줄 아는 에이전트에만 칸이 뜨고, 켠 봇은 참여자 요약에 «Chrome» 이 붙고,
   * 활동을 펼치면 봇이 본 화면(스크린샷)이 보인다.
   */
  console.log("\n[★ Chrome — 켤 줄 아는 봇에만 칸이 뜬다]");
  {
    const agents = [
      { ...AGENTS[0], browser: { label: "Claude in Chrome", needs: "확장이 있어야 합니다." } },
      AGENTS[1],
    ];
    const two = [
      { id: "b1", agentId: "claude", name: "Claude", sessionId: "s1",
        approver: { kind: "user" }, answerPolicy: "ask" },
      { id: "b2", agentId: "codex", name: "Codex", sessionId: "s2",
        approver: { kind: "user" }, answerPolicy: "ask" },
    ];
    const t = enter(mount({ ...boot([meta()]), agents }), { participants: two });
    t.$(".composer .perm").click();
    const boxes = t.$$("#screen-perm .sheet-bot:not(.relay)");
    const chromeOf = (box) => [...box.querySelectorAll(".field")]
      .find((f) => f.querySelector("label")?.textContent === "Claude in Chrome");
    ok(chromeOf(boxes[0]) !== undefined, "★ Claude 봇에는 «Claude in Chrome» 칸이 있다");
    ok(chromeOf(boxes[1]) === undefined, "★ **Codex 봇에는 없다** — 켤 길이 없는 칸은 안 띄운다");
    const pick = chromeOf(boxes[0]).querySelector("select");
    ok(pick.value === "off", "★ 처음엔 꺼져 있다");
    ok(chromeOf(boxes[0]).textContent.includes("확장이 있어야 합니다."), "★ 무엇을 갖춰야 하는지 적는다");
    ok(chromeOf(boxes[0]).textContent.includes("다음 말부터"), "★ 언제부터 되는지 적는다");
    pick.value = "on";
    pick.dispatchEvent(new t.w.Event("change"));
    const sent = t.sent.filter((m) => m.t === "setPolicy").pop();
    ok(sent?.botId === "b1" && sent.browser === true, `★ 그 봇에게 켜라고 보낸다 (${JSON.stringify(sent)})`);

    const t2 = enter(mount({ ...boot([meta()]), agents }), {
      participants: [{ ...two[0], browser: true }, two[1]],
    });
    t2.$(".composer .perm").click();
    const on = chromeOf(t2.$$("#screen-perm .sheet-bot:not(.relay)")[0]);
    ok(on.querySelector("select").value === "on", "★ 켠 것은 켜진 채로 그려진다");
  }

  console.log("\n[★ 활동을 펼치면 봇이 본 화면이 보인다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: "mcp__claude-in-chrome__computer", name: "Chrome computer", kind: "other",
        status: "completed", output: "Successfully captured screenshot",
        images: [{ sha256: "ab".repeat(32), mimeType: "image/jpeg" }] },
    ] })] });
    const pill = t.$("#screen-chat .act-pill .what");
    ok(pill?.textContent === "Chrome computer", `★ 알약에 «Chrome» 이 보인다 (${pill?.textContent})`);
    t.$("#screen-chat .act-pill").click();
    const shot = t.$(".modal img.act-shot");
    ok(shot !== null, "★ 스크린샷 자리가 생긴다");
    const asked = t.sent.filter((m) => m.t === "needBlob").pop();
    ok(asked?.sha256 === "ab".repeat(32) && asked.mimeType === "image/jpeg",
       "★ 원본을 **종류와 함께** 달라고 한다 — 확장은 이 그림의 종류를 모른다");
    t.send({ t: "blobData", sha256: "ab".repeat(32), dataUri: "data:image/jpeg;base64,AAAA" });
    ok(shot.src.startsWith("data:image/jpeg"), "★ 받으면 그려진다");
  }

  console.log("\n[★ 답이 흐르는 중에 위로 올리면 끌려내려가지 않는다]");
  {
    /*
     * 사용자: *"글이 오면 자꾸 화면이 끌려내려가"* (2026-11-20). `scroll` 이벤트는
     * 다음 프레임에 오는데 그 사이 답 조각이 와서 바닥으로 다시 끌었다. jsdom 은
     * 배치가 없으니 목록의 길이·자리를 손으로 둔다 — **scroll 이벤트는 안 보낸다**
     * (그것이 늦게 오는 상황 그대로).
     */
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", text: "첫 답" })] });
    const list = t.$("#screen-chat .messages");
    let top = 800;
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = Math.min(v, 800); } });
    const stream = (text) => t.send({ t: "msg", roomId: "r1", message: msg({ id: "b", text }) });

    top = 790;
    stream("조각 1");
    ok(top === 800, "바닥에 있으면 답을 따라 내려간다");

    const bubble = list.querySelector(".msg") ?? list;
    bubble.dispatchEvent(new t.w.WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    top = 795; // 부드러운 스크롤의 첫 프레임 — 몇 px 뿐
    stream("조각 2");
    ok(top === 795, `★ **휠을 위로 굴리면 그 순간 놓는다** — 다음 조각이 끌어내리지 않는다 (${top})`);

    // 바닥으로 다시 내려오면 도로 붙는다
    top = 800;
    list.dispatchEvent(new t.w.Event("scroll", { bubbles: true }));
    top = 790;
    stream("조각 3");
    ok(top === 800, "★ 바닥까지 내려오면 다시 따라간다");

    // 키나 스크롤바로 조금(문턱 60px 안) 올라가도 — 올라간 것은 사람이다
    top = 780;
    list.dispatchEvent(new t.w.Event("scroll", { bubbles: true }));
    stream("조각 4");
    ok(top === 780, `★ **문턱 안이라도 위로 갔으면 놓는다** (${top})`);

    // 스크롤바를 잡고 있는 동안에도 끌지 않는다
    top = 800;
    list.dispatchEvent(new t.w.Event("scroll", { bubbles: true }));
    list.dispatchEvent(new t.w.Event("pointerdown", { bubbles: true }));
    top = 799;
    stream("조각 5");
    ok(top === 799, "★ 스크롤바를 잡고 있으면 끌지 않는다");
    t.w.dispatchEvent(new t.w.Event("pointerup"));
  }

  console.log("\n전부 통과\n");
}

main();
