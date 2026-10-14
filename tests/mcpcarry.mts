/**
 * **세션 네 길 모두가 도구를 들고 간다** (v3.0 0-A · 2-F).
 *
 * 🔴 처음에는 `new`·`fork` 에만 `mcpServers` 를 넘기고 **`resume`·`load` 에는
 * 아예 안 실었다**. v3.0 에서 봇끼리 말을 거는 길이 전부 MCP 도구이므로,
 * 그 상태로 도구를 달면 **모든 방이 껐다 켜는 순간 말을 못 하게 된다** —
 * 옛 방 문제가 아니라 **다음 실행마다** 일어나는 일이다.
 * (게다가 `session/load` 는 스펙상 `mcpServers` 가 **필수 필드**였다.)
 *
 * ⏪ **한때 연결이 그 목록을 들고 있었다** — «부르는 쪽마다 챙기면 한 군데를
 * 빠뜨린다»가 이유였고 그 자체는 맞았다. 그런데 **헤더 비밀이 봇마다 달라야**
 * 한다(2-F): 하나로 돌려쓰면 봇이 **자기 권한 요청을 스스로 승인**할 수 있다.
 * 연결 하나가 세션 여럿을 받으므로 연결에 들려 둘 수가 없다.
 *
 * 그래서 **네 길이 전부 인자로 받고**, 빠뜨림은 부르는 쪽의 한 자리
 * (`RoomManager.mcpFor`)와 **이 검사**가 막는다.
 *
 * 여기서는 **우리가 무엇을 실어 보내는지**만 본다. 진짜 CLI 가 그걸 살려주는지는
 * `probes/mcpresume.cjs` 가 잰다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import { McpServer } from "../src/core/mcpServer.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

type Mcp = Array<{ name?: string; url?: string }> | null;
type Ev = { t: string; method?: string; mcp?: Mcp };

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

  const mcp = new McpServer({
    log: () => {},
  });
  const at = await mcp.start();
  ok(at.at === "ready", "MCP 서버가 섰다");
  const url = at.at === "ready" ? at.url : "";

  const events = async (): Promise<Ev[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean).map((l) => JSON.parse(l) as Ev);
    } catch { return []; }
  };

  const open = () => {
    const mgr = new RoomManager({ host, store, configProbeMs: 20000, agents: [agent], mcp });
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});
    return mgr;
  };

  let roomId = "";

  console.log(`${NL}[★ ① 새 세션 — 주소가 실린다]`);
  {
    const mgr = open();
    const room = await mgr.createRoom({ agentId: "fake", title: "도구" });
    roomId = room.id;
    await mgr.send(room.id, "안녕");
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);
    const made = (await events()).filter((e) => e.t === "new");
    console.log(`   new: ${JSON.stringify(made.at(-1)?.mcp)}`);
    ok(made.at(-1)?.mcp?.[0]?.url === url, "★ session/new 에 지금 주소가 실린다");
    mgr.dispose();
  }

  await nap(400);

  console.log(`${NL}[★ ② 껐다 켜고 다시 붙을 때도 — 여기가 비어 있었다]`);
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
    ok(back.at(-1)?.mcp?.[0]?.url === url, "★ 그것도 지금 주소로");
    mgr.dispose();
  }

  await nap(400);

  console.log(`${NL}[★ ③ 분기한 세션도 — 넷째 길]`);
  {
    const mgr = open();
    const room = await mgr.openRoom(roomId);
    const forked = await mgr.forkRoom(roomId, undefined);
    ok(forked !== undefined, "분기했다");
    const cut = (await events()).filter((e) => e.t === "fork");
    console.log(`   fork ${cut.length}번 · 마지막: ${JSON.stringify(cut.at(-1)?.mcp)}`);
    ok(cut.length > 0, "에이전트가 분기를 받았다");
    ok(cut.at(-1)?.mcp?.[0]?.url === url, "★ session/fork 에도 실린다");
    void room;
    mgr.dispose();
  }

  console.log(`${NL}[★ ④ 비밀은 봇마다 다르다 — 이것이 소유자 검사의 뿌리다]`);
  {
    /*
     * 🔴 하나로 돌려쓰면 **봇이 자기 권한 요청을 스스로 승인할 수 있다** —
     * 큐에서 남의 항목을 꺼내는 것을 막을 근거가 사라진다(2-H).
     */
    const all = (await events())
      .filter((e) => e.mcp && e.mcp.length > 0)
      .map((e) => JSON.stringify(e.mcp));
    ok(all.length >= 3, `세 길 모두에서 실렸다 (${all.length}번)`);
    // 이름과 주소는 같고, 헤더만 다르다 — 가짜 에이전트는 이름·주소만 적는다
    ok(new Set(all).size === 1, "★ 이름과 주소는 **같다** — 자동 승인이 이름에 걸려 있다");
    ok(mcp.issued() > 0, `★ 그리고 열쇠가 발급돼 있다 (${mcp.issued()}개)`);
  }

  console.log(`${NL}[★ ⑤ 서버가 안 서 있으면 — 그냥 안 싣는다]`);
  {
    /*
     * 루프백이 막힌 기계도 있다. 그때 **방이 안 열리면 안 된다** — 봇끼리
     * 못 부를 뿐이고 나머지는 멀쩡해야 한다.
     */
    const off = new McpServer({ log: () => {} });
    const mgr = new RoomManager({ host, store, configProbeMs: 20000, agents: [agent], mcp: off });
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});
    const room = await mgr.createRoom({ agentId: "fake", title: "서버 없이" });
    await mgr.send(room.id, "안녕");
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);
    ok(room.messages.some((m) => m.role === "agent"), "★ **방은 멀쩡히 돈다**");
    const made = (await events()).filter((e) => e.t === "new").at(-1);
    ok((made?.mcp ?? []).length === 0, `★ 도구만 안 실린다 (${JSON.stringify(made?.mcp)})`);
    mgr.dispose();
  }

  mcp.close();
  // 프로세스가 폴더를 아직 쥐고 있을 수 있다 — 못 지워도 `all.mjs` 가 쓸어간다
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}통과`);
}

main()
  .then(() => new Promise((r) => setTimeout(r, 50)))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
