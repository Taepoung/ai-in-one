/**
 * **다른 클라이언트가 세션을 쥐고 있을 때** (사용자, 2026-10-20).
 *
 * 사용자가 본 것:
 *
 * ```
 * 이전 세션을 이어받지 못했습니다. 여기서부터는 새 세션입니다. — Invalid request: This Codex
 * session is in use by another Codex client (…) — thread … already has an active writer
 * ```
 *
 * 🔴 «쥐고 있음» 은 세션이 사라진 게 아니라 **잠깐 막힌 것**이다 — 저쪽을 닫으면 그대로
 * 이어받는다. 그런데 다른 실패와 한 길로 가서 **새 세션으로 뚫고 들어갔다** — 맥락이
 * 조용히 끊긴다. 이제는 붙지 못함으로 올려 붙는 화면이 받는다.
 *
 * ```
 * Codex (sessionInUse 있음)   붙지 못함 · 세션 id 그대로 · «새 세션» 줄 없음 → 다시 하면 원래 세션
 * 판별 없는 애드온            예전처럼 새로 연다 (모르는 것을 넘겨짚지 않는다)
 * ```
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";
import type { JoinFail, Room } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

type Inner = {
  runtimes: { get(id: string): { bots: Map<string, { sessionId?: string }> } | undefined };
  config: { forget(roomId: string, botId: string): void };
};

async function make(agentId: "codex" | "claude") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-busy-"));
  const busy = path.join(dir, "busy");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const def = DEFAULT_AGENTS.find((a) => a.id === agentId)!;
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...def, pkg: undefined, command: "node", args: [path.join(here, "fakeagent.cjs")],
      env: { AIO_FAKE_HOLD: "40", AIO_FAKE_RESUME_BUSY: busy },
    }],
  });
  const fails: Array<{ why: JoinFail; line: string }> = [];
  mgr.on("joinFail", (_r: string, _b: string, why: JoinFail, line: string) => fails.push({ why, line }));
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (room: Room) => {
    for (let i = 0; i < 400; i++) {
      if (i > 4 && ["idle", "error"].includes(mgr.statusOf(room.id))) return;
      await nap(25);
    }
  };
  /** 방에 다시 들어간다 — 붙기가 끝날 때까지 */
  const reenter = async (room: Room) => {
    let done = false;
    const on = (rid: string) => { if (rid === room.id) done = true; };
    mgr.on("joinDone", on);
    await mgr.setActiveRoom(null);
    await mgr.setActiveRoom(room.id);
    for (let i = 0; i < 400 && !done; i++) await nap(25);
    mgr.off("joinDone", on);
  };
  /** 창을 껐다 켠 것처럼 — 런타임의 붙임만 뗀다 (저쪽 세션은 그대로 있다) */
  const unbind = (room: Room) => {
    const inner = mgr as unknown as Inner;
    for (const b of room.participants) {
      delete inner.runtimes.get(room.id)?.bots.get(b.id)?.sessionId;
      inner.config.forget(room.id, b.id);
    }
  };
  const lostNotes = (room: Room) => room.messages.filter((m) => m.role === "system" && /새 세션입니다/.test(m.text));
  return { dir, busy, mgr, fails, settle, reenter, unbind, lostNotes };
}

async function main(): Promise<void> {
  console.log(`${NL}[★ Codex — 쥐고 있으면 새로 안 연다 · 붙는 화면이 받는다]`);
  {
    const t = await make("codex");
    const room = await t.mgr.createRoom({ title: "쥐고 있음", agentId: "codex" });
    await t.mgr.send(room.id, "안녕");
    await t.settle(room);
    const bot = room.participants[0]!;
    const before = bot.sessionId;
    ok(!!before && bot.sessionPrompted === true, `전제 — 말을 건 세션이 있다 (${before})`);

    t.unbind(room);
    writeFileSync(t.busy, "다른 Codex 가 쥐고 있다");
    await t.reenter(room);

    ok(t.fails.length === 1, `★ **붙지 못함으로 올린다** (${t.fails.length})`);
    ok(t.fails[0]!.why === "other" && /다른 곳.*쓰고 있어/.test(t.fails[0]!.line),
       `★ 까닭을 말한다 — 다시 시도로 풀리는 갈래 (${t.fails[0]!.why} · ${t.fails[0]!.line.slice(0, 50)}…)`);
    ok(t.lostNotes(room).length === 0, "★ 🔴 **«여기서부터는 새 세션입니다» 를 안 적는다**");
    ok(bot.sessionId === before, "★ **세션 id 그대로** — 버리지 않았다");
    ok(!bot.contextLost && !room.contextLost, "★ 맥락을 잃었다고 표시하지 않는다");

    // 저쪽을 닫았다 → 다시 시도하면 원래 세션에 붙는다
    rmSync(t.busy);
    await t.mgr.retryJoin(room.id, bot.id);
    const inner = t.mgr as unknown as Inner;
    ok(inner.runtimes.get(room.id)?.bots.get(bot.id)?.sessionId === before,
       "★ **다시 시도하면 원래 세션**에 붙는다");
    ok(t.fails.length === 1 && t.lostNotes(room).length === 0, "★ 이번엔 실패도 «새 세션» 줄도 없다");
    t.mgr.dispose();
    await fs.rm(t.dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`${NL}[★ 판별 없는 애드온 — 예전처럼 새로 연다]`);
  {
    /*
     * 글 모양을 모르는 에이전트에서 «쥐고 있음» 을 넘겨짚지 않는다 — 넘겨짚으면 정말로
     * 사라진 세션에서도 붙는 화면에 갇힌다. 모르면 예전 길(새 세션 · 기록에 적기)이다.
     */
    const t = await make("claude");
    ok(DEFAULT_AGENTS.find((a) => a.id === "claude")!.sessionInUse === undefined,
       "전제 — Claude 애드온은 판별을 안 든다");
    const room = await t.mgr.createRoom({ title: "모름", agentId: "claude" });
    await t.mgr.send(room.id, "안녕");
    await t.settle(room);
    t.unbind(room);
    writeFileSync(t.busy, "쥐고 있다");
    await t.reenter(room);
    ok(t.fails.length === 0, "★ 붙지 못함이 아니다");
    ok(t.lostNotes(room).length === 1, "★ 예전처럼 «새 세션» 을 적고 새로 연다");
    t.mgr.dispose();
    await fs.rm(t.dir, { recursive: true, force: true }).catch(() => {});
  }

  if (existsSync("")) console.log();
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
