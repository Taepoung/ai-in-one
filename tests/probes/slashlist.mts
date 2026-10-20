/**
 * **에이전트마다 어떤 슬래시 명령을 광고하나** — 안 재본 칸 (2026-10-19).
 *
 * 🔴 **적어둔 데가 없었다.** `available_commands_update` 를 받아서 봇마다
 * 들고는 있는데([roomManager] `BotRuntime.commands`), 쓰는 것은 압축 하나뿐이라
 * (`compactCommand` 의 `/^(compact|compress)$/i`) **나머지에 뭐가 있는지 아무도
 * 안 봤다.** 입력창 `/` 자동완성을 짓기 전에 **무엇을 다루게 되는지**부터 안다.
 *
 * 세 가지를 본다:
 *   ① 이름이 뭐가 오나 — 셋이 겹치는 게 있나
 *   ② **언제** 오나 — 세션을 열자마자인가, 첫 턴이 지나야인가
 *   ③ 압축 이름이 어댑터마다 다른가 (`compact` 말고 다른 낱말을 쓰나)
 *
 * ★ **기본은 프롬프트를 안 보낸다.** 목록은 세션이 열리면서 오는 것이라 턴이
 * 필요 없다 — 사용자의 구독 토큰을 쓰지 않는다(§0 P3).
 *
 * ⚠️ `--turn` 을 주면 **빈손일 때만** 짧은 턴을 한 번 보내고 다시 본다.
 * «세션만으로는 안 오지만 턴 뒤에는 오는가» 를 가르는 자리라, 그 한 줄을
 * 모르면 «이 어댑터는 슬래시가 없다» 와 «아직 안 왔다» 가 안 갈린다.
 * 토큰을 쓰므로 **손으로 줄 때만** 간다.
 *
 * ```
 * npx tsx tests/probes/slashlist.mts
 * npx tsx tests/probes/slashlist.mts claude          한 놈만
 * npx tsx tests/probes/slashlist.mts antigravity --turn
 * ```
 *
 * ⚠️ **진짜 CLI 가 붙어 있어야 한다** — 로그인 안 된 에이전트는 그렇다고
 * 적고 넘어간다. `tests/all.mjs` 는 `probes/` 를 안 긁는다.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { withInstalled } from "../../src/core/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const WAIT_MS = 60_000;
/*
 * 🔴 **받아둔 자리를 거쳐야 한다** (2026-10-19, 여기서 데었다).
 *
 * 날것 `DEFAULT_AGENTS` 를 그대로 쓰면 Antigravity 는 `command: ""` 라
 * **아예 안 뜬다.** 그걸 모르고 «광고하는 명령이 0개» 라고 적을 뻔했다 —
 * «없다» 와 «못 띄웠다» 는 다른 말이고, 섞이면 측정이 아니라 지어낸 것이다.
 *
 * 확장이 쓰는 자리와 같은 곳을 본다(`extension.ts` 의 `readAgents`).
 */
const ROOT = process.env.AIO_AGENT_ROOT
  ?? path.join(os.homedir(), "AppData", "Roaming", "Code", "User",
               "globalStorage", "taein-yoon.ai-in-one");
const want = process.argv.slice(2).find((a) => !a.startsWith("--"));
/** 빈손이면 짧은 턴을 한 번 보낸다 — 토큰을 쓰므로 손으로 줄 때만 */
const alsoTurn = process.argv.includes("--turn");
const picked = DEFAULT_AGENTS.map((a) => withInstalled(a, ROOT))
  .filter((a) => !want || a.id === want);
if (picked.length === 0) {
  console.log(`그런 에이전트가 없다: ${want} (${DEFAULT_AGENTS.map((a) => a.id).join(" · ")})`);
  process.exit(1);
}

const nap = (t: number) => new Promise((r) => setTimeout(r, t));

for (const agent of picked) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-slash-"));
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
  const mgr = new RoomManager({ host, store, agents: [agent] });
  const trouble: string[] = [];
  mgr.on("roomError", (_r, why) => trouble.push(String(why)));
  mgr.on("notice", (n) => trouble.push(String((n as { text?: string }).text ?? n)));

  console.log(`\n── ${agent.label ?? agent.id} (${agent.id}) ─────────────────`);
  /* ★ **무엇을 띄우는지 먼저 적는다** — 빈손이면 측정이 아니라 못 띄운 것이다 */
  console.log(`  띄운다: ${agent.command || "(비었다 — 안 받았다)"} ${agent.args.join(" ")}`.trim());
  if (!agent.command) {
    console.log("  → 건너뛴다 (측정이 아니다)");
    mgr.dispose(); await store.flush();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    continue;
  }
  const began = Date.now();
  try {
    const room = await mgr.createRoom({ title: "슬래시", bots: [{ agentId: agent.id }] });
    const bot = room.participants[0]!;
    const inner = mgr as unknown as {
      botRuntime(r: string, b: string): { commands?: string[] };
    };

    /* ② **언제 오나** — 올 때까지 기다리되, 얼마나 걸렸는지 적는다 */
    let names: string[] = [];
    for (let i = 0; i < WAIT_MS / 250; i++) {
      names = inner.botRuntime(room.id, bot.id).commands ?? [];
      if (names.length > 0) break;
      await nap(250);
    }
    const took = ((Date.now() - began) / 1000).toFixed(1);

    if (names.length === 0 && alsoTurn) {
      console.log(`  (${took}초 동안 세션만으로는 안 왔다 — 턴을 한 번 보낸다)`);
      const began2 = Date.now();
      await mgr.send(room.id, "1 더하기 1은? 숫자만.", undefined, bot.id);
      for (let i = 0; i < WAIT_MS / 250; i++) {
        names = inner.botRuntime(room.id, bot.id).commands ?? [];
        if (names.length > 0) break;
        await nap(250);
      }
      console.log(`  턴 뒤 ${((Date.now() - began2) / 1000).toFixed(1)}초 → ${names.length}개`);
    }
    if (names.length === 0) {
      console.log(`  (아무것도 안 왔다${alsoTurn ? " — 턴을 보내고도" : ""})`);
      if (trouble.length > 0) console.log(`  막힌 까닭: ${trouble.slice(0, 2).join(" / ")}`);
    } else {
      console.log(`  ${names.length}개 · 세션 연 뒤 ${took}초`);
      console.log(`  ${names.join(" · ")}`);
      const squeeze = mgr.compactCommand(room.id, bot.id);
      console.log(`  ③ 압축으로 고른 것: ${squeeze ?? "(없다 — 압축 버튼이 안 뜬다)"}`);
    }
  } catch (e) {
    console.log(`  터졌다: ${(e as Error).message}`);
    if (trouble.length > 0) console.log(`  곁들여: ${trouble.slice(0, 2).join(" / ")}`);
  }
  mgr.dispose();
  await store.flush();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);
