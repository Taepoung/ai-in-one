/**
 * **Antigravity 가 §4 의 도구 셋을 제대로 쓰나** — 진짜 CLI + 우리 코드 (2026-10-12).
 *
 * ⏪ `mcpagy.cjs`(2026-10-08)는 **도구 하나를 부르나**를 쟀다. 그때는 §4 가
 * 없어서 도구도 흉내였고, ACP 를 손으로 말했다. 그 뒤에 지은 것들이 **아무도
 * 안 밟은 칸**에 있다:
 *
 * ```
 * ① 인자 셋     say(to, text, id) — 인자 없는 check_queue 와 다른 질문이다
 * ② 명단 표     마크다운 표를 읽고 **이름을 골라** 부르나
 * ③ 깨우기      «ai-in-one: 큐에 1개» 한 줄만 받고 check_queue 를 부르나
 * ④ 가닥        받은 id 를 say 에 **그대로 돌려주나** (안 돌려주면 답이 아니다)
 * ```
 *
 * 띄우는 것은 **설치된 것 그대로**다 — 217MB 를 다시 받지 않는다.
 * 상대 봇은 가짜라 할당량은 Antigravity 쪽만 든다.
 *
 *   npx tsx tests/probes/agysay.mts
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { McpServer } from "../../src/core/mcpServer.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const ok = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };

/** 설치된 Antigravity — 받지 않고 그대로 띄운다 */
function agyExe(): string {
  const p = path.join(
    process.env.APPDATA ?? "", "Code", "User", "globalStorage",
    "taein-yoon.ai-in-one", "agents", "antigravity", "agy_acp_server.exe",
  );
  if (!existsSync(p)) { console.log("설치된 Antigravity 가 없다:", p); process.exit(1); }
  return p;
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-agysay-"));
  const store = new RoomStore(dir); await store.init();

  /**
   * 사람에게 간 승인.
   *
   * 🔴 **우리 도구 것만 센다.** 깨어난 봇이 **제 일로** 묻는 것은 별개고,
   * 실제로 그런 일이 있었다 — 2026-10-12 판에서 Antigravity 가 깨어나자마자
   * 작업 폴더를 `Get-ChildItem -Recurse` 로 훑으려 했다. 통째로 세면 «우리
   * 도구가 사람을 깨웠다» 로 잘못 읽힌다.
   */
  const asked: string[] = [];
  const askedOurs: string[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async (req) => {
      asked.push(req.title);
      if (req.mcp?.server === "ai-in-one") askedOurs.push(req.title);
      console.log(`  ★ 사람에게 물었다: ${req.title}`);
      return { outcome: "cancelled" };
    },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };

  const agy = DEFAULT_AGENTS.find((a) => a.id === "antigravity")!;
  const mcp = new McpServer({ log: () => {} });
  const mgr = new RoomManager({
    host, store, mcp, configProbeMs: 90000,
    agents: [
      { ...agy, command: agyExe(), args: [] },
      {
        ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
        command: "node", args: [path.join(here, "..", "fakeagent.cjs")],
        env: { AIO_FAKE_HOLD: "40" },
      },
    ],
  });
  mgr.on("roomError", (_r: string, e: string) => console.log("  roomError:", e));
  mgr.on("notice", (_r: string, m: string) => console.log("  notice:", m));

  /** 저쪽이 우리 도구를 부를 때마다 그대로 찍는다 — 인자가 핵심이다 */
  const calls: Array<{ tool: string; args: unknown }> = [];
  mcp.setHandlers(mgr.mcpTools(), async (owner, tool, args) => {
    calls.push({ tool, args });
    console.log(`  ★ tools/call  ${tool}(${JSON.stringify(args)})`);
    const out = await mgr.mcpCall(owner, tool, args);
    console.log(`       → ${out.text.slice(0, 200)}`);
    return out;
  });

  const at = await mgr.startMcp();
  console.log(`  MCP: ${JSON.stringify(at)}`);
  if (at.at !== "ready") { console.log("🔴 서버가 안 섰다"); process.exit(1); }

  const room = await mgr.createRoom({
    title: "말 걸기",
    bots: [
      { agentId: "fake", name: "구현", blurb: "코드를 쓰고 고친다" },
      { agentId: "antigravity", name: "리뷰어", blurb: "코드를 보고 문제를 찾는다" },
    ],
  });
  // 상한·승인은 이 프로브의 관심이 아니다 — 저쪽이 도구를 어떻게 쓰나만 본다
  room.relay = "always";
  const impl = room.participants[0]!;
  const judge = room.participants[1]!;

  /*
   * 구현이 리뷰어에게 말을 건다 — **제품 경로 그대로**다.
   * relaySay → 큐에 넣기 → 말풍선 → maybeWake → 진짜 Antigravity 에게 프롬프트.
   */
  console.log(`${NL}── 구현 → 리뷰어 ─────────────`);
  /*
   * 구현은 가짜라 **사용자가 연 턴**을 손으로 세워준다 — 진짜로는 `runQueue`
   * 가 박는 값이다. 새로 거는 말(`id: null`)은 그 턴에서만 통한다.
   *
   * ⏪ 여기가 `id: "0"` 이었다(2026-10-20 에 고침). 새로 거는 말이 `id: null` 로 바뀐
   * 뒤로 `"0"` 은 `id error` 로 떨어져 **리뷰어 큐에 아무것도 안 들어갔고**, 그래서
   * Antigravity 는 깨어날 일이 없었다 — 6 개 중 4 개가 그 하나로 줄줄이 빨갰다.
   */
  (mgr as unknown as { runtimes: { bot(r: string, b: string): { depth?: number; fromUser?: boolean } } })
    .runtimes.bot(room.id, impl.id).fromUser = true;
  const sent = await mgr.mcpCall(`${room.id}:${impl.id}`, "say", {
    to: ["리뷰어"],
    text: "로그인 핸들러에서 토큰 만료를 안 보고 있는 것 같은데, 맞아?",
    id: null,
  });
  console.log(`  say 결과: ${sent.text}`);
  if (sent.isError) { console.log("🔴 첫 say 가 거절됐다 — 리뷰어가 깨어날 거리가 없다"); process.exit(1); }
  /*
   * 🔴 **번호는 지금 집어야 한다.** `say` 는 번호를 안 돌려주고(보낸 쪽이 쓸
   * 데가 없어서), 저쪽이 **반응하면 그 항목은 큐에서 사라진다** — 끝나고 집으면
   * 언제나 `undefined` 다. 2026-10-13 에 그래서 한 번 헛돌았다.
   */
  const myId = (mgr as unknown as {
    queue: { pending(id: string): Array<{ id: string }> };
  }).queue.pending(judge.id).at(-1)?.id;
  console.log(`  리뷰어 큐에 들어간 번호: ${myId}`);

  console.log(`${NL}── 리뷰어(Antigravity)가 깨어난다 ─────────────`);
  for (let i = 0; i < 2400; i++) {
    if (i > 40 && ["idle", "error"].includes(mgr.statusOf(room.id))) break;
    await nap(25);
  }
  await nap(1500);

  // ── 무엇이 나갔나 ────────────────────────────────────────────
  const prompts = room.messages.filter((m) => m.role === "agent" && m.authorBotId === judge.id);
  /** 저쪽이 보낸 `to` — 목록이 와야 맞지만 **글자 하나로 와도 받아준다** */
  const toNames = (a: { to?: unknown }): string[] =>
    typeof a.to === "string" ? [a.to] : Array.isArray(a.to) ? a.to.map(String) : [];
  const back = calls.filter((c) => c.tool === "say").map((c) => c.args as { to?: unknown; id?: string });


  console.log(`${NL}── 결과 ──────────────────────`);
  console.log(`  도구 호출       : ${calls.map((c) => c.tool).join(" · ") || "(없음)"}`);
  console.log(`  리뷰어 말풍선    : ${prompts.length}개`);
  for (const p of prompts) console.log(`      ${JSON.stringify(p.text.slice(0, 160))}`);

  const results = [
    ok(calls.some((c) => c.tool === "check_queue"),
       '★ ③ `{"do":"check_queue"}` 만 받고 **그대로 한다**'),
    ok(back.length > 0, "★ ① **say 를 부른다** — 인자 셋을 채워서"),
    ok(back.some((a) => toNames(a).includes("구현")),
       `★ ② **JSON 명단에서 이름을 골랐다** (to=${JSON.stringify(back.map((a) => a.to))})`),
    ok(back.every((a) => Array.isArray(a.to)),
       "★ ②-2 **to 를 목록으로 준다** — 글자 하나로 와도 받지만, 스키마대로 오나"),
    ok(back.some((a) => a.id === myId),
       `★ ④ **받은 id 를 그대로 돌려준다** (${myId} ← ${JSON.stringify(back.map((a) => a.id))})`),
    ok(askedOurs.length === 0,
       `★ **우리 도구로는 사람을 안 깨운다** (우리 것 ${askedOurs.length}건 / 통째 ${asked.length}건)`),
  ];
  if (asked.length > askedOurs.length) {
    console.log(`${NL}  ⚠️ 제 일로 물은 것 ${asked.length - askedOurs.length}건 — 깨어난 봇이 ` +
      `시키지도 않은 탐색을 한다는 뜻이다:`);
    for (const t of asked) console.log(`      ${t.slice(0, 120)}`);
  }

  await mgr.leaveRoom(room.id).catch(() => undefined);
  mcp.close();
  mgr.dispose();
  await nap(500);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`${NL}  ${results.filter(Boolean).length}/${results.length}`);
  process.exit(0);
}

void main().catch((e: unknown) => { console.error("실패:", e); process.exit(1); });
