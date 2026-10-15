/**
 * **봇이 받는 글을 통째로 찍는다** — 읽어보려고 두는 손 (2026-10-15).
 *
 * 🔴 **왜 뽑아서 쓰나.** 오늘 하루에만 도구 설명에서 거짓말 넷이 나왔다 —
 * 권한 거절이 사용자에게 간다고 적혀 있었고, 보장 못 할 답을 약속했고,
 * 화면 낱말(«말풍선»)이 섞였고, 실려 가는 칸(`item.from`)이 빠져 있었다.
 * **넷 다 동작은 멀쩡해서** `tsc` 도 검사 83개도 아무 말을 안 했다. 눈으로
 * 읽어야 보이는 것들이라, **읽기 좋은 꼴로 뽑는 길**을 둔다.
 *
 * ⚠️ **찍은 것을 저장소에 두지 않는다** (사용자, 2026-10-15). 한때 이것을
 * `docs/TOOLS.md` 로 받아 두었는데, **참은 코드**라 그 사본은 손댈 때마다
 * 갈린다 — 갈린 순간부터 없느니만 못하다. 고칠 글이 있으면 여기 찍어 읽고,
 * 고치는 것은 `RoomManager.mcpTools()` 쪽이다.
 *
 * ```
 * npx tsx tests/probes/tooldump.mts            화면으로
 * npx tsx tests/probes/tooldump.mts > 아무데나   고쳐 볼 판이 필요하면
 * ```
 *
 * `tests/` 바로 아래에 두면 `all.mjs` 가 **검사로 알고 돌린다**(거기는
 * `.mts`·`.mjs` 를 통째로 긁는다). 그래서 손으로 돌리는 것들과 같은 칸에 둔다.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import { OUR_MCP_NAME } from "../../src/core/acpConnection.js";
import { rosterText } from "../../src/core/types.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-tools-"));
const store = new RoomStore(dir);
await store.init();
const host: WorkspaceHost = {
  readTextFile: async () => "",
  writeTextFile: async () => {},
  requestPermission: async () => ({ outcome: "cancelled" }),
  log: () => {},
  defaultCwd: () => dir,
  hasWorkspace: () => true,
};
const mgr = new RoomManager({ host, store, agents: [DEFAULT_AGENTS[0]!] });

const out: string[] = [];
const say = (s = "") => out.push(s);

say("# 봇이 받는 글");
say();
say("> **뽑은 것이다 — 참은 코드다.** `RoomManager.mcpTools()` 에서 그대로 꺼냈다.");
say("> 여기서 글을 고쳤으면 **코드로 옮긴 뒤 다시 뽑아** 맞춘다 — 두 곳이 갈리면");
say("> 이 파일은 없느니만 못하다.");
say(">");
say("> ```");
say("> npx tsx tests/probes/tooldump.mts > docs/TOOLS.md");
say("> ```");
say();
say("모델이 보는 면은 **넷**이다. 아래 순서가 곧 읽히는 순서다.");
say();
say("```");
say("① MCP 서버      세션마다 붙여 보낸다 (주소 · 비밀)");
say("② 도구 설명     **부를 때마다** 통째로 읽힌다 — 제일 비싼 자리");
say("③ 명단          방이 어떻게 생겼나 — 바뀔 때만 다시 나간다");
say("④ 깃발          매 턴 한 줄 — 지금 할 일");
say("```");
say();
say("---");
say();
say("## ① MCP 서버");
say();
say("`session/new`·`resume`·`load`·`fork` **넷 다**에 실린다 — 한 군데만 빠져도");
say("그 길로 선 세션은 조용히 도구를 잃는다.");
say();
say("```json");
say(JSON.stringify({
  type: "http",
  name: OUR_MCP_NAME,
  url: "http://127.0.0.1:<그때 포트>/mcp",
  headers: [{ name: "x-aio-secret", value: "<세션마다 다른 비밀>" }],
}, null, 2));
say("```");
say();
say("비밀이 **방:봇**을 가리킨다 — 남의 큐를 못 꺼내게 하는 뿌리고, 제 권한 요청을");
say("스스로 승인하는 길도 이것으로 막는다.");
say();
say("---");
say();
say("## ② 도구");

for (const t of mgr.mcpTools()) {
  say();
  say(`### \`${t.name}\``);
  say();
  say("```");
  say(t.description);
  say("```");
  say();
  say("```json");
  say(JSON.stringify(t.inputSchema, null, 2));
  say("```");
}

say();
say("---");
say();
say("## ②′ 돌려주는 것");
say();
say("⚠️ **MCP 의 `outputSchema` 로는 안 보낸다** — 우리 결과는 `content` 한 덩어리,");
say("곧 **JSON 글자**다. 모델은 이 모양을 **도구 설명으로만** 안다. (보내려면");
say("`structuredContent` 까지 같이 가야 하고, 세 어댑터가 그걸 모델에게 보여주는지는");
say("아직 안 쟀다.)");
say();
say("아래는 **진짜로 불러서** 받은 글이다 — 베껴 적은 것이 아니다.");
say();

/** 큐에 손으로 넣는다 — 모양을 보려는 것이라 에이전트를 안 띄운다 */
const inner = mgr as unknown as {
  queue: {
    put(item: unknown): string;
    startTurn(owner: string): number;
  };
};
const OWNER = "r1:b1";
const call = async (tool: string, args: unknown) =>
  (await mgr.mcpCall(OWNER, tool, args)).text;
/** 거절은 **글**로 간다 — `isError` 가 붙는지까지 같이 본다 */
const callErr = async (tool: string, args: unknown) => {
  const r = await mgr.mcpCall(OWNER, tool, args);
  return `${r.isError ? "isError: true" : "isError: (없음)"}\n${r.text}`;
};

say("### `check_queue` — 빈 큐");
say();
say("```json");
say(await call("check_queue", {}));
say("```");
say();
say("🔴 **빈 것도 모양이 같다** — 칸을 빼지 않고 `null` 을 넣는다. 칸이 사라지면");
say("모델은 «오류인가»를 한 번 묻게 된다.");
say();

inner.queue.put({
  kind: "message", to: "b1", from: "알파", fromId: "b0",
  text: "이 테스트 좀 봐줄래?", depth: 1, srcId: "m-1", alsoTo: ["감마"],
});
inner.queue.put({
  kind: "permission", to: "b1", from: "베타", fromId: "b2",
  title: "터미널 명령", tool: "execute", command: "rm -rf build",
  paths: [], readOnly: false,
});
inner.queue.startTurn("b1");

say("### `check_queue` — 권한이 먼저 나온다");
say();
say("```json");
say(await call("check_queue", {}));
say("```");
say();
say("★ **꺼내 봐도 안 빠진다** — 답해야 빠진다. 그래서 한 번 더 불러도 **같은 것**이");
say("나온다. 아래는 그 권한에 답한 뒤의 두 번째 호출이다.");
say();

await call("verdict", { id: "p2", allow: false, reason: "지우는 명령이라 사람이 봐야 합니다." });

say("### `check_queue` — 답하고 나면 다음이 나온다");
say();
say("```json");
say(await call("check_queue", {}));
say("```");
say();
say("⚠️ **여기 `depth_left` 가 `null` 인 것은 이 뽑기에 방이 없어서다.** 수는 릴레이가");
say("«무조건 허용»인 방에서만 실린다 — 「승인」에서는 상한이 안 걸리므로 `null` 이고");
say("(**0 과 반대다**), 숫자를 보여주면 **있지도 않은 벽**을 피해 가게 된다.");
say();
say("「끔」은 아예 물음이 안 생긴다 — `say` 가 통째로 거절되므로 **봇끼리 말이 큐에");
say("들어오지도 않는다**. 거기 남는 것은 권한 항목뿐이고, 그건 깊이와 무관하다.");
say();
say("빈 배열(`paths`)은 **빠진다** — 지키는 것은 «모델이 그때마다 읽는 칸»이고,");
say("비어 있으면 말해 줄 것이 없는 곁가지는 안 싣는다.");
say();
say("### 거절 — 모양이 안 맞을 때");
say();
say("**글로 간다**(JSON 이 아니다). 모델이 그대로 읽는 자리라, 무엇이 빠졌는지와");
say("**무엇을 하면 되는지**를 같이 적는다.");
say();
say("```");
say(await callErr("say", { text: "뭔가", id: "x1" }));
say("```");
say();
say("```");
say(await callErr("verdict", { id: "p1" }));
say("```");
say();
say("🔴 **지어내지 않는다.** `allow` 가 없다고 `false` 로 읽으면 **우리가 막은 것**이");
say("되고, `true` 로 읽으면 더 나쁘다.");
say();
say("### 보낸 뒤 — 성공한 답");
say();
say("```");
say('say     (봇에게)   {"ok":true,"to":["베타","감마"],"queue_left":0}');
say('say     (사용자)   {"ok":true,"to":null,"queue_left":0}');
say('verdict            {"ok":true,"result":"허용","queue_left":1}   (막으면 "막음")');
say("```");
say();
say("★ **답마다 `queue_left` 를 싣는다** — 답한 **직후**가 «또 꺼낼까»를 정하는");
say("자리라, 그 판단에 쓸 수를 그 자리에서 준다. (이 셋은 방과 봇이 있어야 나오므로");
say("여기서는 적어만 둔다 — 모양은 `saybot`·`judgeflow` 가 지킨다.)");
say();
say("---");
say();
say("## ③ 명단 — 바뀔 때만");
say();
say("이름·설명·구성·릴레이 토글 중 **무엇이 바뀌어도** 통째로 다시 나간다.");
say("차분을 안 보낸다 — 모델이 머릿속에서 합쳐야 하고, 틀려도 우리가 못 본다.");
say();
/* 🔴 **여기도 적어두지 않는다** — `rosterText` 를 진짜로 불러서 찍는다 */
const fakeRoom = (relay: string) => ({
  participants: [
    { id: "b1", name: "리뷰어" },
    { id: "b2", name: "구현", blurb: "코드를 쓰고 고친다" },
  ],
  relay,
}) as unknown as Parameters<typeof rosterText>[0];
const fakeMe = { id: "b1", name: "리뷰어" } as unknown as Parameters<typeof rosterText>[1];

say("```");
say(rosterText(fakeRoom("always"), fakeMe));
say("```");
say();
say("릴레이가 꺼진 방은 **빈 목록 + 왜**다 — «아무도 없는 방»과 구별되어야 한다:");
say();
say("```");
say(rosterText(fakeRoom("off"), fakeMe));
say("```");
say();
say("## ④ 깃발 — 매 턴");
say();
say("```");
say('[ai-in-one] {"say_id_0":"valid","also_to":["베타","감마"],"queue":1,"do":"check_queue"}');
say("```");
say();
say("```");
say('say_id_0   "valid" 면 이 턴에 id "0" 을 쓸 수 있다 (사용자가 연 턴)');
say("also_to    사용자의 이 말을 **같이 받은** 봇들 — 거기 적힌 봇에게는 옮기지 마라");
say("queue      기다리는 몫의 수");
say('do         할 일. 없으면 null');
say("```");
say();
say("빈 것도 **모양이 같다** — 칸이 사라지면 «빠뜨린 건가»가 생긴다.");

process.stdout.write(out.join("\n") + "\n");

mgr.dispose();
await store.flush();
await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
