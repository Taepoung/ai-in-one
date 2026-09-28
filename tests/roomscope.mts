/**
 * **«방 단위»여야 하는 것과 «봇 단위»여야 하는 것** (B1 · §4.3).
 *
 * 방 단위가 맞는 것은 사실상 **제목 · 작업 폴더 · 대화 · 미읽음**뿐이다.
 * 세션에 걸리는 것은 전부 봇 단위여야 한다 — 세션이 봇 단위이기 때문이다.
 *
 * 🔴 `contextLost` · `lostSessionId` · `refeedPending` 이 방에 있었다. 그래서
 * **먼저 말을 거는 봇이 남의 되먹임을 먹었고**(한 번 쓰이면 꺼지므로 정작
 * 잃은 봇은 못 받았다), 한 봇만 갈아타도 **방 전체가 «위 대화를 모릅니다»** 가
 * 됐다. 이제 진실은 봇에 있고 방 값은 **«하나라도 그런가» 요약**이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-scope-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
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
  const prompts = async () => {
    try {
      const raw = await fs.readFile(state, "utf8");
      return raw.split(NL).filter(Boolean).map((l) => JSON.parse(l))
        .filter((e: { t: string }) => e.t === "prompt") as Array<{ sessionId: string; text: string }>;
    } catch { return []; }
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { dir, mgr, prompts, settle };
}

const HIST = "[이전 대화 기록]";

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 되먹임은 **잃은 봇에게만** 간다]`);
  {
    const { dir, mgr, prompts, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "되먹임", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.send(room.id, "첫 말", undefined, a!.id);
    await mgr.send(room.id, "첫 말", undefined, b!.id);
    await settle(room.id);

    // ★ 알파만 세션을 잃는다 (에이전트 갈아타기가 그 자리다)
    await mgr.setAgent(room.id, a!.id, "gamma");
    ok(a!.contextLost === true, "★ 알파가 잃었다고 **봇에 적힌다**");
    ok(b!.contextLost === undefined, "★ **베타는 멀쩡하다**");
    ok(room.contextLost === true, "방 값은 «하나라도 그런가» 요약이다");

    await mgr.decideRefeed(room.id, true);
    ok(a!.refeedPending === true && b!.refeedPending === undefined,
       "★ **약속도 잃은 봇에게만** 걸린다");

    // 베타에게 먼저 말을 걸어도 남의 것을 안 먹는다
    await mgr.send(room.id, "베타야", undefined, b!.id);
    await settle(room.id);
    const toB = (await prompts()).filter((p) => p.sessionId === b!.sessionId).at(-1)!;
    ok(!toB.text.includes(HIST),
       "★ **베타가 남의 되먹임을 안 먹는다** — 예전에는 먼저 부르는 쪽이 먹었다");

    await mgr.send(room.id, "알파야", undefined, a!.id);
    await settle(room.id);
    const toA = (await prompts()).filter((p) => p.sessionId === a!.sessionId).at(-1)!;
    ok(toA.text.includes(HIST), "★ 알파는 받는다 — 잃은 쪽이 받아야 한다");
    ok(a!.refeedPending === undefined, "★ 한 번 쓰면 걷힌다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 되먹임을 끄면 아무도 안 받는다]`);
  {
    const { dir, mgr, prompts, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "백지" });
    await mgr.send(room.id, "첫 말");
    await settle(room.id);
    const bot = room.participants[0]!;

    await mgr.setAgent(room.id, bot.id, "beta");
    await mgr.decideRefeed(room.id, false);
    ok(bot.refeedPending === undefined, "★ 약속이 안 걸린다");

    await mgr.send(room.id, "다시");
    await settle(room.id);
    const last = (await prompts()).at(-1)!;
    ok(!last.text.includes(HIST), "★ 백지에서 시작한다 — 사용자가 고른 대로");
    mgr.dispose();
  }

  console.log(`${NL}[★ 복구되면 **그 봇만** 걷힌다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "복구", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.send(room.id, "첫 말", undefined, a!.id);
    await mgr.send(room.id, "첫 말", undefined, b!.id);
    await settle(room.id);

    // 둘 다 잃은 상태로 만든다
    await mgr.setAgent(room.id, a!.id, "gamma");
    await mgr.setAgent(room.id, b!.id, "gamma");
    await mgr.decideRefeed(room.id, true);
    ok(a!.refeedPending === true && b!.refeedPending === true, "둘 다 약속이 걸렸다");

    // 알파만 한 턴 돈다
    await mgr.send(room.id, "알파야", undefined, a!.id);
    await settle(room.id);
    ok(a!.refeedPending === undefined, "★ 알파는 썼으니 걷혔고");
    ok(b!.refeedPending === true,
       "★ **베타의 약속은 남아 있다** — 방 값 하나였으면 같이 꺼졌다");
    ok(room.refeedPending === true, "방 요약도 «아직 남은 게 있다»");
    mgr.dispose();
  }

  console.log(`${NL}[★ 분기 폴백 — 폴백한 봇에게만]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "분기", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    await mgr.send(room.id, "첫 말", undefined, room.participants[0]!.id);
    await settle(room.id);

    // 과거 지점 분기는 **둘 다 폴백**이다 (네이티브는 끝에서만)
    const cut = room.messages[0]!.id;
    const forked = await mgr.forkRoom(room.id, { atMessageId: cut, title: "가지" });
    ok(forked !== undefined, "분기됐다");
    const kids = forked!.participants;
    ok(kids.every((k) => k.refeedPending === true),
       "★ 폴백한 봇들에게 약속이 걸린다 — 그들만 백지에서 시작하므로");
    mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
