/**
 * **끼어들기** — 줄은 두고 턴만 끊는다 (v2.x).
 *
 * 「중단」과 헷갈리면 안 된다. 둘 다 `session/cancel` 을 쓰지만 **큐를 대하는
 * 태도가 정반대**다:
 *
 * ```
 * 중단      턴을 끊고 **줄에 있는 것까지 전부** «안 갔다»로 적는다
 * 끼어들기  턴만 끊는다 — 줄은 살아 있고 곧바로 이어서 나간다
 * ```
 *
 * ★ 맥락은 안 잃는다(진짜 CLI 로 실측 2026-09-23) — 그래서 프롬프트 앞에
 * **«왜 끊겼는지» 한 줄**만 얹어주면 된다. 안 얹으면 모델이 지어낸다.
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
const busy = (s: string) => !["idle", "error"].includes(s);

async function make(hold: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-cut-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: String(hold), AIO_FAKE_STATE: state },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{ ...base, id: "alpha", label: "알파" }, { ...base, id: "beta", label: "베타" }],
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
    for (let i = 0; i < 800; i++) { if (!busy(mgr.statusOf(id))) return; await nap(25); }
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300; i++) { if (cond()) return true; await nap(20); }
    return cond();
  };
  return { dir, mgr, prompts, settle, until };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 끼어들면 줄에 선 말이 곧바로 나간다]`);
  {
    const { dir, mgr, prompts, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "끼어들기" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래 걸리는 일");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    void mgr.send(room.id, "급한 거 먼저");                   // 줄에 선다
    await until(() => mgr.queuedIds(room.id)[bot.id]?.length === 1);

    ok(await mgr.interrupt(room.id, bot.id), "★ 끼어들기가 받아들여진다");
    await settle(room.id);

    const sent = await prompts();
    ok(sent.some((p) => p.text.includes("급한 거 먼저")),
       "★ **줄에 선 말이 실제로 나갔다** — 중단이었다면 «안 갔다»로 적혔을 것이다");

    const m = room.messages.find((x) => x.text === "급한 거 먼저");
    ok(m?.notSentTo === undefined,
       "★ **«안 갔다»로 적히지 않는다** — 이게 중단과 갈리는 자리다");
    ok(mgr.queuedIds(room.id)[bot.id] === undefined, "★ 줄도 비워졌다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 왜 끊겼는지를 프롬프트에 적어준다]`);
  {
    const { dir, mgr, prompts, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "설명" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래 걸리는 일");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    void mgr.send(room.id, "이거 먼저");
    await until(() => mgr.queuedIds(room.id)[bot.id]?.length === 1);
    await mgr.interrupt(room.id, bot.id);
    await settle(room.id);

    const last = (await prompts()).at(-1)!;
    /*
     * 🔴 `session/cancel` 은 **«왜»를 안 남긴다**(실측). 그 빈칸을 모델이
     * 추측으로 메우는데 판마다 다르고, 한 판은 «권한이 거부돼서»라고
     * 지어냈다 — 그러면 우회를 시도한다.
     */
    ok(last.text.includes("중단했습니다"),
       "★ **빈칸을 우리가 채운다** — 안 채우면 모델이 지어낸다");
    ok(last.text.includes("권한 거부나 오류가 아닙니다"),
       "★ **제일 흔한 오해를 콕 집어 막는다**");
    ok(last.text.includes("이거 먼저"), "★ 그리고 진짜 요청이 뒤에 온다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 한 번만 얹는다 — 다음 턴에는 안 붙는다]`);
  {
    const { dir, mgr, prompts, settle, until } = await make(3000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "한 번" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    void mgr.send(room.id, "끼어든 말");
    await until(() => mgr.queuedIds(room.id)[bot.id]?.length === 1);
    await mgr.interrupt(room.id, bot.id);
    await settle(room.id);

    await mgr.send(room.id, "그 다음 평범한 말");
    await settle(room.id);

    const all = await prompts();
    const cut = all.filter((p) => p.text.includes("중단했습니다"));
    ok(cut.length === 1,
       `★ **끊긴 그 턴에만** (${cut.length}개) — 매번 붙으면 노이즈이고 거짓이다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 줄에서 나온 그때 자리를 잡는다 — 빼기도 마찬가지]`);
  {
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "자리" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    void mgr.send(room.id, "줄에 선 말");
    await until(() => mgr.queuedIds(room.id)[bot.id]?.length === 1);

    const held = room.messages.find((m) => m.text === "줄에 선 말")!;
    ok(held.placedAt === undefined,
       "★ 줄에 서 있는 동안은 **자리를 안 잡는다** — 화면에서 맨 아래다");

    /*
     * 🔴 「빼기」를 빠뜨렸더니 말풍선이 **위로 튀었다.** 대기 중에는 바닥에
     * 있다가 물리는 순간 쓴 시각 자리로 돌아간 것이다 — **누른 것이 눈앞에서
     * 달아난다.** 안 갔어도 **줄에서는 나왔다.**
     */
    ok(await mgr.unqueue(room.id, held.id), "빼냈다");
    ok(typeof held.placedAt === "number",
       "★ **빼도 자리를 잡는다** — 안 갔어도 줄에서는 나왔다");
    ok(held.notSentTo?.includes(bot.id) === true, "★ 그리고 «안 갔다»로 적힌다 (§0)");

    // 껐다 켜도 자리가 남아야 한다 — 다시 열었을 때 또 튀면 뜻이 없다
    await settle(room.id);
    mgr.dispose();
    const s2 = new RoomStore(dir); await s2.init();
    const again = await s2.loadRoom(room.id);
    const back = again?.messages.find((m) => m.text === "줄에 선 말");
    ok(typeof back?.placedAt === "number", "★ **디스크에도 남는다**");
  }

  console.log(`${NL}[★ 안 도는 봇은 끊지 않는다]`);
  {
    const { dir, mgr, settle } = await make(0); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "놀고 있음" });
    const bot = room.participants[0]!;
    await mgr.send(room.id, "한 마디");
    await settle(room.id);

    ok((await mgr.interrupt(room.id, bot.id)) === false,
       "★ **끊을 것이 없으면 아무 일도 안 한다** — 괜한 cancel 은 세션만 흔든다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 옆 봇은 안 건드린다]`);
  {
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "둘", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const [a, b] = room.participants;
    void mgr.send(room.id, "오래", undefined, a!.id);
    void mgr.send(room.id, "오래", undefined, b!.id);
    await until(() => busy(mgr.statusOf(room.id, a!.id)) && busy(mgr.statusOf(room.id, b!.id)));

    await mgr.interrupt(room.id, a!.id);
    await until(() => !busy(mgr.statusOf(room.id, a!.id)));
    ok(busy(mgr.statusOf(room.id, b!.id)),
       "★ **리뷰어는 계속 돈다** — 끼어들기는 그 봇의 일이다");
    await settle(room.id);
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
