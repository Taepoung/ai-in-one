/**
 * **«봇을 나눠도 기억은 안 나뉜다»를 다중 봇 방에 공지한다.**
 *
 * 실측(§13.2): 기억은 `~/.claude/projects/<cwd 슬러그>/memory/` 에 쌓이고 **열쇠가 cwd**다.
 * 그래서 한 방에 봇을 여럿 두면 «리뷰어에게만 시킨 기억»이 «구현자»에게도 간다.
 *
 * 🔴 **대화는 갈라져 보이니까 사용자가 알 길이 없다.** 우리가 막을 수 없는 것이지만
 * (§0) 말은 해줘야 한다 — 봇이 둘 이상일 때만, 1:1에서는 소음이므로 안 띄운다.
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

const bot = (id, agentId) => ({ id, agentId, name: agentId, sessionId: "s" + id,
                                approver: { kind: "user" }, answerPolicy: "ask" });

const room = (bots) => ({
  id: "r1", title: "방", cwd: "/ws", participants: bots,
  messages: [{ id: "u1", role: "user", text: "해줘", deliveredTo: [], createdAt: 1 }],
  unread: 0, createdAt: 1, lastActivityAt: 2,
});

/** 방을 열고 헤더의 참여자 버튼을 누른다 */
function openInfo(t, bots) {
  t.$(".room").click();
  t.send({ t: "room", room: room(bots), compactable: false });
  t.$$("#screen-chat .bar button").find((b) => /참여자/.test(b.title)).click();
  return t.$("#screen-bots");
}

const SAYS = "기억은 봇마다 나뉘지 않습니다";

console.log("\n[1:1 — 말할 게 없다]");
{
  const t = mount();
  const card = openInfo(t, [bot("b1", "claude")]);
  ok(card.querySelector(".drawer-bot") !== null, "서랍이 열린다");
  ok(!card.textContent.includes(SAYS),
     "★ 봇이 하나면 안 띄운다 — 나눌 봇이 없는데 «안 나뉜다»는 소음일 뿐이다");
}

console.log("\n[다중 봇 — 서랍에 공지한다]");
{
  const t = mount();
  const card = openInfo(t, [bot("b1", "claude"), bot("b2", "codex")]);
  ok(card.textContent.includes(SAYS), "★ 봇이 둘이면 뜬다");
  ok(card.querySelector(".warn-row") !== null, "분기 경고와 같은 모양 — 막지 않고 알린다");
  ok(card.textContent.includes("대화 내용 자체는 봇마다 따로"),
     "★ 새는 것과 안 새는 것을 같이 적는다 — 안 그러면 «전부 샌다»로 읽힌다");

  // 봇들을 본 **바로 다음**이어야 한다 — «나눠놓았지만 기억은 하나»가 되게
  const kids = [...card.children];
  const lastBot = kids.map((n) => n.classList.contains("drawer-bot")).lastIndexOf(true);
  ok(kids[lastBot + 1]?.classList.contains("warn-row"),
     "★ 봇 목록 **바로 뒤**에 — 봇 하나의 설정으로 오해되지 않게");
  ok(card.querySelectorAll(".drawer-bot").length === 2, "봇 둘이 나란히 보인다");
}

console.log("\n[권한 설정 — 봇이 나란히 보이는 자리에도]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "room", room: room([bot("b1", "claude"), bot("b2", "codex")]), compactable: false });
  const perm = t.$("#screen-chat .perm");
  ok(perm !== null, "입력창 옆에 권한 버튼이 있다");
  perm.click();
  const sheet = t.$("#screen-perm");
  ok(sheet.querySelectorAll(".sheet-bot").length === 2, "봇 둘이 나란히 보인다");
  ok(sheet.textContent.includes(SAYS),
     "★ 봇마다 설정을 나누는 화면이라 «기억도 나뉘겠지»로 읽기 쉽다 — 여기서 짚는다");
  ok([...sheet.children].at(-1).classList.contains("warn-row"),
     "봇 블록들 **아래**에 — 설정 하나로 오해되지 않게");
}

console.log("\n[1:1 권한 설정 — 여기서도 조용하다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "room", room: room([bot("b1", "claude")]), compactable: false });
  const MODE = [{ configId: "mode", name: "권한 모드", category: "mode", type: "select", current: "d", values: [{ id: "d", name: "기본", description: "아주 긴 설명이 여기 온다 — 길이를 우리가 정하지 않는다" }] }];
  // 이 방엔 b1(claude) 하나뿐이다 — 설정은 봇 단위다
  t.send({ t: "config", agentId: "claude", roomId: "r1", botId: "b1", options: MODE });
  t.$("#screen-chat .perm").click();
  ok(!t.$("#screen-perm").textContent.includes(SAYS), "★ 봇이 하나면 시트에도 없다");
}

console.log(String.fromCharCode(10) + "[★ 권한 세 칸은 가로로 누운다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "room", room: room([bot("b1", "claude"), bot("b2", "codex")]), compactable: false });
  t.$("#screen-chat .perm").click();

  const blocks = t.$$("#screen-perm .sheet-bot");
  ok(blocks.length === 2, "봇 둘");
  for (const b of blocks) {
    const row = b.querySelector(".policy");
    ok(row !== null,
       "★ 세 칸이 **한 줄로** 묶여 있다 — 위아래로 쌓으면 봇 셋에 아홉 줄이 된다");
    const n = row.querySelectorAll(":scope > .field").length;
    ok(n >= 2, `한 줄 안에 칸이 여럿 (${n}개: 승인 주체 · 질문, 모드는 설정이 와야)`);
  }

  // 설명은 한 줄로 잘리므로 전문을 툴팁으로 들고 있어야 한다
  const hint = [...blocks[0].querySelectorAll(".policy span.dim")][0];
  ok(hint.title.includes(hint.textContent) && hint.textContent !== "",
     "★ 한 줄로 잘리므로 툴팁이 **보이는 글을 품는다** — 길이를 우리가 정하지 않는다");
}

console.log(String.fromCharCode(10) + "[★ 시트가 방을 따라간다]");
{
  const t = mount();
  t.$(".room").click();
  t.send({ t: "room", room: room([bot("b1", "claude")]), compactable: false });
  t.$("#screen-chat .perm").click();
  ok(t.$$("#screen-perm .sheet-bot").length === 1, "열 때는 하나");

  // 시트를 열어둔 채 봇을 부른다
  t.send({ t: "room", room: room([bot("b1", "claude"), bot("b2", "codex")]), compactable: false });
  ok(t.$$("#screen-perm .sheet-bot").length === 2,
     "★ **새 봇이 바로 들어온다** — 열던 순간으로 멈춰 있으면 그 봇 권한을 못 정한다");

  t.send({ t: "room", room: room([bot("b1", "claude")]), compactable: false });
  ok(t.$$("#screen-perm .sheet-bot").length === 1,
     "★ 내보낸 봇도 바로 빠진다");

  /*
   * ⏪ **덮개가 없어졌다** (2026-09-30) — 권한이 «화면»이 되면서다.
   *
   * 덮개는 시트 배경이 대화와 거의 같은 색이 되는 것을 가리려던 물건이었다.
   * 화면은 뒤가 안 비치므로 가릴 것이 없다.
   */
  const outBtn = t.$("#screen-perm .bar button");
  ok(outBtn !== null, "★ 머리줄에 돌아가기가 있다");
  outBtn.click();
  ok(t.$$(".screen.active").map((x) => x.id).includes("screen-chat"),
     "★ **누르면 채팅으로 돌아온다** — 목록이 아니라 보던 방으로");
}

console.log("\n전부 통과");
