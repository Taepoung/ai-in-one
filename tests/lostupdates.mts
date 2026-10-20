/**
 * **`translate()` 가 버리는 소식** (2026-10-09).
 *
 * ACP `session/update` 는 **열다섯 종류**인데 우리는 여덟만 다루고 나머지는
 * `default: return []` 로 **조용히 버린다**(`acpConnection.ts`).
 *
 * 그런데 §0 P5 에는 *"조용히 `return []` 하지 않는다 — 로그에 남겨"* 가,
 * ROADMAP 에는 *"계획 … 말풍선 아래 그대로"* 가 **지킨 방법**으로 적혀 있다.
 * 코드가 문서와 다르다.
 *
 * 🔴 **왜 여태 아무도 안 터졌나**: 검사 64개 중 **어느 것도 이 자리를 안
 * 건드린다** — 없어서가 아니라 **가짜 에이전트가 그 소식을 안 보내서**다.
 * 그래서 고치는 순서가 거꾸로다: **보내는 쪽부터** 고치고, 깨지는 것을 본 다음
 * 받는 쪽을 고친다.
 *
 * 계획은 특히 이상한 꼴이었다 — **선언**(`AgentEvent`)도 **소비**(`applyEvent`)도
 * **렌더**(`planNode`)도 다 있는데 **중간만 비어** 있었다. 지나가는 길이 없는
 * 코드가 셋이나 멀쩡히 서 있었던 것이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-lost-"));
  const store = new RoomStore(dir); await store.init();
  const logs: string[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: (m) => { logs.push(m); }, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
    }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const room = await mgr.createRoom({ agentId: "fake", title: "버려지는 것들" });
  const settle = async () => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);
  };
  const lastReply = () => room.messages.filter((m) => m.role === "agent").at(-1)!;

  console.log("\n[★ ① 계획 — 항목형]");
  {
    await mgr.send(room.id, "[[plan]] 계획을 세워줘");
    await settle();
    const plan = lastReply().plan;
    console.log(`   plan: ${JSON.stringify(plan)}`);
    ok(plan !== undefined, "★ 계획이 말풍선에 붙었다");
    ok((plan?.entries?.length ?? 0) === 3, "항목 셋이 다 왔다");
    // **상태를 지켜야 체크리스트가 그려진다** — 셋이 다 pending 이면 그림이 거짓이다
    ok(plan?.entries?.[0]?.status === "completed", "끝난 항목이 끝난 것으로 온다");
    ok(plan?.entries?.[1]?.status === "in_progress", "도는 항목이 도는 것으로 온다");
    ok(plan?.entries?.[0]?.text === "먼저 읽는다", "항목 글이 그대로 온다");
  }

  console.log("\n[★ ② 계획 — 마크다운 (UNSTABLE plan_update)]");
  {
    await mgr.send(room.id, "[[planmd]] 계획을 글로 줘");
    await settle();
    const plan = lastReply().plan;
    console.log(`   markdown: ${JSON.stringify(plan?.markdown)}`);
    ok((plan?.markdown ?? "").includes("할 일"), "★ 마크다운 계획이 왔다");
  }

  console.log("\n[★ ③ plan_removed — 계획을 거둔다]");
  {
    // 같은 턴에서 세웠다 거둔다. **거두는 소식이 버려지면 계획이 그대로 남는다** —
    // 그게 이 검사가 가르는 자리다.
    await mgr.send(room.id, "[[plan]] 세웠다가 [[planrm]] 거둬줘");
    await settle();
    const plan = lastReply().plan;
    console.log(`   plan: ${JSON.stringify(plan)}`);
    ok(plan === undefined, "★ 거둔 계획은 말풍선에서 사라진다");
  }

  console.log("\n[★ ④ 모르는 종류 — 조용히 버리지 않는다 (§0 P5)]");
  {
    logs.length = 0;
    await mgr.send(room.id, "[[weird]] 이상한 걸 보내봐");
    await settle();
    const hit = logs.filter((l) => l.includes("nonsense_update"));
    console.log(`   로그 ${logs.length}줄 중 ${hit.length}줄: ${JSON.stringify(hit[0] ?? "")}`);
    ok(hit.length > 0, "★ 모르는 업데이트가 로그에 남는다");
  }

  console.log("\n[★ ⑤ 계획을 파일로 주면 — 못 읽지만 알린다]");
  {
    logs.length = 0;
    await mgr.send(room.id, "[[planfile]] 계획은 파일에 있어");
    await settle();
    const hit = logs.filter((l) => l.includes("plan_update") || l.includes("file"));
    console.log(`   ${JSON.stringify(hit[0] ?? "(없다)")}`);
    ok(hit.length > 0, "★ 우리가 못 읽는 계획 꼴도 자국을 남긴다");
  }

  console.log("\n[★ ⑥ 에이전트가 스스로 모드를 바꿨다]");
  {
    await mgr.send(room.id, "[[mode:plan]] 계획 모드로 가자");
    await settle();
    const bot = room.participants[0]!;
    console.log(`   agentMode: ${JSON.stringify(bot.agentMode)}`);
    ok(bot.agentMode === "plan", "★ 바뀐 모드가 봇에 적힌다");
  }

  console.log("\n[★ ⑦ 우리가 안 시킨 설정 변경]");
  {
    await mgr.send(room.id, "[[cfg:sonnet]] 모델을 바꿨어");
    await settle();
    const bot = room.participants[0]!;
    console.log(`   model: ${JSON.stringify(bot.model)} · configValues.model: ${JSON.stringify(bot.configValues?.model)}`);
    ok(bot.configValues?.model === "sonnet", "★ 에이전트가 바꾼 설정이 반영된다");
  }

  console.log("\n[★ ⑧ session_info_update — Codex 가 실제로 보낸다]");
  {
    logs.length = 0;
    const was = room.title;
    await mgr.send(room.id, "[[info:에이전트가 지은 제목]] 제목을 지어봐");
    await settle();
    console.log(`   방 제목: ${JSON.stringify(room.title)} · 로그 ${logs.length}줄`);
    // **방 제목은 사용자 것**이다. 봇이 여럿인 방에서 서로 덮어쓰면 안 된다.
    ok(room.title === was, "★ 에이전트가 방 제목을 바꾸지 않는다");
    ok(logs.some((l) => l.includes("session_info_update")), "그래도 자국은 남는다");
  }

  mgr.dispose();
  // 프로세스가 폴더를 아직 쥐고 있을 수 있다 — 못 지워도 `all.mjs` 가 쓸어간다
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log("\n통과");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
