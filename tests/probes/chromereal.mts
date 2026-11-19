/**
 * **진짜 Claude in Chrome 이 우리 방에서 도나** (2026-11-19).
 *
 * `tests/browser.mts` 는 가짜 에이전트로 «무엇을 실어 보내나» 만 잰다. 여기는 **받아둔
 * 진짜 Claude** 를 우리 `RoomManager` 로 띄워, 봇 설정에서 켰을 때 사용자의 Chrome 에서
 * 페이지를 열고 스크린샷이 blob 으로 남는지 본다.
 *
 * ⚠️ 사람이 손으로 돌린다 — 로그인과 Chrome 의 «Claude» 확장이 있어야 하고, 사용자의
 * Chrome 에 탭이 하나 잠깐 열린다. 승인은 전부 «이번만 허용» 으로 답한다.
 *
 * ```
 * npx tsx tests/probes/chromereal.mts
 * ```
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { withInstalled } from "../../src/core/install/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const ROOT = path.join(
  process.env["APPDATA"] ?? path.join(os.homedir(), ".config"),
  "Code", "User", "globalStorage", "taein-yoon.ai-in-one");

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-chromereal-"));
  const store = new RoomStore(dir); await store.init();
  const asked: string[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async (req) => {
      asked.push(String(req.title ?? ""));
      const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options[0];
      return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
    },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const claude = withInstalled(DEFAULT_AGENTS.find((a) => a.id === "claude")!, ROOT);
  if (claude.unavailable) { console.log("  " + claude.unavailable); return; }

  const mgr = new RoomManager({ host, store, agents: [claude], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("  roomError:", e));
  mgr.on("notice", (_r, t) => console.log("  알림:", t));

  const room = await mgr.createRoom({ agentId: "claude", title: "크롬" });
  const bot = room.participants[0]!;
  await mgr.setPolicy(room.id, { browser: true }, bot.id);

  await mgr.send(room.id,
    "Claude in Chrome 으로 https://example.com 을 열고 페이지 제목을 한 줄로 알려줘. " +
    "스크린샷도 한 장 찍고, 끝나면 그 탭은 닫아줘.");
  for (let i = 0; i < 9600 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const reply = room.messages.filter((m) => m.role === "agent").at(-1);
  const tools = reply?.tools ?? [];
  console.log(`  답: ${JSON.stringify(reply?.text?.slice(0, 160))}`);
  console.log(`  알약: ${tools.map((t) => t.name ?? t.title).join(" · ")}`);
  console.log(`  승인 ${asked.length}번`);
  const shots = tools.flatMap((t) => t.images ?? []);
  await new Promise((r) => setTimeout(r, 300));
  const blobs = await Promise.all(shots.map((s) => store.getBlob(s.sha256)));

  const results = [
    ok(mgr.statusOf(room.id) === "idle", "★ 턴이 정상으로 끝났다"),
    ok(tools.some((t) => (t.name ?? "").startsWith("Chrome ")), "★ Chrome 도구를 썼다 — 봇 설정에서 켠 것이 세션에 실렸다"),
    ok((reply?.text ?? "").includes("Example Domain"), "★ 페이지를 읽어 왔다"),
    ok(shots.length > 0 && blobs.every((b) => b !== null && b.length > 1000),
       `★ 스크린샷이 blob 으로 남았다 (${shots.map((s) => s.mimeType).join(",")})`),
  ];

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n  ${results.filter(Boolean).length}/${results.length}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
