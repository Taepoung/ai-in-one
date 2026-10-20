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
import { DEFAULT_AGENTS, resolveAgents } from "../src/agents/index.js";
import { claudeMcpIdentity } from "../src/agents/claude/identity.js";
import { codexMcpIdentity } from "../src/agents/codex/identity.js";
import { antigravityMcpIdentity } from "../src/agents/antigravity/identity.js";
import { standardMcpIdentity } from "../src/agents/standard/index.js";
import { OUR_MCP_TOOLS } from "../src/core/acpConnection.js";
import type { McpWho, ToolCallShape } from "../src/core/types.js";

/** 신원 어댑터 — 애드온이 든다 */
type Who = (tc: ToolCallShape) => McpWho | undefined;
import type { WorkspaceHost, } from "../src/core/workspaceHost.js";
import type { PermissionRequest } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 어디에 신원을 싣나 · 어느 서버를 부르나 · **어디만 보라고 선언했나**.
 *
 * ★ 바탕은 Claude 정의지만 **신원 어댑터는 갈아 끼운다**(2026-10-20) — 안 그러면
 * Claude 의 «이름만 본다» 를 물려받아 낯선 에이전트를 흉내 낼 수 없다. 기본은
 * `standard`(셋 다 본다)다 — 제품에서 설정으로 넣은 에이전트가 받는 것과 같다.
 */
async function make(
  where: string | undefined,
  call: string | undefined,
  adapter: Who = standardMcpIdentity,
) {
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
      ...withoutIdentity(DEFAULT_AGENTS[0]!), id: "alpha", label: "알파",
      mcpIdentity: adapter,
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

/** 정의에서 신원 선언만 걷는다 — 낯선 에이전트를 흉내 낸다 */
function withoutIdentity<T extends { mcpIdentity?: unknown }>(def: T): Omit<T, "mcpIdentity"> {
  const { mcpIdentity: _drop, ...rest } = def;
  return rest;
}

/** 한 판 돌리고 «사람에게 물었나»를 돌려준다 */
async function run(
  where: string | undefined,
  call: string | undefined,
  adapter?: Who,
) {
  const { dir, mgr, asked, settle } = await make(where, call, adapter);
  const room = await mgr.createRoom({ agentId: "alpha", title: "묻나" });
  await mgr.send(room.id, "[[ask:뭔가 한다]] 해줘");
  await settle(room.id);
  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return asked;
}

async function main(): Promise<void> {
  console.log(`${NL}[★ 낯선 에이전트(standard)는 세 자리 전부에서 우리 도구를 알아본다]`);
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

  console.log(`${NL}[★ 도구 이름에 «__» 가 있어도 안 잘린다 — 그리고 우리 셋이 아니면 묻는다]`);
  {
    /*
     * Claude 꼴은 이름 하나에 둘을 담는다 — **처음 둘만** 쪼개야 한다. 그렇게
     * 꺼낸 «check__queue» 는 우리 서버 이름을 달았어도 **우리 셋 중 하나가 아니다**
     * — 코어가 한 번 더 보므로(2026-10-20) 사람에게 간다.
     */
    const asked = await run("name", "ai-in-one/check__queue");
    ok(JSON.stringify(asked[0]?.mcp) === JSON.stringify({ server: "ai-in-one", tool: "check__queue" }),
       `★ 신원은 안 잘린 채 꺼낸다 (${JSON.stringify(asked[0]?.mcp)})`);
    ok(asked.length === 1,
       "★ 🔴 **서버 이름이 우리 것이어도 우리 도구가 아니면 사람에게** — 코어의 둘째 확인");
  }

  console.log(`${NL}[★ 내장 어댑터는 **제 자리만** 본다 (리팩토링 ⑤ · 2026-10-20)]`);
  {
    /*
     * 🔴 **여기가 닫은 구멍이다.** «우리 것» 이면 사람에게 안 묻고 `allow_once`
     * 를 고른다. 그런데 `rawInput` 은 모델이 써 넣는 도구 인자라, 셋 다 뒤지면
     * Claude·Antigravity 에서 어떤 도구가 마침 `{server:"ai-in-one"}` 를 받을 때
     * **자동 승인**으로 지나갈 길이 있었다.
     */
    ok((await run("name", "ai-in-one/say", claudeMcpIdentity)).length === 0,
       "★ Claude — 이름에 실린 우리 도구는 그대로 안 묻는다");
    const viaRaw = await run("raw", "ai-in-one/say", claudeMcpIdentity);
    ok(viaRaw.length === 1,
       `★ 🔴 **이름으로 선언했는데 rawInput 에 «ai-in-one» 이 실려 오면 사람에게 간다** (${viaRaw.length}번)`);
    ok(viaRaw[0]?.mcp === undefined, "★ 신원도 안 붙인다 — 제 자리가 아니면 모르는 것이다");
    ok((await run("meta", "ai-in-one/say", claudeMcpIdentity)).length === 1,
       "★ _meta 에 실려 와도 마찬가지 — 제 자리가 아니다");

    ok((await run("raw", "ai-in-one/say", codexMcpIdentity)).length === 0,
       "★ Codex — rawInput 에 실린 것은 우리 것이다");
    ok((await run("name", "ai-in-one/say", codexMcpIdentity)).length === 1,
       "★ Codex 어댑터는 이름에 실려 와도 사람에게 보낸다");
    ok((await run("meta", "ai-in-one/say", antigravityMcpIdentity)).length === 0,
       "★ Antigravity — _meta 에 실린 것은 우리 것이다");
    ok((await run("raw", "ai-in-one/say", antigravityMcpIdentity)).length === 1,
       "★ Antigravity 어댑터는 rawInput 을 안 믿는다");
  }

  console.log(`${NL}[★ 내장 셋은 제 어댑터를 들고 있다]`);
  {
    const of = (id: string) => DEFAULT_AGENTS.find((a) => a.id === id)?.mcpIdentity;
    ok(of("claude") === claudeMcpIdentity && of("antigravity") === antigravityMcpIdentity
       && of("codex") === codexMcpIdentity, "★ Claude 이름 · Antigravity _meta · Codex rawInput");
    const stranger = resolveAgents({ x: { label: "x", command: "node", args: ["x.js"] } })
      .find((a) => a.id === "x");
    ok(stranger?.mcpIdentity === standardMcpIdentity, "★ 설정으로 넣은 에이전트에는 standard 가 끼워진다");
  }

  console.log(`${NL}[★ 어댑터가 터지면 «모른다» — 사람에게]`);
  {
    const boom: Who = () => { throw new Error("어댑터가 틀렸다"); };
    const asked = await run("name", "ai-in-one/say", boom);
    ok(asked.length === 1 && asked[0]?.mcp === undefined,
       "★ **애드온이 터져도 자동 승인으로 새지 않는다** — 모르는 것은 사람에게");
  }

  console.log(`${NL}[★ 코어가 아는 «우리 도구 셋» 이 실제 도구와 같다]`);
  {
    const real = (await make(undefined, undefined)).mgr.mcpTools().map((t) => t.name).sort();
    ok(JSON.stringify(real) === JSON.stringify([...OUR_MCP_TOOLS].sort()),
       `★ 도구를 늘리면 OUR_MCP_TOOLS 도 늘려야 한다 (${real.join(" · ")})`);
  }

  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
