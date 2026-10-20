/**
 * **우리 도구는 사용자에게 안 묻는다** (v3.0 2-F).
 *
 * 🔴 `say`·`check_queue`·`verdict` 는 **봇이 한 마디 할 때마다** 불린다.
 * 그때마다 승인 카드를 띄우면 그러라고 만든 기능이 아니게 된다 — 사람이
 * 중계기가 된다.
 *
 * 그런데 **«우리 도구인가»를 물을 자리가 아예 없었다.** `decidePermission` 이
 * `toolCall` 에서 제목·종류만 꺼내고 **신원이 든 칸 셋을 통째로 버렸다**:
 *
 * ```
 * Claude        name = "mcp__ai-in-one__say"
 * Antigravity   _meta.mcp = { server, tool }
 * Codex         rawInput = { server, tool, … }     (Codex 는 애초에 안 묻는다)
 * ```
 *
 * ⚠️ **셋 다 없으면 사용자에게 간다 — 넘겨짚지 않는다.** 못 알아본 것을
 * «우리 것»으로 읽으면 **남의 도구가 자동 승인으로 지나간다.** 틀리는 방향이
 * 위험한 쪽이라, 모르면 사람에게 가는 편이 맞다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost, } from "../src/core/workspaceHost.js";
import type { PermissionRequest } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

/** 어디에 신원을 싣나 · 어느 서버를 부르나 */
async function make(where: string | undefined, call: string | undefined) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-mcpself-"));
  const store = new RoomStore(dir); await store.init();
  const asked: PermissionRequest[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async (req) => {
      asked.push(req);
      return { outcome: "selected", optionId: "y" };
    },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...DEFAULT_AGENTS[0]!, id: "alpha", label: "알파",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
      env: {
        ...(where ? { AIO_FAKE_MCP_WHERE: where } : {}),
        ...(call ? { AIO_FAKE_MCP_CALL: call } : {}),
      },
    }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await nap(25);
    }
  };
  return { dir, mgr, asked, settle };
}

/** 한 판 돌리고 «사람에게 물었나»를 돌려준다 */
async function run(where: string | undefined, call: string | undefined) {
  const { dir, mgr, asked, settle } = await make(where, call);
  const room = await mgr.createRoom({ agentId: "alpha", title: "묻나" });
  await mgr.send(room.id, "[[ask:뭔가 한다]] 해줘");
  await settle(room.id);
  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return asked;
}

async function main(): Promise<void> {
  console.log(`${NL}[★ 세 자리 전부에서 우리 도구를 알아본다]`);
  for (const where of ["name", "meta", "raw"]) {
    const asked = await run(where, "ai-in-one/say");
    ok(asked.length === 0, `★ **${where} — 사람을 안 깨운다** (${asked.length}번 물음)`);
  }

  console.log(`${NL}[★ 남의 MCP 서버는 그대로 물어본다]`);
  for (const where of ["name", "meta", "raw"]) {
    const asked = await run(where, "somebody-else/rm");
    ok(asked.length === 1, `★ **${where} — 사람에게 간다** (${asked.length}번)`);
    ok(asked[0]?.mcp?.server === "somebody-else",
       `★ 누구 것인지도 실려 간다 (${JSON.stringify(asked[0]?.mcp)})`);
  }

  console.log(`${NL}[★ 신원이 어디에도 없으면 — 넘겨짚지 않는다]`);
  {
    const asked = await run(undefined, undefined);
    ok(asked.length === 1, "★ **사람에게 간다** — 못 알아본 것을 우리 것으로 읽으면 위험한 쪽으로 틀린다");
    ok(asked[0]?.mcp === undefined, "★ 신원 칸은 **비워 둔다** — 지어내지 않는다");
  }

  console.log(`${NL}[★ 도구 이름에 «__» 가 있어도 안 잘린다]`);
  {
    // Claude 꼴은 이름 하나에 둘을 담는다 — **처음 둘만** 쪼개야 한다
    const asked = await run("name", "ai-in-one/check__queue");
    ok(asked.length === 0, "★ 우리 것으로 알아본다 — 도구 이름의 «__» 에 안 걸린다");
  }

  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
