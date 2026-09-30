/**
 * **Codex 에서 고른 모델이 목록에서 사라지면** (2026-09-30).
 *
 * 사용자 물음: *"근데 목록에서 사라져도? Codex는 이전 모델로 연결이 돼?"*
 *
 * 코드를 읽으면 답은 나온다 — `restoreChoices` 가 «안 주는 값이면 우기지
 * 않는다» 로 접고, 세션이 들고 있는 값이 남는다. 🔴 **그런데 그건 Claude 로
 * 잰 것을 Codex 에 갖다 붙인 것이다.** 두 어댑터는 모델 구조가 다르고
 * (별명이 있고 없고), usage 모양도 다르고, `agentInfo` 도 한쪽만 준다.
 * 같은 코드를 탄다고 같은 일이 난다는 보장이 없다.
 *
 * 마침 딱 맞는 조합이 있다:
 *
 * ```
 * codex-acp 2.0.1    gpt-6-luna 있다   ← 여기서 고른다
 * codex-acp 1.10.0   gpt-6-luna 없다   ← 여기로 열면 «사라진» 상황
 * ```
 *
 * 판을 내리는 것이라 «핀을 올리다 모델이 빠지는» 방향과 반대지만, **방이
 * 들고 있는 값이 목록에 없다**는 상태는 똑같다. 진짜 CLI 로 그 상태를
 * 만들어 본다.
 *
 * 보는 것 넷:
 *   ① 세션이 붙나          — 아예 못 열면 그게 제일 큰 문제다
 *   ② 어떤 모델로 가나     — 옛 모델? 새 기본값? 빈 값?
 *   ③ 사용자가 듣나        — 조용히 갈리면 «왜 답이 달라졌지» 가 된다
 *   ④ 대화가 사나          — 모델은 세션 신원이 아니므로 살아야 한다
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const npx = () => (process.platform === "win32" ? "npx.cmd" : "npx");

function agentAt(version: string) {
  const base = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
  return { ...base, command: npx(), args: ["-y", `@agentclientprotocol/codex-acp@${version}`] };
}

function hostAt(dir: string): WorkspaceHost {
  return {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
}

const settle = async (mgr: RoomManager, id: string) => {
  for (let i = 0; i < 2400; i++) {
    if (["idle", "error"].includes(mgr.statusOf(id))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-cxgone-"));
  const store = new RoomStore(dir); await store.init();
  const results: boolean[] = [];
  let roomId = "";

  console.log("\n[① 2.0.1 에서 «gpt-6-luna» 로 방을 만든다]");
  {
    const mgr = new RoomManager({
      host: hostAt(dir), store, agents: [agentAt("2.0.1")], configProbeMs: 60000,
    });
    mgr.on("roomError", (_r, e) => console.log("   roomError:", e));
    const room = await mgr.createRoom({
      agentId: "codex", title: "코덱스", configValues: { model: "gpt-6-luna" },
    });
    roomId = room.id;
    const bot = room.participants[0]!;
    console.log(`   고른 값 ${JSON.stringify(bot.model)} · 이름 ${bot.modelLabel}`);
    results.push(mark(bot.model === "gpt-6-luna", "★ gpt-6-luna 로 잡혔다"));

    /*
     * 🔴 **«암호» 라고 심었다가 거절당했다** (2026-09-30).
     *
     * 처음엔 «암호는 청록색 마흔둘» 로 심고 나중에 되물었더니 Codex 가
     * *"그 암호는 다시 적어드릴 수 없어요"* 라고 했다. 맥락은 멀쩡히 살아
     * 있는데 **말이 자격증명처럼 읽혀서** 안 되돌려준 것이다. 그대로 뒀으면
     * «이어받기가 깨졌다» 는 엉뚱한 결론이 났다.
     *
     * 기억을 재는 말은 **되돌려주기 껄끄럽지 않은 것**이어야 한다.
     */
    await mgr.send(room.id, "내가 좋아하는 과일은 «무화과» 야. \"알았어\" 라고만 답해.");
    await settle(mgr, room.id);
    const said = room.messages.filter((m) => m.role === "agent").at(-1)?.text ?? "";
    console.log(`   답: ${JSON.stringify(said.slice(0, 40))}`);
    mgr.dispose();
  }

  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n[② 1.10.0 으로 연다 — 거기엔 gpt-6-luna 가 없다]");
  {
    const mgr = new RoomManager({
      host: hostAt(dir), store, agents: [agentAt("1.10.0")], configProbeMs: 60000,
    });
    mgr.on("roomError", (_r, e) => console.log("   roomError:", e));

    const room = await mgr.openRoom(roomId);
    await mgr.send(room.id, "내가 좋아한다고 한 과일 이름만 한 낱말로 적어.");
    await settle(mgr, room.id);

    const bot = room.participants[0]!;
    const opts = await mgr.roomConfigOptions(room.id);
    const model = opts.find((o) => o.category === "model") as { options?: unknown[] } | undefined;
    console.log(`   상태 ${mgr.statusOf(room.id)}`);
    console.log(`   지금 값 ${JSON.stringify(bot.model)} · 이름 ${bot.modelLabel}`);
    console.log(`   고를 수 있는 것 ${model?.options?.length ?? 0}개`);

    results.push(mark(mgr.statusOf(room.id) === "idle", "★ ① 세션이 붙었다"));
    results.push(mark(
      typeof bot.model === "string" && bot.model.length > 0 && bot.model !== "gpt-6-luna",
      `★ ② 없는 값을 안 우긴다 — ${String(bot.model)} 로 갔다`,
    ));

    const told = room.messages.filter(
      (m) => m.role === "system" && /모델|Luna|Terra|gpt/i.test(m.text),
    );
    console.log(`   알림 ${told.length}개: ${told.map((m) => `«${m.text}»`).join(" ")}`);
    results.push(mark(told.length > 0, "★ ③ 바뀌었다고 알려준다"));

    const back = room.messages.filter((m) => m.role === "agent").at(-1)?.text ?? "";
    console.log(`   답: ${JSON.stringify(back.slice(0, 60))}`);
    results.push(mark(back.includes("무화과"), "★ ④ **대화가 살아 있다** — 모델은 세션 신원이 아니다"));

    mgr.dispose();
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n  ${results.filter(Boolean).length}/${results.length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

void main().catch((e: unknown) => { console.error("실패:", e); process.exit(1); });
