/**
 * **슬래시 턴이 맥락에 남나** — `/usage` 를 쓰면 에이전트가 그걸 기억하나
 * (사용자, 2026-10-19).
 *
 * 🔴 **이게 갈리면 설계가 갈린다.** 남으면 잔량을 한 번 볼 때마다 대화가
 * 더러워지고 맥락도 먹는다 — 방 안에 버튼을 두면 안 된다. 안 남으면
 * 슬래시는 «어댑터와 나 사이의 일» 이라 대화에 흠집을 안 낸다.
 *
 * 압축(`/compact`)도 같은 길로 보내므로 그쪽에도 걸리는 물음이다.
 *
 * 재는 법 — **되물어 본다.**
 *   ① 표식을 심는다        «내 암호는 …» → 맥락에 뭔가 있게
 *   ② 슬래시를 한 번 쓴다   /usage · /status
 *   ③ 직전 말을 되묻는다    «바로 앞에 내가 뭐라고 했지?»
 *
 * ③ 의 답이 슬래시를 가리키면 **남은 것**이고, ①을 가리키면 **안 남은
 * 것**이다. 덧붙여 `usage_update` 의 `used` 가 ②의 앞뒤로 얼마나 뛰는지도
 * 적는다 — 되묻기가 애매할 때 기댈 다른 눈이다.
 *
 * ⚠️ **턴을 셋 쓴다** — 에이전트마다. 손으로만 돌린다.
 *
 * ```
 * npx tsx tests/probes/slashmem.mts
 * npx tsx tests/probes/slashmem.mts codex
 * ```
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { withInstalled } from "../../src/core/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const WANTED = ["usage", "status"];
/** 일반 낱말이면 못 알아본다 — 돌아왔을 때 **그것인 줄 아는** 표식 */
const MARK = "청록색 마흔둘";
const ROOT = process.env.AIO_AGENT_ROOT
  ?? path.join(os.homedir(), "AppData", "Roaming", "Code", "User",
               "globalStorage", "taein-yoon.ai-in-one");
const only = process.argv[2];
const nap = (t: number) => new Promise((r) => setTimeout(r, t));
const busy = (s: string) => !["idle", "error"].includes(s);

for (const agent of DEFAULT_AGENTS.map((a) => withInstalled(a, ROOT))
  .filter((a) => !only || a.id === only)) {
  console.log(`\n── ${agent.label ?? agent.id} ─────────────────`);
  if (!agent.command) { console.log("  (안 받았다 — 건너뛴다)"); continue; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-slashmem-"));
  const store = new RoomStore(dir);
  await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [agent] });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  try {
    const room = await mgr.createRoom({ title: "기억", bots: [{ agentId: agent.id }] });
    const bot = room.participants[0]!;
    const inner = mgr as unknown as {
      botRuntime(r: string, b: string): { commands?: string[] };
    };
    let names: string[] = [];
    for (let i = 0; i < 160; i++) {
      names = inner.botRuntime(room.id, bot.id).commands ?? [];
      if (names.length > 0) break;
      await nap(250);
    }
    const cmd = WANTED.find((w) => names.includes(w));
    if (!cmd) { console.log("  그런 명령을 안 판다 — 건너뛴다"); mgr.dispose(); continue; }

    /** 한 턴 보내고 **마지막 답**만 돌려준다 */
    const turn = async (text: string): Promise<string> => {
      const before = room.messages.length;
      await mgr.send(room.id, text, undefined, bot.id);
      for (let i = 0; i < 480; i++) {
        if (!busy(mgr.statusOf(room.id))) break;
        await nap(250);
      }
      return room.messages.slice(before)
        .filter((m) => m.role === "agent" && m.text.trim())
        .map((m) => m.text.trim()).join(" ").slice(0, 400);
    };

    await turn(`내 암호는 «${MARK}» 이야. 도구 쓰지 말고 "외웠어"라고만 답해.`);
    const used1 = bot.usage?.contextUsed;

    await turn(`/${cmd}`);

    const back = await turn(
      "바로 앞에 내가 보낸 메세지가 뭐였지? 토씨 그대로만 답하고 다른 말은 하지 마.",
    );
    const used3 = bot.usage?.contextUsed;

    const saysSlash = new RegExp(`/?${cmd}`, "i").test(back);
    /*
     * ★ **읊기를 거절해도 답이 된다** (Codex, 2026-10-19 실측): *"암호가
     * 포함되어 있어 그대로 반복할 수 없어."* — 토씨는 안 돌려줬지만
     * **직전 말에 암호가 있다고 믿는다.** 슬래시가 직전이면 거절할 까닭이
     * 없으므로, 이것도 «슬래시 앞을 가리킨다» 쪽이다.
     */
    const saysMark = back.includes(MARK) || /암호|password/i.test(back);
    console.log(`  되물음 답: ${back.replace(/\s+/g, " ").slice(0, 120)}`);
    console.log(`  → ${saysSlash ? "🔴 **기억한다** (슬래시를 가리킨다)"
      : saysMark ? "★ **안 기억한다** (슬래시 앞의 말을 가리킨다)"
      : "(애매하다 — 아래 수로 본다)"}`);
    console.log(`  used: 표식 뒤 ${used1 ?? "?"} → 되물음 뒤 ${used3 ?? "?"}`
      + `${used1 && used3 ? ` (+${used3 - used1})` : ""}`);
  } catch (e) {
    console.log(`  터졌다: ${(e as Error).message}`);
  }
  mgr.dispose();
  await store.flush();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);
