/**
 * **분기한 방의 첨부는 원본과 엮이지 않는다** (2026-10-07 — 다시 씀).
 *
 * ⏪ 이 검사도 한 번 사라졌다(`NEXT.md` ①). 이름만 남아 있어 blob 규칙을
 * 다시 읽고 새로 설계했다.
 *
 * blob 은 **내용이 곧 이름**이다(sha256). 같은 그림을 여러 방이 붙여도 파일은
 * 하나다 — 아끼려는 것이기도 하지만, 그래서 **방 하나를 지울 때 남의 것까지
 * 지울 위험**이 생긴다. 분기하면 두 방이 같은 첨부를 가리키므로 **바로 그
 * 상황이 기본값으로** 만들어진다.
 *
 * ```
 * 원본을 지운다   → 분기한 방이 아직 쓰므로 blob 은 살아 있어야 한다
 * 둘 다 지운다    → 그때 비로소 쓸려 나가야 한다
 * ```
 *
 * 세는 대신 **전부 훑어 mark-and-sweep** 한다(`store.sweepBlobs`). 카운트가
 * 어긋나 영영 남는 사고가 없는 대신, **훑는 쪽이 분기한 방을 빠뜨리면** 남이
 * 쓰는 것을 지운다. 여기서 재는 것이 그것이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-forkblob-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...DEFAULT_AGENTS[0]!, id: "a1", label: "a1",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
      env: { AIO_FAKE_STATE: path.join(dir, "s.jsonl") },
    }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const settle = async (id: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(id)); i++) await nap(25);
  };
  const blobFile = (sha: string) => path.join(dir, "blobs", sha);

  /* 붙인 그림이라 치자 — 내용이 곧 이름이라 무엇이든 된다 */
  const sha = await store.putBlob("PNG 인 셈 치고 붙인 것");
  ok(fsSync.existsSync(blobFile(sha)), "붙인 것이 blob 으로 저장된다");

  const room = await mgr.createRoom({ agentId: "a1", title: "원본" });
  await mgr.send(room.id, "이거 보세요", [
    { sha256: sha, mimeType: "image/png", name: "shot.png", byteSize: 4 },
  ]);
  await settle(room.id);

  const mine = (await store.loadRoom(room.id))!.messages.find((m) => m.role === "user")!;
  ok((mine.attachments ?? []).some((a) => a.sha256 === sha), "메시지가 그 해시를 들고 있다");

  console.log("\n[★ 분기하면 둘이 같은 blob 을 가리킨다]");
  const forked = await mgr.forkRoom(room.id, { title: "분기" });
  const fid = typeof forked === "string" ? forked : (forked as { id: string }).id;
  const copy = (await store.loadRoom(fid))!;
  const shas = copy.messages.flatMap((m) => (m.attachments ?? []).map((a) => a.sha256));
  console.log(`   분기한 방의 해시: ${JSON.stringify(shas)}`);
  ok(shas.includes(sha),
     "★ **같은 해시를 쓴다** — 내용이 곧 이름이라 복사본을 따로 만들지 않는다");
  ok(fid !== room.id, "방은 둘이다");

  console.log("\n[★ 원본을 지워도 분기한 방의 첨부는 산다]");
  await mgr.leaveRoom(room.id);
  ok((await store.loadRoom(room.id)) === null, "원본은 사라졌다");
  console.log(`   blob: ${fsSync.existsSync(blobFile(sha)) ? "있다" : "쓸려 갔다"}`);
  ok(fsSync.existsSync(blobFile(sha)),
     "★ **남이 쓰는 blob 을 안 지운다** — 훑을 때 분기한 방도 세야 한다");
  ok((await store.getBlob(sha)) !== null, "★ 분기한 방에서 실제로 읽힌다");

  console.log("\n[★ 둘 다 지우면 그때 쓸려 간다]");
  await mgr.leaveRoom(fid);
  console.log(`   blob: ${fsSync.existsSync(blobFile(sha)) ? "남았다" : "쓸려 갔다"}`);
  ok(!fsSync.existsSync(blobFile(sha)),
     "★ **아무도 안 쓰면 지운다** — 안 지우면 붙인 것이 영영 쌓인다");

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
