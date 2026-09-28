/**
 * **뷰에서 분기하면 그 봇만** (v2.1 · §5 — 2026-09-22 결정 뒤집음).
 *
 * 🔴 로드맵은 «1:1 뷰에서 분기 비활성»이었다. *"단체방 전체가 fork되나, 그 봇만
 * 분리되나"* 하는 모호함 때문이었는데 — **모호함을 없애는 길은 막는 것만이
 * 아니라 «뜻을 정해주는 것»도 있다.** 자리가 뜻을 말한다:
 *
 * ```
 * 단체방 헤더에서   방 전체가 갈라진다
 * 뷰 헤더에서       그 봇만 갈라진다
 * ```
 *
 * ★ **뷰가 곧 «그 봇이 아는 전부»**라 그걸 그대로 가르면 **정확히 그 맥락의
 * 1:1 방**이 나온다. 남의 줄기를 끌고 가면 새 방 첫 화면이 **그 봇은 본 적 없는
 * 말**로 채워진다 — «화면엔 보이는데 봇은 모른다»(§4.1.1의 위험)를 분기가
 * 새로 만들어내는 셈이다.
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

async function make(hold = 0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-fb-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
                 env: { AIO_FAKE_HOLD: String(hold) } };
  const mgr = new RoomManager({ host, store, configProbeMs: 20000,
    agents: [{ ...base, id: "alpha", label: "알파" }, { ...base, id: "beta", label: "베타" }] });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => { for (let i = 0; i < 800; i++) {
    if (["idle", "error"].includes(mgr.statusOf(id))) return; await nap(25); } };
  return { dir, mgr, settle };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 봇만 가르면 그 봇 혼자 있는 방이 된다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ title: "섞인 방",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }] });
    const [a, b] = room.participants;
    await mgr.send(room.id, "구현아", undefined, a!.id); await settle(room.id);
    await mgr.send(room.id, "리뷰어야", undefined, b!.id); await settle(room.id);

    const cut = await mgr.forkRoom(room.id, { botId: a!.id });
    ok(cut.participants.length === 1, `★ **혼자다** (${cut.participants.length})`);
    ok(cut.participants[0]!.name === "구현", "★ 그 봇이다");
    ok(cut.title === "섞인 방 — 구현", `★ 제목이 누구 갈래인지 말한다 (${cut.title})`);

    const said = cut.messages.filter((m) => m.role !== "system").map((m) => m.text);
    ok(said.some((t) => t.includes("구현아")), "★ 그 봇에게 간 말은 온다");
    ok(!said.some((t) => t.includes("리뷰어야")),
       `★ **남의 줄기는 안 온다** (${said.join(" | ")}) — 새 방 첫 화면이 «본 적 없는 말»이면 안 된다`);

    ok(room.participants.length === 2, "★ **원본은 그대로** — 이사가 아니라 분기다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 방 전체 분기는 예전 그대로]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ title: "방",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }] });
    const [a, b] = room.participants;
    await mgr.send(room.id, "구현아", undefined, a!.id); await settle(room.id);
    await mgr.send(room.id, "리뷰어야", undefined, b!.id); await settle(room.id);

    const all = await mgr.forkRoom(room.id);
    ok(all.participants.length === 2, "★ 둘 다 간다");
    const said = all.messages.filter((m) => m.role !== "system").map((m) => m.text);
    ok(said.some((t) => t.includes("구현아")) && said.some((t) => t.includes("리뷰어야")),
       "★ 대화도 통째로");
    mgr.dispose();
  }

  console.log(`${NL}[★ 그 봇과 나눈 게 없으면 못 가른다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ title: "방",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }] });
    const [a, b] = room.participants;
    await mgr.send(room.id, "구현아만", undefined, a!.id); await settle(room.id);

    let why = "";
    try { await mgr.forkRoom(room.id, { botId: b!.id }); } catch (e) { why = String(e); }
    ok(why.includes("리뷰어"),
       `★ **누구와 나눈 게 없는지 말한다** (${why.replace(/^Error: /, "")}) — «나눌 대화가 없습니다»만으로는 방에 대화가 있는데 왜 안 되는지 모른다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 옆 봇이 도는 중이어도 내 갈래는 딸 수 있다]`);
  {
    const { dir, mgr, settle } = await make(3000); dirs.push(dir);
    const room = await mgr.createRoom({ title: "방",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }] });
    const [a, b] = room.participants;
    await mgr.send(room.id, "구현아", undefined, a!.id);
    await settle(room.id);

    void mgr.send(room.id, "리뷰어야 오래", undefined, b!.id);   // 리뷰어가 돈다
    for (let i = 0; i < 100; i++) {
      if (!["idle", "error"].includes(mgr.statusOf(room.id, b!.id))) break;
      await nap(20);
    }
    const cut = await mgr.forkRoom(room.id, { botId: a!.id });
    ok(cut.participants[0]!.name === "구현",
       "★ **옆 봇이 도는 건 이 갈래와 상관이 없다** — 막으면 «남이 일하는 동안 못 딴다»가 된다");

    let why = "";
    try { await mgr.forkRoom(room.id); } catch (e) { why = String(e); }
    ok(why.includes("진행 중인 턴"), "★ 방 전체 분기는 여전히 막힌다 — 반쯤 온 응답을 물려받으면 안 된다");
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
