/**
 * **이름을 바꾸면 이름이 보이는 모든 자리가 따라간다** (§4.2.1).
 *
 * 🔴 말풍선 캐시의 서명(`sigOf`)에 **글쓴이 이름만** 들어 있었다. 그런데
 * 말풍선 안에는 이름이 더 있다 — **받는 이 칩**(`@리뷰어`), «…에게 전달되지
 * 않았습니다». 그것들은 **id 로만** 서명에 들어가서(`deliveredTo`), 이름을
 * 바꿔도 서명이 안 바뀌고 **캐시가 옛 이름이 박힌 말풍선을 그대로 돌려줬다.**
 *
 * 🔴 **입력창에 이미 꽂힌 칩**도 같았다. 칩은 `data-bot` 을 들고 있어 라우팅은
 * 멀쩡하지만 **글자는 만들 때 박아 넣은 옛 이름 그대로**다 — 「@구현」이라
 * 적힌 칩을 보내면 화면에는 「@리뷰어」에게 간 것으로 나온다. **보이는 것과
 * 가는 곳이 어긋나면 어디를 믿어야 할지 알 수 없다.**
 *
 * 자리를 하나씩 서명에 넣다 보면 반드시 하나를 빠뜨린다. 이름 바꾸기는 드무니
 * **도장 하나로 통째로 다시 그린다.**
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
const both = (n1 = "구현", n2 = "리뷰어") =>
  [bot("b1", "claude", n1), bot("b2", "codex", n2)];

const msgs = () => [
  { id: "u1", role: "user", text: "@구현 해줘", deliveredTo: ["b1"], createdAt: 1 },
  { id: "a1", role: "agent", text: "했어", authorBotId: "b1", deliveredTo: [], createdAt: 2 },
  { id: "u2", role: "user", text: "이것도", deliveredTo: ["b1", "b2"],
    notSentTo: ["b1"], sendFailed: "끊겼습니다", createdAt: 3 },
];
const room = (bots) => ({
  id: "r1", title: "방", cwd: "/ws", participants: bots,
  messages: msgs(), unread: 0, createdAt: 1, lastActivityAt: 2,
});

/** 방을 열고 말풍선이 한 번 그려지게 한다 (그래야 캐시가 찬다) */
function open(t) {
  t.$(".room").click();
  t.send({ t: "room", room: room(both()), compactable: false });
  return t;
}

console.log("\n[★ 받는 이 칩이 새 이름으로 바뀐다]");
{
  const t = open(mount());
  const before = t.$$(".chip.to").map((c) => c.textContent);
  ok(before.includes("@구현"), `처음엔 옛 이름 (${before.join(" ")})`);

  // 코어가 이름을 바꾼 방을 돌려준다
  t.send({ t: "room", room: room(both("설계자")), compactable: false });

  const after = t.$$(".chip.to").map((c) => c.textContent);
  ok(!after.includes("@구현"),
     `★ **옛 이름이 안 남는다** (${after.join(" ")}) — 캐시가 옛 말풍선을 돌려줬었다`);
  ok(after.includes("@설계자"), "★ 새 이름으로 다시 그려진다");
  ok(after.includes("@리뷰어"), "★ 안 바꾼 봇은 그대로");
}

console.log("\n[★ 말풍선 글쓴이 이름도]");
{
  const t = open(mount());
  ok(t.$$(".who").some((n) => n.textContent.includes("구현")), "처음엔 옛 이름");
  t.send({ t: "room", room: room(both("설계자")), compactable: false });
  ok(t.$$(".who").some((n) => n.textContent.includes("설계자")), "★ 새 이름");
  ok(!t.$$(".who").some((n) => n.textContent.includes("구현")), "★ 옛 이름은 없다");
}

console.log("\n[★ «전달되지 않았습니다» 줄도]");
{
  const t = open(mount());
  const line = () => t.w.document.body.textContent;
  ok(line().includes("구현에게 전달되지 않았습니다"), `처음엔 옛 이름`);
  t.send({ t: "room", room: room(both("설계자")), compactable: false });
  ok(line().includes("설계자에게 전달되지 않았습니다"),
     "★ 여기도 따라간다 — id 로만 서명에 들어가서 놓치던 자리다");
}

console.log("\n[★ 입력창에 이미 꽂힌 칩도]");
{
  const t = open(mount());
  const box = t.$("#screen-chat .chipbox");
  ok(box !== null, "단체방이라 칩 상자다");

  /*
   * 칩은 **멘션 픽커**로 꽂는다 — v2.1 부터 서랍의 이름은 «뷰 열기»라
   * 더 이상 칩을 꽂지 않는다.
   */
  box.textContent = "@";
  const sel = t.w.document.getSelection();
  const rng = t.w.document.createRange();
  rng.setStart(box.firstChild, 1);
  rng.collapse(true);
  sel.removeAllRanges();
  sel.addRange(rng);
  box.dispatchEvent(new t.w.Event("input", { bubbles: true }));
  t.$$("#screen-chat .picker button")[0].click();
  const chip = t.$("#screen-chat .chipbox .chip[data-bot]");
  ok(chip !== null && chip.textContent === "@구현", `칩이 꽂혔다 (${chip?.textContent})`);

  t.send({ t: "room", room: room(both("설계자")), compactable: false });
  const now = t.$("#screen-chat .chipbox .chip[data-bot]");
  ok(now.getAttribute("data-bot") === "b1",
     "★ **가리키는 대상은 안 바뀐다** — 칩은 id 를 들고 있다");
  ok(now.textContent === "@설계자",
     `★ **글자가 따라간다** (${now.textContent}) — 보이는 것과 가는 곳이 어긋나면 안 된다`);
}

console.log("\n[★ 멘션 자동완성도]");
{
  const t = open(mount());
  const box = t.$("#screen-chat .chipbox");
  const typeAt = () => {
    box.textContent = "@";
    const sel = t.w.document.getSelection();
    const rng = t.w.document.createRange();
    rng.setStart(box.firstChild, 1);
    rng.collapse(true);
    sel.removeAllRanges();
    sel.addRange(rng);
    box.dispatchEvent(new t.w.Event("input", { bubbles: true }));
  };
  typeAt();
  ok(t.$("#screen-chat .picker")?.textContent.includes("@구현"), "처음엔 옛 이름");

  t.send({ t: "room", room: room(both("설계자")), compactable: false });
  typeAt();
  const pk = t.$("#screen-chat .picker")?.textContent ?? "";
  /*
   * 🔴 이 처리기는 `mountChat` 이 붙일 때의 방을 들고 있었다. 이름을 바꿔도
   * 참여자 수는 그대로라 **다시 붙지 않으므로**, 옛 이름이 박힌 방을 계속
   * 봤다 — 자동완성에서 고른 이름이 화면 어디에도 없는 이름이었다.
   */
  ok(!pk.includes("@구현"), `★ **옛 이름이 안 남는다** (${pk})`);
  ok(pk.includes("@설계자"), "★ 지금 방을 본다");
}

console.log("\n[★ 권한 설정 시트도 — **열 때** 지금 방을 본다]");
{
  const t = open(mount());
  // 먼저 이름을 바꾼다 (시트는 아직 안 열었다)
  t.send({ t: "room", room: room(both("설계자")), compactable: false });

  /*
   * 🔴 시트를 여는 단추가 `mountChat` 이 붙을 때의 방을 들고 있었다.
   * **열려 있는 동안은 `paintChat` 이 갱신해 주므로 «열 때»만 어긋났다** —
   * 그래서 더 찾기 어려웠다.
   */
  t.$("#screen-chat .composer .perm").click();
  const sheet = t.$("#screen-perm").textContent;
  ok(!sheet.includes("구현"), `★ **옛 이름이 안 남는다** (${sheet.slice(0, 40)}…)`);
  ok(sheet.includes("설계자"), "★ 지금 방을 본다");
}

console.log("\n[★ 방 목록에도 봇 이름이 나온다]");
{
  const t = mount();
  t.send({ t: "metas", rooms: [{ ...META, names: ["구현", "리뷰어"],
                                 agentIds: ["claude", "codex"], models: ["Opus 5", "Sonnet 5"] }] });
  const who = t.$(".room .room-who");
  ok(who.textContent === "구현, 리뷰어",
     `★ **부를 이름이 방 아래 줄에 나온다** (${who.textContent})`);
  ok(who.title === "구현 (Claude · Opus 5), 리뷰어 (Codex · Sonnet 5)",
     `★ **모델·에이전트는 툴팁에 남는다** (${who.title}) — 접는 건 되지만 버리는 건 안 된다`);
}

console.log("\n[★ 이름을 안 바꿨으면 목록이 예전과 똑같다]");
{
  const t = mount();
  t.send({ t: "metas", rooms: [{ ...META, names: ["Claude"], agentIds: ["claude"], models: ["Opus 5"] }] });
  ok(t.$(".room .room-who").textContent === "Claude",
     "★ 기본값이 에이전트 이름이라 달라지는 게 없다");
}

console.log("\n[★ 이름이 그대로면 말풍선을 다시 안 만든다]");
{
  const t = open(mount());
  const node = t.$$(".msg").at(-1);
  t.send({ t: "room", room: room(both()), compactable: false });
  ok(t.$$(".msg").at(-1) === node,
     "★ **같은 노드를 그대로 쓴다** — 도장이 같으면 캐시가 살아 있어야 한다");
}

console.log("\n전부 통과");
