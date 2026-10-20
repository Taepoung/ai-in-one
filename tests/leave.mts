/**
 * **방을 나가는 일** (2026-10-07 — 다시 씀).
 *
 * ⏪ 이 검사는 **한 번 사라졌다.** 임시 폴더에만 있다가 46개가 통째로 없어졌고
 * 그 중 하나다(`NEXT.md` ①). 이름과 «무엇을 쟀는지» 만 남아 있어 코드를
 * 다시 읽고 새로 설계했다. 그 사이 `leaveRoom` 과 세션 지우기를 여러 번
 * 건드렸는데 **여기가 비어 있었다.**
 *
 * 재는 것은 둘이다. 둘 다 **방이 사람 것**이라는 데서 나온다(§0).
 *
 * ```
 * ① 세션을 못 열어도 방은 남는다      에이전트가 고장 나도 기록을 뺏기지 않는다
 * ② 나간 뒤 늦은 저장이 못 되살린다   지웠는데 돌아오면 «지워지지 않는 방» 이다
 * ```
 *
 * ②가 덜 뻔하다. 저장은 JSONL 에 **덧붙이기**라 파일이 없으면 **새로 만든다** —
 * 그래서 나가면서 지운 뒤에 늦은 턴이 한 줄만 써도 **방이 되살아난다.**
 * `leaveRoom` 이 `left` 에 적어두고 세 저장 길이 그걸 보는 까닭이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-leave-"));
  const store = new RoomStore(dir); await store.init();
  const mk = (id: string, env: Record<string, string>) => ({
    ...DEFAULT_AGENTS[0]!, id, label: id,
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: path.join(dir, id + ".jsonl"), ...env },
  });
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store,
    agents: [mk("closed", { AIO_FAKE_AUTH: "1" }), mk("slow", { AIO_FAKE_SLOW_PROMPT: "1500" })],
    configProbeMs: 20000,
  });
  const said: string[] = [];
  mgr.on("roomError", (_id: string, t: string) => { said.push(t); });
  mgr.on("notice", () => {});

  const settle = async (id: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(id)); i++) await nap(25);
  };
  const roomFile = (id: string) => path.join(dir, "rooms", `${id}.jsonl`);

  console.log("\n[★ 세션을 못 열어도 방은 남는다]");
  {
    const room = await mgr.createRoom({ agentId: "closed", title: "못 여는 방" });
    await mgr.send(room.id, "안녕");
    await settle(room.id);

    /*
     * 세션이 안 열리는 까닭은 여럿이다 — 여기서는 **로그인이 안 된 꼴**로 잰다.
     * 제일 흔하고, 사용자가 손쓸 수 있는 유일한 갈래이기도 하다.
     */
    console.log(`   말: ${said.join(" / ").slice(0, 70)}`);
    ok(said.some((t) => t.includes("closed")),
       "★ **어느 봇이 못 열었는지** 짚는다 — 단체방이면 그게 전부가 아니다");
    ok(said.some((t) => t.includes("로그인")),
       "★ **무엇을 하면 되는지** 말한다 — 까닭만 적으면 막힌 방이 된다");

    /* 목록에 남아 있어야 한다 — 에이전트가 고장 났다고 기록을 뺏을 수 없다 */
    ok(mgr.listMetas().some((m) => m.id === room.id),
       "★ **방이 목록에 남는다** — 세션을 못 연 것은 에이전트 사정이다");

    /* 내가 친 말도 남아야 한다 */
    const back = await store.loadRoom(room.id);
    const mine = (back?.messages ?? []).filter((m) => m.role === "user").map((m) => m.text);
    console.log(`   남은 내 말: ${JSON.stringify(mine)}`);
    ok(mine.includes("안녕"),
       "★ **내가 친 말이 남는다** — 못 보냈다고 지우면 다시 칠 길이 없다");
  }

  console.log("\n[★ 나간 뒤 늦은 저장이 되살리지 못한다]");
  {
    const room = await mgr.createRoom({ agentId: "slow", title: "나갈 방" });
    /* 답이 오기 전에 나간다 — 턴은 아직 돌고 있다 */
    void mgr.send(room.id, "오래 걸리는 것");
    await nap(500);
    ok(fsSync.existsSync(roomFile(room.id)), "나가기 전엔 파일이 있다");

    await mgr.leaveRoom(room.id);
    ok(!fsSync.existsSync(roomFile(room.id)), "나가면 파일이 사라진다");
    ok(!mgr.listMetas().some((m) => m.id === room.id), "목록에서도 빠진다");

    /*
     * 🔴 **여기가 핵심이다.** 늦은 턴이 한 줄만 덧붙여도 JSONL 은 파일을
     * 새로 만든다 — 그러면 방이 되살아나고, 사용자는 «지워지지 않는 방» 을 본다.
     */
    await nap(2500);
    const resurrected = fsSync.existsSync(roomFile(room.id));
    console.log(`   늦은 저장 뒤 파일: ${resurrected ? "되살아났다" : "없다"}`);
    ok(!resurrected,
       "★ **늦은 저장이 방을 되살리지 못한다** — 덧붙이기는 없는 파일을 새로 만든다");
    ok(!mgr.listMetas().some((m) => m.id === room.id),
       "★ 목록에도 안 돌아온다");
    ok((await store.loadRoom(room.id)) === null, "★ 읽어도 없다");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
