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
import { fileURLToPath } from "node:url";
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

/*
 * ★ **방이 있어야 나오는 답은 진짜 방에서 받는다** (사용자, 2026-10-15):
 * *"MCP관련 모든 입력 출력 정리를 ... 전수조사하게"*.
 *
 * 🔴 적어두면 **갈린다.** 성공한 답·방이 필요한 거절은 한때 손으로 적어
 * 두었는데, 그 줄들은 코드가 바뀌어도 아무 말을 안 한다. 가짜 에이전트를
 * 띄우는 값(프로세스 셋)을 치르더라도 **받아서 찍는** 편이 낫다.
 */
const fakeBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fakeagent.cjs");
const liveBase = {
  ...DEFAULT_AGENTS[0]!, command: "node", args: [fakeBin],
  env: { AIO_FAKE_HOLD: "0", AIO_FAKE_STATE: path.join(dir, "fake.log"), AIO_FAKE_ECHO: "1" },
};
const live = new RoomManager({
  host: { ...host, requestPermission: async () => ({ outcome: "cancelled" }) },
  store, configProbeMs: 20000,
  agents: [
    { ...liveBase, id: "alpha", label: "알파" },
    { ...liveBase, id: "beta", label: "베타" },
    { ...liveBase, id: "gamma", label: "감마" },
  ],
});
live.on("roomError", () => {}); live.on("notice", () => {});
const liveRoom = await live.createRoom({
  title: "전수조사", bots: [{ agentId: "alpha" }, { agentId: "beta" }, { agentId: "gamma" }],
});
const [LA, LB, LC] = liveRoom.participants as Array<{ id: string; name: string }>;
const liveInner = live as unknown as {
  botRuntime(r: string, b: string): { depth?: number; fromUser?: boolean };
  queue: { put(item: unknown): string };
};
/** 그 봇 몫에 **답할 거리** 하나를 깔아둔다 — 사용자에게 하는 say 는 id 가 든다 */
const plant = (bot: { id: string }, text: string) => liveInner.queue.put({
  kind: "message", to: bot.id, from: "알파", fromId: LA!.id,
  text, depth: 1, srcId: "m-live", alsoTo: [],
});
/** 그 봇을 **사용자가 연 턴**에 세운다 — `id: null` 이 유효해지는 자리 */
const standUser = (bot: { id: string }) => {
  const bt = liveInner.botRuntime(liveRoom.id, bot.id);
  bt.depth = 0; bt.fromUser = true;
};
/** 진짜로 불러서 **한 줄로** 받아온다 */
const hit = async (tool: string, args: unknown, who = LA!) =>
  (await live.mcpCall(`${liveRoom.id}:${who.id}`, tool, args)).text;

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
say("## ⓪ 전수표 — **오가는 것 전부**");
say();
say("| 방향 | 무엇 | 언제 | 칸 |");
say("| --- | --- | --- | --- |");
say("| 우리 → 모델 | MCP 서버 항목 | 세션을 열 때 **한 번** | 이름 `ai-in-one` · 주소 · 비밀 |");
say("| 우리 → 모델 | 도구 설명 셋 | **부를 때마다** | `say` · `verdict` · `check_queue` (설명 + 입력 스키마) |");
say("| 우리 → 모델 | 명단 한 줄 | 방이 바뀔 때만 | `[ai-in-one] {you, bots, user, relay?}` |");
say("| 우리 → 모델 | 깃발 한 줄 | **매 턴** | `[ai-in-one] {null_id, also_to?, queue_left, do}` |");
say("| 모델 → 우리 | `say` | 봇이 부를 때 | `to`(리스트 또는 null) · `text` · `id`(문자열 또는 null) |");
say("| 모델 → 우리 | `verdict` | 봇이 부를 때 | `id`(문자열) · `allow`(참/거짓) · `reason`(글, 없어도 됨) |");
say("| 모델 → 우리 | `check_queue` | 봇이 부를 때 | 인자 없음 |");
say("| 우리 → 모델 | `say` 의 답 | 부른 직후 | 성공 **4갈래** / 거절은 아래 표 |");
say("| 우리 → 모델 | `verdict` 의 답 | 부른 직후 | 성공 **2갈래**(허용·막음) / 거절은 아래 표 |");
say("| 우리 → 모델 | `check_queue` 의 답 | 부른 직후 | 메세지 / 권한 / 빈 큐 — **셋 다 칸이 같다** |");
say();
say("🔴 **비싼 자리는 ②뿐이다.** 설명은 **부를 때마다** 통째로 읽히고, 명단은");
say("바뀔 때만, 깃발은 한 줄이다. 그래서 길게 쓸 말은 ③④ 로 내리고 ② 는 줄인다.");
say();
say("⚠️ **`outputSchema` 는 안 쓴다** — 돌려주는 것은 `content` 한 덩어리(JSON");
say("글자)다. 그래서 **답의 모양을 모델이 아는 길은 설명뿐**이고, 이 문서가");
say("그 설명과 어긋나면 모델이 틀린 모양을 믿는다.");
say();
say("### 입력 — 우리가 받는 칸");
say();
say("| 도구 | 칸 | 타입 | 필수 | 빠지거나 틀리면 |");
say("| --- | --- | --- | --- | --- |");
say("| `say` | `to` | `string[]` 또는 `null` | ✔ | `to is unvalid form(list or null)` |");
say("| `say` | `text` | `string` (공백만이면 빈 것) | ✔ | `text is empty` |");
say("| `say` | `id` | `string` 또는 `null` | ✔ | `id is not valid (valid id or null)` |");
say("| `verdict` | `id` | `string` | ✔ | `id is not valid (string)` |");
say("| `verdict` | `allow` | `boolean` | ✔ | `allow is not valid (boolean)` |");
say("| `verdict` | `reason` | `string` | ✘ | **조용히 빈 글**이 된다 — 거절하지 않는다 |");
say("| `check_queue` | — | — | — | 인자를 줘도 **무시한다** |");
say();
say("★ **문자열 하나도 받는다** — `to: \"베타\"` 는 `[\"베타\"]` 로 읽는다. 모델이");
say("흔히 그렇게 쓰는데, 거절해 봐야 왕복만 는다.");
say();
say("★ **`to` 의 `user` 는 사용자다.** 봇 이름으로는 못 쓰는 이름이라 안 갈린다.");
say("다른 봇과 같이 적으면 그 봇에게 보내고 **칩만** 하나 더 단다.");
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
/**
 * 거절을 **진짜로 받아** 온다.
 *
 * 🔴 깃발(`isError`)이 안 붙으면 **여기서 터뜨린다** — 본문만 거절이고 봉투는
 * 멀쩡하면, 문서는 맞는데 모델은 오류로 안 읽는 어긋남이 생긴다.
 */
const callErr = async (tool: string, args: unknown) => {
  const r = await mgr.mcpCall(OWNER, tool, args);
  if (!r.isError) throw new Error(`깃발이 없다: ${tool} → ${r.text}`);
  return r.text;
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
say("### 거절 — 한 모양이다");
say();
say("**무엇이 틀렸든 봉투가 같다** — 본문은 JSON, 깃발도 `isError` 다.");
say();
say("```");
say("{\"isError\": true, \"reason\": \"<한 마디>\", …고를 거리}");
say("```");
say();
say("예전에는 둘이었다(호출 모양이 틀리면 맨글, 규칙이 막으면 `{\"ok\":false}`).");
say("모델이 읽는 규칙이 둘이면 **수습법도 둘**이 되고 둘 중 하나는 덜 배운다.");
say();
say("가르는 선은 이제 **무엇이 틀렸나**가 아니라 **뒤에 뭐가 붙나**다 —");
say("`can_call`·`queue_left`·`items` 는 **고를 거리**이므로, 고를 것이 있을 때만 붙는다.");
say();
say("🔴 **`reason` 은 정해진 한 마디다.** 사람이 읽는 설명이 아니라 **갈래 이름**이라,");
say("모델은 글을 뜯지 않고 **같은지만 본다.** 대신 «그래서 뭘 하나» 는 글이 아니라");
say("같이 오는 칸이 진다.");
say();
say("#### 진짜로 불러서 받은 것");
say();
for (const [what, tool, args] of [
  ["say — `to` 가 없다", "say", { text: "뭔가", id: "x1" }],
  ["say — `text` 가 비었다", "say", { to: ["알파"], text: "  ", id: "x1" }],
  ["say — `id` 가 없다", "say", { to: ["알파"], text: "뭔가" }],
  ["verdict — `id` 가 문자열이 아니다", "verdict", { id: 1, allow: true }],
  ["verdict — `allow` 가 없다", "verdict", { id: "p1" }],
  ["모르는 도구", "없는_도구", {}],
] as Array<[string, string, unknown]>) {
  say("**" + what + "**");
  say();
  say("```json");
  say(await callErr(tool, args));
  say("```");
  say();
}
say("🔴 **지어내지 않는다.** `allow` 가 없다고 `false` 로 읽으면 **우리가 막은 것**이");
say("되고, `true` 로 읽으면 더 나쁘다. 그래서 칸마다 따로 답한다.");
say();
say("★ **오류가 아니라 결과다** — 모델이 읽고 다른 길을 찾는다. 모르는 도구까지");
say("같은 봉투로 돌아오므로, 모델이 갈래를 더 배울 일이 없다.");
say();
say("#### 거절 하나하나 — **언제 나오고, 뭐가 같이 오나**");
say();
say("| 도구 | `reason` | 언제 | 같이 오는 칸 | 고칠 길 |");
say("| --- | --- | --- | --- | --- |");
say("| say | `to is unvalid form(list or null)` | `to` 가 빠졌거나 리스트도 `null` 도 아니다 | — | 칸을 채워 다시 부른다 |");
say("| say | `text is empty` | `text` 가 없거나 공백뿐이다 | — | 할 말을 적는다 |");
say("| say | `id is not valid (valid id or null)` | `id` 칸 자체가 없다 (뜻한 `null` 은 통과) | — | 큐의 id, 아니면 `null` |");
say("| say | `cannot say to user on user turn` | **사용자가 연 턴**에 사용자에게 걸었다 | — | 그 턴의 **산문**으로 쓴다 |");
say("| say | `id null is only for user turn` | **깨어난 턴**에서 `id:null` 을 줬다 | `can_call`·`queue_left` | `check_queue` 가 준 id 를 쓴다 |");
say("| say | `permission item: use verdict` | 집은 id 가 **권한 요청**이었다 | — | 같은 id 로 `verdict` |");
say("| say | `ambiguous name` | 그 이름의 봇이 방에 둘이다 | `can_call`·`queue_left` | 이름을 바꿔야 부를 수 있다 |");
say("| say | `unknown name` | `to` 의 이름이 방에 없다 | `can_call`·`queue_left` | 목록에서 고른다 |");
say("| say | `cannot say to self` | 자기 이름을 `to` 에 넣었다 | `can_call`·`queue_left` | 다른 대상을 고른다 |");
say("| say | `duplicated sending error` | **이 턴에 그 봇에게 이미** 보냈다 (`id:null` 일 때만) | `can_call`·`queue_left` | 다른 봇에게 걸거나 턴을 끝낸다 |");
say("| say | `relay is off` | 방이 **봇끼리 부르기 끔**이다 | `can_call`·`queue_left` | 🔴 **사용자에게** 말한다 |");
say("| say | `max depths error` | 「무조건 허용」에서 **깊이 상한**을 넘었다 | `can_call`·`queue_left` | 🔴 **사용자에게** 말한다 |");
say("| say | `user denied` | 「물어봄」에서 **사용자가 카드를 막았다** | `can_call`·`queue_left` | 🔴 **사용자에게** 말한다 |");
say("| say | `left the room` | 승인을 기다리는 사이에 받을 봇이 **나갔다** | `can_call`·`queue_left` | 남은 사람을 고른다 |");
say("| 둘 다 | `id error` | 그 id 가 **내 큐에 없다** | `items`·`queue_left` | 실려 온 `items` 에서 고른다 |");
say("| 둘 다 | `already handled` | 그 id 는 **이미 답이 났다** | `queue_left` | 🔴 **아무것도 안 해도 된다** |");
say("| verdict | `id is not valid (string)` | `id` 가 문자열이 아니다 | — | 칸을 채워 다시 부른다 |");
say("| verdict | `allow is not valid (boolean)` | `allow` 가 참/거짓이 아니다 | — | 🔴 **지어내지 않는다** |");
say("| 아무때 | `unvalid tool` | 그런 이름의 도구가 없다 | — | 세 도구 중에서 고른다 |");
say("| 아무때 | `room is closed` / `room is not open` | 방이 닫혔다 / 지금 열려 있지 않다 | — | **이 턴에 더 할 것이 없다** |");
say("| 아무때 | `not a participant` | 그 방의 참여자가 아니다 | — | **이 턴에 더 할 것이 없다** |");
say();
say("**`items` 는 `id error` 에만 붙는다.** 틀린 까닭이 «엉뚱한 id» 일 때는 **지금");
say("들고 있는 것을 통째로 다시 실어준다** — `check_queue` 로 되묻는 왕복이 통째로");
say("준다. 나머지 거절은 id 가 맞았으므로 다시 보여줄 것이 없다.");
say();
say("**`can_call` 은 `say` 의 규칙 거절에만 붙는다.** 호출 모양이 틀린 것(`to`·`text`·");
say("`id` 칸)은 **방을 보기 전에** 걸러지므로 목록을 만들 자리가 없고, 만들어줘 봐야");
say("고칠 곳은 제 호출이지 상대가 아니다.");
say();
say("⚠️ **한 `reason` 이 두 자리에서 나온다.** `id null is only for user turn` 은");
say("사용자에게 걸 때와 봇에게 걸 때 둘 다, `already handled` 는 `say`·`verdict`");
say("양쪽에서 나온다. 모델에게는 같은 한 마디라 상관없지만, **고칠 때 두 곳을 고쳐야");
say("한다** — 한 자리로 모을 거리다.");
say();
say("⚠️ **짧아지면서 «대신 뭘 할지» 가 글에서 사라졌다.** `items`·`can_call` 이 받는");
say("것은 괜찮은데, **`relay is off`·`max depths error`·`user denied`** 셋은 받을");
say("칸이 없다 — 옛 글에 있던 «사용자에게 말하라» 와 깊이 상한의 수가 통째로 빠졌다.");
say("표의 🔴 가 그 자리다. 이 셋만은 한 마디로 안 되는지 다시 볼 값이 있다.");
say();
say("⚠️ **표의 «고칠 길» 칸은 모델에게 안 간다.** 여기 적힌 것은 우리가 읽는");
say("것이고, 봇이 받는 것은 왼쪽 한 마디와 같이 오는 칸뿐이다 — 둘을 섞어");
say("읽으면 «말해줬다» 고 착각하게 된다.");
say();
say("#### 방이 있어야 나오는 거절 — **진짜 방에서 받았다**");
say();
say("```json");
standUser(LA!);
say(await hit("say", { to: ["알파"], text: "혼잣말", id: null }));
say(await hit("say", { to: ["델타"], text: "없는 봇", id: null }));
say(await hit("say", { to: [], text: "아무도", id: null }));
// 🔴 **`to: []` 는 여기서 멈춘다** — 뒤에는 이 길을 받는 문지기가 없다
say(await hit("say", { to: ["베타"], text: "답인 척", id: "x9" }));
say("```");
say();
say("★ **`id error` 에만 `items` 가 붙는다** — 틀린 것이 «id» 일 때만 다시 보여줄");
say("것이 있다. 지금은 큐가 비어 빈 목록이지만, 들고 있으면 통째로 실린다.");
say();
say("```json");
await live.setRelay(liveRoom.id, "off");
say(await hit("say", { to: ["베타"], text: "들려?", id: null }));
await live.setRelay(liveRoom.id, "always");
say("```");
say();
say("### 보낸 뒤 — 성공한 답");
say();
say("`say` 는 **네 갈래**다. 넷 다 `to` 에 `user` 가 선다 — 모든 말이 사용자에게");
say("보이므로, 답이 그걸 말해주면 봇이 «또 알려야 하나»를 안 묻는다.");
say();
say("```json");
standUser(LA!);
say("봇에게       " + await hit("say", { to: [LC!.name], text: "봇에게", id: null }));
standUser(LA!);
say("봇 + 사용자  " + await hit("say", { to: [LB!.name, "user"], text: "둘 다", id: null }));
const mine = plant(LB!, "이거 좀 봐줄래?");
say("사용자에게   " + await hit("say", { to: ["user"], text: "제 일이 아닙니다", id: mine }, LB!));
const toss = plant(LB!, "이것도");
say("버린다       " + await hit("say", { to: null, text: "읽었습니다", id: toss }, LB!));
say("```");
say();
say("★ **«버린다»(`to: null`)도 사용자에게는 간다** — 돌려주는 답이 `[\"user\"]` 로");
say("같다. 갈리는 것은 화면 쪽이다(접혀 선다).");
say();
say("```");
say('verdict   {"ok":true,"result":"허용","queue_left":1}   (막으면 "막음")');
say("```");
say();
say("⚠️ **`verdict` 의 성공만은 적어둔 것이다** — 진짜 권한 카드가 떠야 나오므로");
say("여기서 못 만든다. 모양은 `judgeflow` 가 지킨다.");
say();
say("★ **답마다 `queue_left` 를 싣는다** — 답한 **직후**가 «또 꺼낼까»를 정하는");
say("자리라, 그 판단에 쓸 수를 그 자리에서 준다.");
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
say('[ai-in-one] {"null_id":"valid","also_to":["베타","감마"],"queue_left":1,"do":"check_queue"}');
say("```");
say();
say("```");
say('null_id    "valid" 면 `id: null`을 쓸 수 있다');
say("also_to    사용자의 이 말을 **같이 받은** 봇들 (사용자 말이 있을 경우에만 존재)");
say("queue_left 큐 내부 객체의 수");
say('do         할 일. 없으면 null');
say("```");
say();
say("빈 것도 **모양이 같다** — 칸이 사라지면 «빠뜨린 건가»가 생긴다.");

process.stdout.write(out.join("\n") + "\n");

mgr.dispose();
live.dispose();
await store.flush();
await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
