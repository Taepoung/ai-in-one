/**
 * **전부 중단** (v2.0 · C6) — 병렬로 도는 봇을 한 번에 멈춘다.
 *
 * 🔴 v2.0 감사에서 **이 항목만 테스트가 없었다.** 구현은 있었다 —
 * `cancel(roomId)` 에 봇을 안 지목하면 전원이고, 상태 줄의 «중단» 단추가
 * 그걸 부른다. 하지만 **재본 적이 없었으므로 «된다»고 말할 수 없었다.**
 *
 * 세 가지를 본다:
 *
 * ```
 * 안 지목하면      전원이 멈춘다      — 봇마다 눌러야 하면 병렬의 뜻이 없다
 * 지목하면         그 봇만            — 한 줄을 물리려고 남의 일을 죽이면 안 된다
 * 큐에 있던 것     «안 갔다»로 남는다 — 조용히 버리면 영영 답을 기다린다 (C5)
 * ```
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

/** 「도는 중」 — 화면이 쓰는 것과 같은 잣대 */
const busy = (s: string) => !["idle", "error"].includes(s);

async function make(hold: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-stop-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: String(hold) },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파" },
      { ...base, id: "beta", label: "베타" },
      { ...base, id: "gamma", label: "감마" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (!busy(mgr.statusOf(id))) return;
      await nap(25);
    }
  };
  /** 조건이 설 때까지 기다린다 — 시간으로 재면 느린 기계에서 흔들린다 */
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (cond()) return true;
      await nap(20);
    }
    return cond();
  };
  return { dir, mgr, settle, until };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 안 지목하면 전원이 멈춘다]`);
  {
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "전부", bots: [{ agentId: "alpha" }, { agentId: "beta" }, { agentId: "gamma" }],
    });
    const ids = room.participants.map((b) => b.id);
    for (const id of ids) void mgr.send(room.id, "오래 걸리는 일", undefined, id);

    ok(await until(() => ids.every((id) => busy(mgr.statusOf(room.id, id)))),
       "셋 다 돌고 있다");

    // **봇을 안 지목하면 전원**
    await mgr.cancel(room.id);
    await settle(room.id);
    ok(ids.every((id) => !busy(mgr.statusOf(room.id, id))),
       "★ **한 번에 셋 다 멈춘다** — 봇마다 눌러야 하면 병렬의 뜻이 없다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 지목하면 그 봇만 — 남의 일을 죽이지 않는다]`);
  {
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "하나만", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    void mgr.send(room.id, "오래", undefined, a!.id);
    void mgr.send(room.id, "오래", undefined, b!.id);
    await until(() => busy(mgr.statusOf(room.id, a!.id)) && busy(mgr.statusOf(room.id, b!.id)));

    await mgr.cancel(room.id, a!.id);
    ok(await until(() => !busy(mgr.statusOf(room.id, a!.id))), "★ 지목한 봇은 멈춘다");
    ok(busy(mgr.statusOf(room.id, b!.id)),
       "★ **다른 봇은 계속 돈다** — 한 줄을 물리려고 남의 일을 죽이면 안 된다");
    await settle(room.id);
    mgr.dispose();
  }

  console.log(`${NL}[★ 큐에 있던 것은 «안 갔다»로 남는다 (C5)]`);
  {
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "큐" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "첫 일");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    // 앞이 도는 중이라 **큐로 간다**
    void mgr.send(room.id, "줄 서는 말");
    await until(() => mgr.queuedIds(room.id)[bot.id]?.length === 1);

    await mgr.cancel(room.id);
    await settle(room.id);

    const queued = room.messages.find((m) => m.text === "줄 서는 말");
    ok(queued !== undefined, "말풍선은 그대로 있다 — 조용히 지우지 않는다 (§0)");
    ok(queued!.notSentTo?.includes(bot.id) === true,
       "★ **아직 안 보낸 것은 «안 갔다»로 적힌다** — 조용히 버리면 영영 답을 기다린다");
    ok(mgr.queuedIds(room.id)[bot.id] === undefined, "★ 줄도 비워졌다");
    mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await nap(200); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
