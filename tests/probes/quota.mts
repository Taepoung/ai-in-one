/**
 * **토큰 한도를 볼 수 있나** — `/usage` 를 불러서 무엇이 돌아오나 (2026-10-19).
 *
 * 🔴 **우리가 받는 숫자는 한도가 아니다.** `usage_update` 의 `used/size` 는
 * «이 세션 컨텍스트가 얼마나 찼나» 라, 압축하면 **되레 내려간다.** 구독이
 * 얼마나 남았는지는 어댑터 쪽에만 있고, 그 길은 **슬래시 명령**이다
 * (`SLASH.md`: Claude `usage`·`usage-credits`·`extra-usage`,
 * Antigravity `usage`, Codex 는 `status`).
 *
 * ★ **부를 수는 있다.** 압축이 그러듯(`RoomManager.compact`) 그냥 `/이름` 을
 * 프롬프트로 보내면 된다. 그래서 **부를 수 있나**가 아니라 **무엇이
 * 돌아오나**를 잰다 — 사람이 읽는 글만 오면 화면에 숫자로 못 세운다.
 *
 * 셋을 본다:
 *   ① 답이 오나 (명령을 모르는 척하지 않나)
 *   ② 글에 **수**가 들어 있나 — 토큰·퍼센트·날짜
 *   ③ `usage_update` 가 같이 오나 — 오면 글을 안 뜯어도 된다
 *
 * ⚠️ **턴을 쓴다** — 에이전트마다 한 번씩. 손으로만 돌린다.
 *
 * `--plain` 은 슬래시 대신 **보통 질문**을 보낸다. ③ 이 «슬래시 턴이라 안 온
 * 것» 인지 «아예 안 오는 것» 인지 가르는 자리다 — 안 오면 컨텍스트 게이지도
 * 압축 버튼도 **영영 안 뜬다**(둘 다 `usage.contextSize` 가 있어야 선다).
 *
 * ```
 * npx tsx tests/probes/quota.mts
 * npx tsx tests/probes/quota.mts claude
 * npx tsx tests/probes/quota.mts claude --plain
 * ```
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import { withInstalled } from "../../src/core/install/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

/** 어느 명령이 «한도» 를 말해줄 법한가 — 광고 목록에서 고른다 */
const WANTED = ["usage", "usage-credits", "status"];
const ROOT = process.env.AIO_AGENT_ROOT
  ?? path.join(os.homedir(), "AppData", "Roaming", "Code", "User",
               "globalStorage", "taein-yoon.ai-in-one");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
/** 슬래시 말고 보통 질문을 보낸다 — `usage_update` 가 오나 보려고 */
const plain = process.argv.includes("--plain");
const nap = (t: number) => new Promise((r) => setTimeout(r, t));
const busy = (s: string) => !["idle", "error"].includes(s);

for (const agent of DEFAULT_AGENTS.map((a) => withInstalled(a, ROOT))
  .filter((a) => !only || a.id === only)) {
  console.log(`\n── ${agent.label ?? agent.id} ─────────────────`);
  if (!agent.command) { console.log("  (안 받았다 — 건너뛴다)"); continue; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-quota-"));
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
    const room = await mgr.createRoom({ title: "한도", bots: [{ agentId: agent.id }] });
    const bot = room.participants[0]!;
    const inner = mgr as unknown as {
      runtimes: { bot(r: string, b: string): { commands?: string[] } };
    };
    let names: string[] = [];
    for (let i = 0; i < 160; i++) {
      names = inner.runtimes.bot(room.id, bot.id).commands ?? [];
      if (names.length > 0) break;
      await nap(250);
    }
    const cmd = plain ? "1 더하기 1은? 숫자만." : WANTED.find((w) => names.includes(w));
    if (!cmd) { console.log(`  ① 그런 명령을 안 판다 (${names.length}개 중)`); }
    else {
      console.log(plain ? `  보통 질문을 보낸다 (광고한 명령 ${names.length}개)` : `  부른다: /${cmd}`);
      const before = room.messages.length;
      await mgr.send(room.id, plain ? cmd : `/${cmd}`, undefined, bot.id);
      for (let i = 0; i < 480; i++) {
        if (!busy(mgr.statusOf(room.id))) break;
        await nap(250);
      }
      const said = room.messages.slice(before)
        .filter((m) => m.role === "agent" && m.text.trim())
        .map((m) => m.text.trim()).join("\n");
      console.log(`  ① 답: ${said ? `${said.length}자` : "(없다)"}`);
      if (said) {
        /* ② 수가 있나 — 토큰·퍼센트·«남음» 꼴을 찾는다 */
        const nums = said.match(/\d[\d,.]*\s*%|\d[\d,.]*\s*(?:k|K|만|천)?\s*토큰|\d[\d,.]*\s*tokens?/g);
        console.log(`  ② 수: ${nums ? nums.slice(0, 6).join(" · ") : "(글만 온다)"}`);
        console.log(said.split("\n").slice(0, 12).map((l) => `     ${l}`).join("\n"));
      }
      /* ③ 구조로도 오나 */
      const u = bot.usage;
      console.log(`  ③ usage_update: ${u?.contextUsed !== undefined
        ? `used ${u.contextUsed} / size ${u.contextSize}${u.cost ? ` · cost ${u.cost.amount}${u.cost.currency}` : " · cost 없음"}`
        : "(안 왔다)"}`);
    }
  } catch (e) {
    console.log(`  터졌다: ${(e as Error).message}`);
  }
  mgr.dispose();
  await store.flush();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);
