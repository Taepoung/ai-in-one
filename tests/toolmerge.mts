/**
 * **도구 갱신이 칸을 비워서 오면 들고 있던 것을 지킨다** (2026-09-29).
 *
 * ACP 는 도구 하나를 `tool_call` 한 번 + `tool_call_update` 여러 번으로
 * 보낸다. 그런데 **갱신에 무엇이 실려 오는지는 어댑터 마음**이다.
 *
 * ```
 * 0.81.2   갱신마다 제목·자리를 매번 다시 보냈다
 * 0.84.0   **첫 번에만 보내고 그 뒤로는 비워서** 보낸다   ← 달라졌다
 * ```
 *
 * 핀을 올리기 전에 probe 를 양쪽으로 쓸어보다가 `clashacp.cjs` 에서 이
 * 차이가 나왔다:
 *
 * ```
 * 0.81.2   Edit clash.ts · clash.ts  ×3
 * 0.84.0   Edit clash.ts · clash.ts,  (빈칸),  (빈칸)
 * ```
 *
 * 우리 `recordActivity` 는 이미 «먼저 온 것을 지킨다» 로 되어 있어서
 * 괜찮았다 — 그런데 **그걸 붙잡아 두는 검사가 없었다.** 지금은 우연히
 * 맞는 코드고, 누가 «어차피 갱신에 다 오는데» 하며 단순하게 고치면 활동
 * 줄의 제목과 파일 이름이 통째로 사라진다. 0.84.0 부터는 그게 **보통**
 * 경우라 바로 티가 난다.
 *
 * 그래서 늦게나마 못을 박는다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-tmerge-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
    }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  console.log("\n[★ 갱신이 제목·자리를 안 주면 먼저 온 것을 지킨다]");
  const room = await mgr.createRoom({ agentId: "fake", title: "도구" });
  /*
   * 가짜 에이전트의 `[[fail:…]]` 가 진짜와 같은 모양을 낸다:
   *   ① tool_call        title「Edit」 · kind edit · locations[그 파일]
   *   ② tool_call_update **제목도 자리도 없이** status만 failed
   */
  await mgr.send(room.id, "[[fail:src/thing.ts]] 고쳐줘");
  for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);

  const withTools = room.messages.filter((m) => (m.tools?.length ?? 0) > 0);
  ok(withTools.length > 0, "★ 도구가 기록됐다");
  const tool = withTools.at(-1)!.tools![0]!;
  console.log(`   제목 ${JSON.stringify(tool.title)} · 자리 ${JSON.stringify(tool.paths)} · 상태 ${tool.status}`);

  ok(tool.status === "failed", "★ 마지막 상태는 갱신이 준 것 — 그건 갈아 끼운다");
  ok(tool.title === "Edit",
     `★ **제목이 살아 있다** (${tool.title}) — 갱신이 안 줘도 먼저 온 것을 지킨다`);
  ok(tool.paths?.includes("src/thing.ts") === true,
     `★ **파일 자리가 살아 있다** (${JSON.stringify(tool.paths)}) — 활동 줄이 «무엇을» 을 잃지 않는다`);
  ok(tool.kind === "edit", "★ 종류도 지킨다 — 아이콘이 바뀌면 안 된다");
  ok(typeof tool.output === "string" && tool.output.includes("modified since read"),
     "★ 반대로 **갱신이 준 것은 받아 적는다** — 결과는 나중에 온다");

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
