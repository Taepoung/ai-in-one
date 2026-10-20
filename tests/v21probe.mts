/** 단체방 대화가 **봇별로 갈라지는 데 필요한 값을 다 들고 있나** (v2.1 전제). */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { ComposeToken } from "../src/core/mentions.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-v21-"));
const store = new RoomStore(dir); await store.init();
const host: WorkspaceHost = {
  readTextFile: async () => "", writeTextFile: async () => {},
  requestPermission: async () => ({ outcome: "cancelled" }),
  log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
};
const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
const mgr = new RoomManager({ host, store, configProbeMs: 20000,
  agents: [{ ...base, id: "alpha", label: "알파" }, { ...base, id: "beta", label: "베타" }] });
mgr.on("roomError", () => {}); mgr.on("notice", () => {});
const settle = async () => { for (let i = 0; i < 400; i++) {
  if (["idle","error"].includes(mgr.statusOf(room.id))) return; await nap(25); } };

const room = await mgr.createRoom({ title: "섞인 방",
  bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }] });
const [a, b] = room.participants;
const at = (botId: string): ComposeToken => ({ kind: "mention", botId });
const txt = (text: string): ComposeToken => ({ kind: "text", text });

await mgr.send(room.id, "구현아 해줘", undefined, a!.id); await settle();
await mgr.send(room.id, "리뷰어야 봐줘", undefined, b!.id); await settle();
await mgr.sendCompose(room.id, [at(a!.id), txt(" "), at(b!.id), txt(" 둘 다 확인")]); await settle();
await mgr.setConfig(room.id, "model", "sonnet", b!.id);
await mgr.renameBot(room.id, a!.id, "설계자");

const nameOf = (id?: string) => room.participants.find((p) => p.id === id)?.name ?? id ?? "-";
console.log("\n역할     | 글쓴이 | 받는이         | 글");
console.log("---------|--------|----------------|----");
for (const m of room.messages) {
  const to = m.deliveredTo.map(nameOf).join(",") || "-";
  console.log(
    `${m.role.padEnd(8)} | ${nameOf(m.authorBotId).padEnd(6)} | ${to.padEnd(14)} | ` +
    JSON.stringify(m.text.slice(0, 34)));
}
mgr.dispose(); await nap(200);
try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
