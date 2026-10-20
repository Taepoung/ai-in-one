/**
 * **diff 해시를 잃지 않는다** (E6).
 *
 * 파일 변경 전문은 대화에 안 담는다 — 100KB짜리를 스무 번 고치면 방 파일이
 * 4MB가 되어 열기도 검색도 망가진다. 대신 `blobs/<sha256>` 에 쓰고 **해시만**
 * 기록한다. 그 쓰기가 비동기라, **끝나기 전에 저장하면 해시가 빈 채로 남고
 * blob은 디스크에 멀쩡히 있는데 가리킬 번호가 없어진다.**
 *
 * 🔴 두 가지를 고쳤다:
 *
 * 1. 영수증 목록이 **방 단위**였다 — 한 봇이 «다 기다렸다»며 비울 때 옆 봇의
 *    영수증까지 지웠다
 * 2. **기다리기만** 했다 — 기다릴 사람이 없어지면(죽거나, 창을 닫거나) 날아갔다.
 *    이제 쓰기가 **끝나면 스스로 적는다**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { ComposeToken } from "../src/core/mentions.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make(hold = 0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-blob-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: String(hold) },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파" },
      { ...base, id: "beta", label: "베타" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { dir, mgr, store, settle };
}
const at = (botId: string): ComposeToken => ({ kind: "mention", botId });
const txt = (text: string): ComposeToken => ({ kind: "text", text });

/** 디스크에 실제로 남은 파일 변경들 */
async function onDisk(dir: string, roomId: string) {
  const s2 = new RoomStore(dir); await s2.init();
  const r = await s2.loadRoom(roomId);
  return (r?.messages ?? []).flatMap((m) => m.files ?? []);
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 나란히 고쳐도 둘 다 해시가 남는다]`);
  {
    const { dir, mgr, settle } = await make(400); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "둘", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;

    await mgr.sendCompose(room.id, [
      at(a!.id), txt(`${NL}[[diff:a.ts]] 고쳐줘${NL}${NL}`),
      at(b!.id), txt(`${NL}[[diff:b.ts]] 고쳐줘`),
    ]);
    await settle(room.id);

    const files = await onDisk(dir, room.id);
    ok(files.length === 2, `파일 둘이 남았다 (${files.length})`);
    for (const f of files) {
      ok(f.newSha256 !== undefined && f.newSha256 !== "",
         `★ **${f.path} 의 해시가 차 있다** — 예전에는 옆 봇이 영수증을 지우면 빌 수 있었다`);
    }
    mgr.dispose();
  }

  console.log(`${NL}[★ 기다릴 사람이 없어져도 안 날아간다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "혼자" });

    const turn = mgr.send(room.id, "[[diff:x.ts]] 고쳐줘");
    await turn;
    await settle(room.id);

    // 창을 닫는 것처럼 — 더 이상 아무도 안 기다린다
    mgr.dispose();
    await new Promise((r) => setTimeout(r, 300));

    const files = await onDisk(dir, room.id);
    ok(files.length === 1 && files[0]!.newSha256 !== undefined,
       "★ **쓰기가 끝나면 스스로 적는다** — 기다려주는 사람이 없어도");
  }

  console.log(`${NL}[★ 해시로 blob 을 실제로 찾을 수 있다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "확인" });
    await mgr.send(room.id, "[[diff:y.ts]] 고쳐줘");
    await settle(room.id);
    mgr.dispose();
    await new Promise((r) => setTimeout(r, 200));

    const files = await onDisk(dir, room.id);
    const s3 = new RoomStore(dir); await s3.init();
    const body = await s3.getBlobText(files[0]!.newSha256!);
    ok(body === "after",
       `★ **번호로 짐을 찾을 수 있다** (${JSON.stringify(body)}) — 이게 안 되면 diff 카드가 안 열린다`);
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
