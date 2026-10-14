/**
 * ★ **끊긴 글을 저쪽이 «들고 있나»** — 다시 만들 수 없는 글로 잰다 (2026-10-14).
 *
 * 🔴 `killresume.mts` 는 「1부터 40까지 세어줘」로 쟀다. Antigravity 가 끊긴 뒤에
 * 1..40 을 그대로 뱉었는데 — **그건 아무것도 증명하지 못한다.** 그 글은
 * **요청만 보고도 다시 만들 수 있다.** Claude 의 「8까지 세다가 중단됐어」는
 * 요청에서 안 나오는 값이라 증거가 됐지만, 숫자 세기는 아니다.
 *
 * 그래서 **우리가 고른 무작위 낱말**로 잰다. 저쪽이 다시 만들 길이 없다.
 *
 * ```
 * ① 낱말 40개를 **우리가 적어 보낸다** — 그대로 받아적으라고
 * ② 글자가 오기 시작하면 CLI 를 죽인다 (몇 개까지 왔는지 우리가 안다)
 * ③ 다시 붙여서 «방금 적던 것을 그대로 다시» 라고 한다
 * ④ 우리가 받아둔 토막과 **겹치는지** 본다
 *    겹친다 → 저쪽이 그 글을 들고 있다
 *    다르다 → 지어낸 것이다 (또는 새로 만든 것)
 * ```
 *
 * ```
 * npx tsx tests/probes/killwords.mts [에이전트]
 * ```
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import { withInstalled } from "../../src/core/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WANT = process.argv[2] ?? "antigravity";
const AGENT_ROOT = path.join(
  os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "taein-yoon.ai-in-one",
);

/** 저쪽이 **지어낼 수 없는** 낱말 40개 — 우리가 그때그때 만든다 */
function words(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.random().toString(36).slice(2, 8));
  }
  return out;
}

async function main(): Promise<void> {
  const found = DEFAULT_AGENTS.find((a) => a.id === WANT);
  if (!found) { console.log(`그런 에이전트가 없다: ${WANT}`); process.exit(1); }
  const agent = withInstalled(found, AGENT_ROOT);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-words-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("  roomError:", e));
  mgr.on("notice", (_r, m) => console.log("  notice:", m.slice(0, 80)));

  const list = words(40);
  console.log(`\n[${agent.label}] 낱말 40개 중 앞 5개: ${list.slice(0, 5).join(" ")}`);

  const room = await mgr.createRoom({ agentId: agent.id, title: "낱말 받아적기" });
  await mgr.send(room.id, "«준비» 라고만 답해.");
  for (let i = 0; i < 2400 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);

  /* ① 우리가 적어 보낸다 — 저쪽이 만들 수 있는 글이 아니다 */
  void mgr.send(room.id,
    "아래 낱말을 **한 줄에 하나씩 그대로** 받아적어줘. 설명도 번호도 붙이지 마.\n\n"
    + list.join("\n"));

  /* ② 글자가 오기 시작하면 죽인다 */
  const inner = mgr as unknown as {
    connections: Map<string, { proc?: { pid?: number; kill(sig?: string): boolean } }>;
  };
  let cut = "";
  for (let i = 0; i < 4800; i++) {
    const live = room.messages.at(-1);
    if (live?.role === "agent" && (live.text?.length ?? 0) > 30) {
      cut = live.text;
      console.log(`  ${cut.length}자에서 죽인다 — 꼬리 ${JSON.stringify(cut.slice(-20))}`);
      inner.connections.get(agent.id)?.proc?.kill("SIGKILL");
      break;
    }
    await nap(25);
  }
  if (!cut) { console.log("  🔴 전제가 안 섰다 — 글자가 안 왔다"); mgr.dispose(); return; }
  for (let i = 0; i < 2400 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);

  /* ③ 다시 붙여서 묻는다 */
  await mgr.send(room.id,
    "방금 적던 것을 **그대로** 다시 적어줘. 새로 만들지 말고 그때 네가 보낸 글을 그대로. "
    + "기억 안 나면 «모름» 이라고만 해.");
  for (let i = 0; i < 4800 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);

  const said = room.messages.at(-1)?.text ?? "";
  /* ④ 우리가 받아둔 토막과 겹치나 */
  const had = cut.split(/\s+/).filter(Boolean);
  const now = said.split(/\s+/).filter(Boolean);
  const same = had.filter((w) => now.includes(w)).length;
  console.log(`\n  ★ 끊기기 전 받은 낱말 ${had.length}개 · 다시 받은 글 ${now.length}개`);
  console.log(`  ★ 그중 **겹치는 것 ${same}개**`);
  console.log(`  ★ 답(앞 120자): ${JSON.stringify(said.slice(0, 120))}`);
  console.log(
    same >= Math.max(2, Math.floor(had.length * 0.6))
      ? "  ⇒ **들고 있다** — 우리가 준 낱말을 다시 냈다"
      : "  ⇒ **못 들고 있다** — 그 글은 저쪽에 안 남았다",
  );
  mgr.dispose();
  await nap(300);
  console.log(`  (작업폴더: ${dir})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
