/**
 * **설정은 봇 단위다 — 그리고 바꾸면 화면이 안다** (B1 · B5).
 *
 * 🔴 두 군데가 깨져 있었다:
 *
 * 1. `setConfig` 가 `botId` 를 안 받아 **언제나 첫 봇**에 걸었다. 서랍에서
 *    둘째 봇의 모델을 바꾸면 첫째 봇이 바뀌었다
 * 2. 바꾼 뒤 **방을 다시 안 내보냈다.** `noteRoomConfig` 가 `bot.model` 을
 *    고치는데 알리지 않으니, 화면은 낡은 스냅샷을 들고 있었다 — 서랍의 모델
 *    칸은 `bot.model ?? model.current` 라 **낡은 쪽이 이겼다**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-cfg-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      { ...base, id: "beta", label: "베타", env: {} },
    ],
  });
  const rooms: Room[] = [];
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  mgr.on("room", (r: Room) => rooms.push(r));
  return { dir, mgr, rooms };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 지목한 봇에만 걸린다]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "둘", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    // 세션을 열어둔다
    await mgr.send(room.id, "안녕", undefined, a!.id);
    await mgr.send(room.id, "안녕", undefined, b!.id);

    const before = a!.model;
    await mgr.setConfig(room.id, "model", "sonnet", b!.id);

    ok(b!.model === "sonnet", `★ **지목한 봇이 바뀐다** (${b!.model})`);
    ok(a!.model === before,
       `★ **첫 봇은 그대로다** (${a!.model}) — 예전에는 여기가 바뀌었다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 바꾸면 방을 다시 내보낸다 — 화면이 알아야 한다]`);
  {
    const { dir, mgr, rooms } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "혼자" });
    await mgr.send(room.id, "안녕");
    rooms.length = 0;

    await mgr.setConfig(room.id, "model", "sonnet");
    ok(rooms.length > 0, "★ **`room` 이벤트가 나간다**");
    const last = rooms.at(-1)!;
    ok(last.participants[0]!.model === "sonnet",
       `★ 그 안에 새 값이 실려 있다 (${last.participants[0]!.model})`);
    ok(last.participants[0]!.modelLabel !== undefined,
       "★ 보이는 이름도 — 서랍이 그걸 읽는다");
    mgr.dispose();
  }

  console.log(`${NL}[안 지목하면 방의 첫 봇 — 1:1 경로는 그대로]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "혼자" });
    await mgr.send(room.id, "안녕");
    await mgr.setConfig(room.id, "model", "sonnet");
    ok(room.participants[0]!.model === "sonnet", "★ 봇이 하나면 지목이 필요 없다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 모델이 바뀌면 대화에도 남는다]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "기록" });
    await mgr.send(room.id, "안녕");
    await mgr.setConfig(room.id, "model", "sonnet");
    const said = room.messages.filter((m) => m.role === "system" && m.text.includes("모델이"));
    ok(said.length === 1, "★ 왜 응답 성향이 바뀌었는지 나중에 알 수 있어야 한다");
    ok(!said[0]!.text.includes("의 모델이"),
       `★ **1:1에서는 이름을 안 붙인다** (${said[0]!.text}) — 봇이 하나뿐인데 적으면 군더더기다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 단체방에서는 **어느 봇인지** 적는다]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "누구", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.renameBot(room.id, b!.id, "리뷰어");
    await mgr.setConfig(room.id, "model", "sonnet", b!.id);

    const said = room.messages.filter((m) => m.role === "system" && m.text.includes("모델이"));
    ok(said.length === 1, `모델 공지 하나 (${said.length})`);
    ok(said[0]!.text.startsWith("리뷰어의 모델이"),
       `★ **누구 이야기인지** (${said[0]!.text}) — 봇마다 모델이 따로라(B1) 이름이 없으면 못 짚는다`);
    ok(!said[0]!.text.startsWith(`${a!.name}의`), "★ 안 지목한 봇 이야기가 아니다");

    // 에이전트 바꾸기도 같은 문제였다
    await mgr.setAgent(room.id, b!.id, "alpha");
    const swap = room.messages.filter((m) => m.role === "system" && m.text.includes("에이전트를"));
    ok(swap.length === 1 && swap[0]!.text.startsWith("리뷰어의 에이전트를"),
       `★ **에이전트 바꾸기도 마찬가지** (${swap[0]?.text.slice(0, 40)}…)`);
    mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
