/**
 * **첫 띄우기가 실패한 뒤에도 다시 붙는다** (사용자, 2026-10-23).
 *
 * 본 것: *"Antigravity 로그인 시 Antigravity 로그인에 실패했습니다 — Antigravity 연결이 이미
 * 내려갔습니다"*.
 *
 * 🔴 첫 띄우기가 실패하면 연결이 **스스로** 내려간다(`dispose`). 그런데 연결 풀이 그 죽은
 * 연결을 계속 내줘서, 창을 다시 띄울 때까지 로그인을 포함한 **모든 호출**이 «이미
 * 내려갔습니다» 로 끝났다. 이제 풀이 내려간 연결을 보면 버리고 새로 만든다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  console.log(`${NL}[★ 첫 띄우기가 실패해도 — 다음 호출은 새로 띄운다]`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-reconnect-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "flaky", label: "깜빡이",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_INIT_FAIL_ONCE: path.join(dir, "failed-once") },
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  // 로그인 화면이 하는 첫 일 — 로그인 길을 묻는다. 여기서 첫 띄우기가 실패한다
  const first = await mgr.authOptionsOf("flaky").then(() => "붙음", (e: Error) => e.message);
  ok(first !== "붙음" && /시작하지 못했습니다/.test(first), `전제 — 첫 띄우기는 실패한다 (${first.split(NL)[0]})`);

  // 🔴 예전엔 여기서부터 영원히 «이미 내려갔습니다» 였다
  const second = await mgr.authOptionsOf("flaky").then(() => "붙음", (e: Error) => e.message);
  ok(second === "붙음", `★ **다음 호출은 새로 띄워 붙는다** — «이미 내려갔습니다» 가 아니다 (${second.split(NL)[0]})`);

  // 붙은 뒤에는 방도 열린다
  const room = await mgr.createRoom({ title: "다시", agentId: "flaky" });
  ok(room.participants[0]!.sessionId !== undefined, "★ 그 뒤로 세션도 열린다");

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
