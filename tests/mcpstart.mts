/**
 * **MCP 가 서는 차례** (사용자, 2026-10-21: *"처음 깔렸을때, MCP가 안켜지는거 같은데"*).
 *
 * 그때 본 것은 옛 판(0.2.0 · MCP 가 아예 없다)이었는데, 찾다가 진짜 틈이 둘 나왔다:
 *
 * ```
 * ① 서버는 켜질 때 기다리지 않고 선다 — 그 사이에 열린 세션은 MCP 없이 붙고,
 *    선 뒤에도 다시 붙여 주는 길이 없었다(그 봇은 그 세션 내내 say 를 못 쓴다)
 * ② 서버가 섰나 두드려 보는 요청에 끝이 없었다 — 멈추면 «세우는 중» 에 갇혔다
 * ```
 *
 * 두드려 보기를 일부러 늦추거나 멈춰 그 차례를 만든다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { McpServer, KNOCK_MS } from "../src/core/mcpServer.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;

async function main(): Promise<void> {
  console.log(`${NL}[★ 두드려 보기가 멈추면 — 끝이 있다]`);
  {
    // 영영 안 돌아온다 — 다만 진짜 fetch 처럼 **끊으라는 신호(signal)는 받는다**
    globalThis.fetch = ((_u: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
    const mcp = new McpServer({ log: () => {} });
    const t0 = Date.now();
    const at = await mcp.start();
    const took = Date.now() - t0;
    globalThis.fetch = realFetch;
    ok(at.at === "failed", `★ **«세우는 중» 에 안 갇힌다** — 실패로 끝난다 (${at.at})`);
    ok(took >= KNOCK_MS - 100 && took < KNOCK_MS + 2000, `★ 끝은 ${KNOCK_MS}ms 쯤 (${took}ms)`);
    ok(at.at === "failed" && /닿지 않습니다/.test(at.why), `★ 까닭을 남긴다 (${at.at === "failed" ? at.why : ""})`);
    // 다시 시도하면 선다 — 막혔던 것이 풀린 경우
    const again = await mcp.start();
    ok(again.at === "ready", `★ [다시 시도] 하면 선다 (${again.at})`);
    mcp.close();
  }

  console.log(`${NL}[★ 겹쳐 불러도 하나만 선다]`);
  {
    const mcp = new McpServer({ log: () => {} });
    const [a, b] = await Promise.all([mcp.start(), mcp.start()]);
    ok(a.at === "ready" && b.at === "ready" && a.url === b.url, `★ 같은 주소 하나 (${a.at === "ready" ? a.url : ""})`);
    mcp.close();
  }

  console.log(`${NL}[★ 서는 중에 연 세션도 MCP 를 받는다]`);
  {
    // 두드려 보기를 0.8초 늦춘다 — 그 사이에 방을 만든다(세션이 열린다)
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { await nap(800); return realFetch(...a); }) as typeof fetch;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-mcpstart-"));
    const state = path.join(dir, "fake.jsonl");
    const store = new RoomStore(dir); await store.init();
    const host: WorkspaceHost = {
      readTextFile: async () => "", writeTextFile: async () => {},
      requestPermission: async () => ({ outcome: "cancelled" }),
      log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
    };
    const mcp = new McpServer({ log: () => {} });
    const mgr = new RoomManager({
      host, store, mcp, configProbeMs: 20000,
      agents: [{ ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
                 env: { AIO_FAKE_HOLD: "20", AIO_FAKE_STATE: state } }],
    });
    mcp.setHandlers(mgr.mcpTools(), (owner, tool, args) => mgr.mcpCall(owner, tool, args));
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});
    void mgr.startMcp();                       // 확장이 켜질 때처럼 — 안 기다린다
    ok(mgr.mcpState().at !== "ready", "전제 — 방을 만들 때 아직 안 섰다");
    await mgr.createRoom({ title: "바로", agentId: DEFAULT_AGENTS[0]!.id });
    globalThis.fetch = realFetch;
    const opened = (await fs.readFile(state, "utf8")).split(NL).filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; mcp?: Array<{ name?: string }> | null })
      .find((e) => e.t === "new");
    ok((await mgr.startMcp()).at === "ready", "서버는 섰다 (늦게라도)");
    ok((opened?.mcp ?? []).some((s) => s.name === "ai-in-one"),
       `★ 🔴 **그 세션에 우리 MCP 가 실렸다** — 서기를 기다렸다가 열었다 (${JSON.stringify(opened?.mcp)})`);
    mgr.dispose(); mcp.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { globalThis.fetch = realFetch; console.error(e); process.exit(1); });
