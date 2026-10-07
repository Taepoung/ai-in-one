/**
 * **갈아타고 버린 세션은 지운다** (2026-10-07).
 *
 * 사용자가 물었다 — *"대화 도중에 에이전트 바꾸면 이전 에이전트에 물려있던
 * 세션은 자동으로 삭제되나?"*. **안 됐었다.**
 *
 * 갈아탈 때는 `cancel` 만 하고 **되돌릴 수 있게** 남겨둔다. 거기까진 맞다 —
 * 사용자가 «다시 시도» 로 돌아갈 수 있다. 그런데 **무엇을 넘길지 정하는
 * 순간** `lostSessionId` 를 버리므로, 그때부터는
 *
 * ```
 * 우리는 돌아갈 길이 없는데   세션은 그 CLI 에 남아 있다
 * ```
 *
 * 가 된다. 아무도 못 쓰는 것이 쌓이는 꼴이다. 그래서 **버리는 자리에서 같이
 * 지운다** — 방을 나갈 때와 같은 기준이다.
 *
 * ⚠️ **되살린 경우는 안 지운다.** `retryResume` 도 `lostSessionId` 를 지우지만
 * 그건 **그 세션을 다시 쓰기로 했기 때문**이다. 버린 것과 되찾은 것을
 * 같이 묶으면 **방금 되살린 대화를 지운다.**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-switch-"));
  const store = new RoomStore(dir); await store.init();
  const logOf = (id: string) => path.join(dir, id + ".jsonl");
  const mk = (id: string) => ({
    ...DEFAULT_AGENTS[0]!, id, label: id,
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: logOf(id) },
  });
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [mk("old"), mk("new")], configProbeMs: 20000 });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const settle = async (id: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(id)); i++) await nap(25);
  };
  type Note = { t: string; sessionId?: string };
  const notes = (id: string): Note[] =>
    (fsSync.existsSync(logOf(id)) ? fsSync.readFileSync(logOf(id), "utf8") : "")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Note);

  console.log("\n[★ 말을 건 세션은 갈아탄 뒤 지운다]");
  {
    const room = await mgr.createRoom({ agentId: "old", title: "갈아탈 방" });
    await mgr.send(room.id, "한 마디");
    await settle(room.id);

    const made = notes("old").find((e) => e.t === "new")?.sessionId;
    console.log(`   옛 세션: ${made}`);
    ok(made !== undefined, "옛 에이전트가 세션을 만들었다");

    const bot = (await mgr.openRoom(room.id)).participants[0]!;
    await mgr.setAgent(room.id, bot.id, "new");
    ok(!notes("old").some((e) => e.t === "delete"),
       "★ **고르는 사이에는 안 지운다** — 아직 «다시 시도» 로 돌아갈 수 있다");

    /* 사용자가 «안 넘기기» 를 골랐다 — 여기서 돌아갈 길이 사라진다 */
    await mgr.decideRefeed(room.id, false);
    const gone = notes("old").filter((e) => e.t === "delete").map((e) => e.sessionId);
    console.log(`   지운 것: ${JSON.stringify(gone)}`);
    ok(gone.includes(made!),
       "★ **정하는 순간 옛 세션을 지운다** — 못 돌아갈 것을 남겨둘 까닭이 없다");
    ok(!notes("new").some((e) => e.t === "delete"),
       "★ **새 에이전트 것은 안 건드린다** — 갈아탄 뒤라 agentId 는 이미 새것이다");
  }

  console.log("\n[★ 말을 안 건 세션은 지울 것이 없다]");
  {
    const room = await mgr.createRoom({ agentId: "old", title: "말 안 건 방" });
    const bot = (await mgr.openRoom(room.id)).participants[0]!;
    const before = notes("old").filter((e) => e.t === "delete").length;
    await mgr.setAgent(room.id, bot.id, "new");
    await mgr.decideRefeed(room.id, false);
    const after = notes("old").filter((e) => e.t === "delete").length;
    console.log(`   지운 수: ${before} → ${after}`);
    ok(after === before,
       "★ **`delete` 를 안 부른다** — 첫 프롬프트 전엔 파일이 없어 실패하고, 실패한 delete 가 close 까지 깨뜨린다");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
