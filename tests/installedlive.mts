/**
 * **받고 나서 방으로 돌아오면 돌아가나** (2026-10-07).
 *
 * 사용자가 봉착했다 — 받아놓고도 방이 계속 이랬다:
 *
 * ```
 * Antigravity 세션을 열지 못했습니다 — 아직 받지 않았습니다.
 * ```
 *
 * 디스크에는 멀정히 들어 있었고 `withInstalled` 도 «있다» 고 했다.
 * 범인은 연결 객체다 — 에이전트당 하나를 쌓아두는데 **만들 때의
 * 정의를 값으로 쥐고** 안 놓았다. 그래서 이런 순서가 막혔다:
 *
 * ```
 * ① 방을 먼저 열어봤다   → «안 받았다» 를 쥐는 연결이 생긴다
 * ② 로봇에서 받았다       → setAgents 로 목록은 고쳐졌다
 * ③ 다시 방으로         → 그 연결은 여전히 ① 을 쥐고 있다
 * ```
 *
 * 순서가 핵심이다. **받고 나서 첫 방을 열면 멀정하다** — 그래서
 * 한천으로 넘어갔고, VSCode 를 다시 띄우기 전엔 풀리지 않았다.
 *
 * ⚠️ **떠 있는 것까지 갈아끼우면 안 된다.** 대화 중에 CLI 를
 * 바꾸면 세션이 끊긴다. 그건 `dropConnection` 이 명시적으로 할 일이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { AgentDef } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-live-"));
  const store = new RoomStore(dir); await store.init();
  const state = path.join(dir, "s.jsonl");

  /* 안 받은 꼴 — `withInstalled` 가 만드는 것과 같은 모양이다 */
  const gone: AgentDef = {
    ...DEFAULT_AGENTS[0]!, id: "a1", label: "안받은앰",
    command: "", args: [],
    unavailable: "안받은앰을(를) 아직 받지 않았습니다.",
  };
  /* 받고 난 뒤 — 띄울 길이 채워졌고 막음표가 없다 */
  const got: AgentDef = {
    ...DEFAULT_AGENTS[0]!, id: "a1", label: "안받은앰",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
  };

  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [gone], configProbeMs: 20000 });
  const said: string[] = [];
  mgr.on("roomError", (_id: string, text: string) => { said.push(text); });
  mgr.on("notice", () => {});

  const settle = async (id: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(id)); i++) await nap(25);
  };

  console.log("\n[★ 받고 나서 돌아오면 돌아간다]");
  {
    const room = await mgr.createRoom({ agentId: "a1", title: "방" });

    /* ① 받기 전에 한 번 열어본다 — 여기서 연결 객체가 생긴다 */
    await mgr.send(room.id, "열려라");
    await settle(room.id);
    console.log(`   받기 전: ${said.join(" / ").slice(0, 60)}`);
    ok(said.some((t) => t.includes("아직 받지 않았습니다")),
       "받기 전엔 제대로 막힌다");

    /* ② 로봇 화면에서 받았다 */
    said.length = 0;
    mgr.setAgents([got]);

    /* ③ 같은 방으로 돌아온다 — 여기가 막히던 자리다 */
    await mgr.send(room.id, "이제는 되나");
    await settle(room.id);
    console.log(`   받은 뒤: ${said.length ? said.join(" / ").slice(0, 80) : "(말 없음)"}`);
    ok(!said.some((t) => t.includes("아직 받지 않았습니다")),
       "★ **받았으면 더 안 막는다** — 연결이 쌓아둔 정의를 갈아끼운다");
    ok(mgr.statusOf(room.id) === "idle",
       "★ 그리고 진짜로 돌아간다 — 막힌 채로 «끔났다» 고만 하지 않는다");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
