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

    t.send({ t: "room", room: room(), compactable: false });
    ok(t.screenOf() === "chat", "**채팅 화면으로 전환된다**");
    ok(t.$("#screen-chat h1").textContent.startsWith("리팩터링"), "제목이 헤더에");
  }

  console.log("\n[목록에서 방을 눌러도 들어간다]");
  {
    const t = mount(boot([meta()]));
    t.$(".room").click();
    ok(t.sent.some((m) => m.t === "open" && m.roomId === "r1"), "open 전송");
    ok(t.screenOf() === "chat", "채팅으로 전환");
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

    t.$(".tool summary").click();
    ok(t.$(".act-in code").textContent === "rm -rf build && npm run build",
       "**실행한 명령이 그대로 보인다** — `Bash`만으로는 아무것도 못 판단한다");
    ok(t.$(".activity .at") !== null, "언제 했는지도 — 타임라인으로 읽힌다");
    ok(t.$$(".activity").length === 2, "명령이 없는 것도 한 줄로");
    ok(t.$$(".act").length === 1, "명령이 있는 것만 묶음이 생긴다");

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
    const row = t.$(".activity");
    const what = row.querySelector(".what");
    ok(what !== null, "★ **제목이 제 상자에 있다** — 여기서만 줄어들게 하려면 상자가 있어야 한다");
    ok(what.textContent === "Bash", `★ 제목 그대로 («${what.textContent}»)`);
    ok(row.querySelector(".at") !== null,
       "★ **시각이 같은 줄에 남는다** — 제목이 길어도 밀려나면 안 된다");
    ok([...row.children].indexOf(what) < [...row.children].indexOf(row.querySelector(".at")),
       "★ 제목이 먼저, 시각이 뒤 — 순서도 그대로");
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

    t.$(".tool summary").click();
    // 실패한 것이 **먼저** 나온다 (접지 않으므로) — 내용으로 찾는다
    const ins = t.$$(".act-in code").map((n) => n.textContent);
    ok(ins.includes("npm test"), `**들어간 것** — 실행한 명령 (${ins.join(" / ")})`);

    const passed = t.$$(".act").find((a) => a.textContent.includes("npm test"));
    ok(passed.querySelector(".act-out code").textContent.includes("12 passed"),
       "**나온 것** — 결과가 명령 아래 붙는다");
    ok(passed.open === false,
       "**성공한 건 통째로 접혀 있다** — 제목 줄만 보인다");
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
    ok(t.$(".act").open === true,
       "**실패는 바로 보여준다** — 왜 실패했는지가 접혀 있으면 안 된다");
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

    // 말풍선이 셋으로 갈리고 사이사이에 활동이 낀다
    ok(t.$$(".msg.agent .bubble").length === 3,
       `**말풍선이 갈린다** (${t.$$(".msg.agent .bubble").length})`);
    ok(t.$$(".tool-group").length === 2, "활동 묶음도 둘");

    const order = [...t.$(".msg.agent").children]
      .map((n) => (n.classList.contains("row") ? "말" : n.classList.contains("tool-group") ? "활동" : ""))
      .filter(Boolean)
      .join(">");
    ok(order === "말>활동>말>활동>말",
       `**말 → 활동 → 말 순서로 놓인다** (${order})`);

    const bubbles = t.$$(".msg.agent .bubble").map((b) => b.textContent.trim());
    ok(bubbles[0].includes("먼저 테스트를"), "첫 조각");
    ok(bubbles[2].includes("통과했습니다"), "마지막 조각");
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
    const kids = [...t.$(".msg.agent").children].map((n) => n.className);
    ok(kids.indexOf("row") < kids.indexOf("tool-group"),
       "**활동이 뒤에 온다** — 기록을 고치지 않는다");
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
    ok(labels.join(",") === "권한 모드,승인 주체,질문",
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

    const det = t.$("#screen-chat .tool-group details");
    ok(det !== null, "활동이 기록된다");
    ok(det.open === false, "**기본으로 접혀 있다**");
    ok(det.querySelector("summary").textContent.includes("활동 2개"), "개수를 보여준다");
    ok(t.$$("#screen-chat .activity").length === 2, "펼치면 목록");
    ok(t.$("#screen-chat .codicon-terminal") !== null, "종류에 맞는 아이콘");
  }

  console.log("\n[실패한 활동은 접지 않는다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: "Read(a.ts)", kind: "read", status: "completed" },
      { id: "t2", title: "Bash(npm test)", kind: "execute", status: "failed" },
    ] })] });

    const failed = t.$("#screen-chat .activity.failed");
    ok(failed !== null, "**실패는 바로 보인다**");
    ok(failed.closest("details") === null, "접힌 묶음 밖에 있다");
    ok(t.$("#screen-chat details summary").textContent.includes("활동 1개"),
       "나머지만 접힌다");
  }

  console.log("\n[아직 도는 중이면 펼쳐둔다 — 멈춘 것처럼 보이면 안 된다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", streaming: true, tools: [
      { id: "t1", title: "Read(a.ts)", kind: "read", status: "in_progress" },
    ] })] });
    ok(t.$("#screen-chat .tool-group details").open === true, "진행 중엔 펼침");
  }

  console.log("\n[파일 하나면 눌러서 연다]");
  {
    const t = mount(boot([meta()]));
    enter(t, { messages: [msg({ id: "a", tools: [
      { id: "t1", title: "Read(store.ts)", kind: "read", status: "completed", paths: ["/ws/src/store.ts"] },
    ] })] });
    t.$("#screen-chat .activity").click();
    ok(t.sent.some((m) => m.t === "openFile" && m.path === "/ws/src/store.ts"), "openFile 전송");
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

  console.log("\n전부 통과\n");
}

main();
