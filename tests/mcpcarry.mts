/**
 * **세션이 다시 붙을 때도 도구를 들고 간다** (2026-10-09).
 *
 * 🔴 우리는 `new`·`fork` 에만 `mcpServers` 를 넘기고 **`resume`·`load` 에는
 * 아예 안 실었다**. v3.0 에서 봇끼리 말을 거는 길이 전부 MCP 도구이므로,
 * 그 상태로 도구를 달면 **모든 방이 껐다 켜는 순간 말을 못 하게 된다** —
 * 옛 방 문제가 아니라 **다음 실행마다** 일어나는 일이다.
 *
 * 게다가 `session/load` 는 스펙상 `mcpServers` 가 **필수 필드**인데 우리가
 * 빼고 보내고 있었다.
 *
 * 그리고 **포트는 실행마다 바뀐다.** 그러니 «한 번 실어두면 되는» 값이 아니라
 * 매번 **지금 주소로** 다시 얹어야 하는 값이다 — 되살아난 세션이 지난번 포트를
 * 들고 있으면 도구가 있으나 마나다. 그래서 주소를 **함수로** 받는다.
 *
 * 여기서는 **우리가 무엇을 실어 보내는지**만 본다 — 가짜 에이전트가 받은 것을
 * 그대로 적어둔다. 진짜 CLI 가 그걸 살려주는지는 `probes/mcpresume.cjs` 가 잰다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

type Ev = { t: string; method?: string; mcp?: Array<{ name?: string; url?: string }> | null };

const HERE = "http://127.0.0.1:54321/mcp";

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-mcpcarry-"));
  const state = path.join(dir, "s.jsonl");
  const disk = path.join(dir, "disk.json");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state, AIO_FAKE_DISK: disk },
  };

  const events = async (): Promise<Ev[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean).map((l) => JSON.parse(l) as Ev);
    } catch { return []; }
  };

  /*
   * ★ **연결이 들고 있다가 무조건 얹는다.**
   *
   * 부르는 쪽마다 챙기게 두면 또 한 군데를 빠뜨린다 — 방금 `resume`·`load` 가
   * 그랬다. 그래서 주소는 **방 매니저에 한 번만** 맡기고, 네 길에 다 실리는지 본다.
   */
  const open = () => {
    const mgr = new RoomManager({
      host, store, configProbeMs: 20000, agents: [agent],
      mcpServers: () => [{ type: "http", name: "ai-in-one", url: HERE, headers: [] }],
    });
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});
    return mgr;
  };

  let roomId = "";

  console.log("\n[★ ① 새 세션 — 주소가 실린다]");
  {
    const mgr = open();
    const room = await mgr.createRoom({ agentId: "fake", title: "도구" });
    roomId = room.id;
    await mgr.send(room.id, "안녕");
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);
    const made = (await events()).filter((e) => e.t === "new");
    console.log(`   new: ${JSON.stringify(made.at(-1)?.mcp)}`);
    ok(made.at(-1)?.mcp?.[0]?.url === HERE, "★ session/new 에 우리 주소가 실린다");
    mgr.dispose();
  }

  await nap(400);

  console.log("\n[★ ② 껐다 켜고 다시 붙을 때도 — 여기가 비어 있었다]");
  {
    const mgr = open();
    await mgr.openRoom(roomId);
    await mgr.send(roomId, "다시 왔어");
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(roomId)); i++) await nap(25);
    const back = (await events()).filter((e) => e.t === "resume-try");
    console.log(`   resume-try ${back.length}번 · 마지막: ${JSON.stringify(back.at(-1)?.mcp)}`);
    ok(back.length > 0, "다시 붙기를 시도했다");
    // `mcp: null` 은 **아예 안 실렸다**는 뜻이다 (빈 배열과 다르다)
    ok(back.at(-1)?.mcp !== null, "★ resume/load 에 mcpServers 가 실린다");
    ok(back.at(-1)?.mcp?.[0]?.url === HERE, "★ 그것도 지금 주소로");
    mgr.dispose();
  }

  // 프로세스가 폴더를 아직 쥐고 있을 수 있다 — 못 지워도 `all.mjs` 가 쓸어간다
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log("\n통과");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
