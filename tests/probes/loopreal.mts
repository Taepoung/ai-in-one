/**
 * **루프모드를 진짜 에이전트로** (2026-10-20).
 *
 * 루프는 «종료» 를 **정확히 그 한 단어**일 때만 인정한다(꾸밈은 걷는다 — `saidDone`).
 * 모델이 «종료합니다» · «더 할 일이 없어 종료» 처럼 답하면 «종료» 로 안 보고 상한까지
 * 또 묻는다. 그걸 진짜 모델로 잰다.
 *
 * ```
 * ① 도구가 필요 없는 작은 일을 시킨다 («1부터 3까지 세어 줘»)
 * ② 루프모드 · 상한 3
 * ③ 루프가 다시 물을 때마다 그 답을 **원문 그대로** 찍는다
 * ④ «종료» 로 읽혔나 — 몇 번째에 멈췄나
 * ```
 *
 * 손으로 돌린다 — 에이전트마다 서너 턴이라 할당량이 조금 든다.
 *
 *   npx tsx tests/probes/loopreal.mts                셋 다
 *   npx tsx tests/probes/loopreal.mts codex          하나만
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { withInstalled } from "../../src/core/install/agentInstaller.js";
import { saidDone, LOOP_ASK } from "../../src/core/turn/loop.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = process.env.AIO_AGENT_ROOT
  ?? path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "taein-yoon.ai-in-one");
const want = process.argv.slice(2).find((a) => !a.startsWith("--"));
/*
 * 두 판이다:
 *   (기본)   «1부터 3까지 세어 줘» — 할 일이 없을 때 **멈추나**
 *   --steps  «1부터 4까지 · 한 번에 숫자 하나만» — 남은 일을 **이어 하나**
 */
const STEPS = process.argv.includes("--steps");
const CAP = STEPS ? 6 : 3;
const TASK = STEPS
  ? "1부터 4까지 세. 단, 한 번 답할 때 숫자는 하나만 말할 수 있어. 도구는 쓰지 마."
  : "1부터 3까지 세어 줘. 도구는 쓰지 마.";

async function one(agentId: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-loopreal-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const agent = withInstalled(DEFAULT_AGENTS.find((a) => a.id === agentId)!, ROOT);
  const mgr = new RoomManager({ host, store, agents: [agent], agentRoot: ROOT, configProbeMs: 90000 });
  mgr.on("roomError", (_r: string, e: string) => console.log("  roomError:", e));
  console.log(`${NL}── ${agent.label} ─────────────────`);
  try {
    const room = await mgr.createRoom({ title: "루프", agentId });
    const bot = room.participants[0]!;
    await mgr.setLoopCap(room.id, CAP);
    await mgr.setPolicy(room.id, { answerPolicy: "auto" }, bot.id);
    const t0 = Date.now();
    await mgr.send(room.id, TASK);
    // 루프가 끝날 때까지 — 끝났다는 줄이 서거나 시간이 다 될 때까지
    for (let i = 0; i < 2400; i++) {
      if (room.messages.some((m) => m.role === "system" && /모두 «종료»|번 다시 물어 멈췄습니다/.test(m.text))) break;
      await nap(100);
    }
    const asks = room.messages.filter((m) => m.role === "system" && /루프 — .*다시 물었습니다/.test(m.text));
    // 다시 물은 줄 뒤에 온 봇의 첫 답 = 그 물음의 답
    const answers: string[] = [];
    for (const a of asks) {
      const at = room.messages.indexOf(a);
      const reply = room.messages.slice(at + 1).find((m) => m.role === "agent" && m.authorBotId === bot.id);
      answers.push(reply?.text ?? "(답 없음)");
    }
    const first = room.messages.find((m) => m.role === "agent")?.text ?? "";
    console.log(`  첫 답   : ${JSON.stringify(first.slice(0, 80))}`);
    answers.forEach((a, i) => console.log(`  ${i + 1}번째 물음의 답: ${JSON.stringify(a.slice(0, 80))}  → ${saidDone(a) ? "«종료» 로 읽음" : "종료 아님"}`));
    const end = room.messages.filter((m) => m.role === "system" && /모두 «종료»|멈췄습니다/.test(m.text)).at(-1)?.text;
    console.log(`  끝      : ${end ?? "(안 끝남)"} · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
    const ok = answers.length > 0 && saidDone(answers.at(-1)!);
    console.log(`  ${ok ? "OK" : "NO"} - ${ok ? `${answers.length}번째에 «종료» 로 끝났다` : "«종료» 로 안 끝났다 — 판정을 볼 것"}`);
    await mgr.leaveRoom(room.id).catch(() => undefined);
  } catch (e) {
    console.log("  실패:", (e as Error).message);
  } finally {
    mgr.dispose();
    await nap(500);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

console.log(`묻는 말: ${LOOP_ASK}`);
for (const id of ["claude", "codex", "antigravity"]) {
  if (want && want !== id) continue;
  await one(id);
}
process.exit(0);
