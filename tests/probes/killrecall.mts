/**
 * ★ **끊긴 뒤 저쪽이 «다 했다» 고 하면 — 진짜인가** (2026-10-14).
 *
 * `killresume.mts` 에서 Antigravity 만 다르게 답했다:
 *
 * ```
 * Claude       「1부터 8까지 세다가 중단됐어」   (8까지 쓰고 죽였다)   맞다
 * Codex        「아직 숫자를 출력하지 못했습니다」 (23까지 쓰고 죽였다)  모른다
 * Antigravity  「1부터 40까지 세었습니다」       (10까지 쓰고 죽였다)  ???
 * ```
 *
 * 둘 중 하나다:
 *
 * ```
 * ① 지어냈다        끊긴 줄 모르고 «다 했다» 고 한다 — 저쪽 말은 못 믿는다
 * ② 진짜로 다 했다   ACP 서버는 **다리**일 뿐이고 진짜 일은 딴 데서 계속 돌았다
 * ```
 *
 * 가르는 법: **그때 쓴 것을 그대로 다시 보여달라**고 한다. 맥락에 들고 있으면
 * 40줄이 나오고, 지어낸 것이면 못 낸다(또는 지금 새로 센다 — 그것도 티가 난다).
 *
 * ```
 * npx tsx tests/probes/killrecall.mts <작업폴더> [에이전트]
 * ```
 */
import * as os from "node:os";
import * as path from "node:path";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { withInstalled } from "../../src/core/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIR = process.argv[2];
const WANT = process.argv[3] ?? "antigravity";
/** 물을 말 — 안 주면 «그때 쓴 것을 그대로» */
const ASK = process.argv[4];
const AGENT_ROOT = path.join(
  os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "taein-yoon.ai-in-one",
);

async function main(): Promise<void> {
  if (!DIR) { console.log("작업폴더를 줘야 한다"); process.exit(1); }
  const found = DEFAULT_AGENTS.find((a) => a.id === WANT)!;
  const agent = withInstalled(found, AGENT_ROOT);

  const store = new RoomStore(DIR);
  await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => DIR, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("  roomError:", e));

  const metas = mgr.listMetas();
  const room = await mgr.openRoom(metas[0]!.id);
  console.log(`  방: ${room.title} · 메시지 ${room.messages.length}개`);

  await mgr.send(
    room.id,
    ASK ?? ("아까 네가 센 숫자를 **그대로** 다시 적어줘. 새로 세지 말고, 그때 네가 보낸 글을 복사해. " +
      "기억 안 나면 «모름» 이라고만 해."),
  );
  for (let i = 0; i < 2400 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) {
    await nap(25);
  }
  const said = room.messages.at(-1)?.text ?? "";
  console.log(`  ★ 답(${said.length}자): ${JSON.stringify(said.slice(0, 400))}`);
  /* 40줄을 들고 있었으면 큰 수가 보인다 — 10까지만 썼으니 거기가 갈림이다 */
  console.log(`  ★ «39» 가 있나: ${said.includes("39")} · «11» 이 있나: ${said.includes("11")}`);
  mgr.dispose();
  await nap(300);
}

main().catch((e) => { console.error(e); process.exit(1); });
