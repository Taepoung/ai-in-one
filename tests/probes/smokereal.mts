/**
 * **핀을 올린 뒤 우리 코드로 진짜 어댑터를 한 번 돌려본다** (2026-09-29).
 *
 * probe 는 ACP 를 손으로 말한다. `npm test` 는 가짜 에이전트를 쓴다.
 * 그 사이 — **우리 코드 + 진짜 어댑터** — 가 아무도 안 밟는 칸이다.
 * 핀을 올렸으면 거기를 한 번은 지나가 봐야 한다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-smoke-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
  console.log(`  어댑터: ${claude.args.join(" ")}`);

  const mgr = new RoomManager({ host, store, agents: [claude], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("  roomError:", e));

  const room = await mgr.createRoom({ agentId: "claude", title: "연기" });
  const opts = await mgr.roomConfigOptions(room.id);
  const model = opts.find((o) => o.category === "model") as
    | { currentValue?: unknown; options?: unknown[] } | undefined;
  const bot = room.participants[0]!;
  console.log(`  모델: ${String(model?.currentValue)} 「${bot.modelLabel}」 · 선택지 ${model?.options?.length ?? 0}개`);

  await mgr.send(room.id, "«연기검사통과» 라고만 답해. 도구 쓰지 마.");
  for (let i = 0; i < 1200 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const reply = room.messages.filter((m) => m.role === "agent").at(-1);
  console.log(`  답: ${JSON.stringify(reply?.text?.slice(0, 80))}`);

  const results = [
    ok(mgr.statusOf(room.id) === "idle", "★ 턴이 정상으로 끝났다"),
    ok((reply?.text ?? "").includes("연기검사통과"), "★ 말이 우리 코드까지 왔다"),
    ok(typeof bot.modelLabel === "string" && bot.modelLabel.length > 0, `★ 모델 이름이 잡혔다 (${bot.modelLabel})`),
    ok((model?.options?.length ?? 0) > 0, "★ 설정 목록이 왔다"),
  ];

  await mgr.leaveRoom(room.id);
  ok(true, "★ 방 나가기가 안 터졌다 (세션 정리 경로)");

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n  ${results.filter(Boolean).length}/${results.length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
void main().catch((e: unknown) => { console.error("실패:", e); process.exit(1); });
