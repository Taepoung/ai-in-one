/**
 * **루프모드** (사용자, 2026-10-20).
 *
 * ```
 * 방이 조용해진다 → 2초 → «종료» 안 한 루프 봇에게만 다시 묻는다 → «종료» 면 빠진다
 * 상한(loopCap) — 기본 10 · 0 이면 제한 없음 · 사용자가 새로 말하면 처음부터
 * 보내기 직전에 본다 — 도는 봇 · 턴 꼬리 · 큐 · 예약이 하나라도 있으면 안 보낸다
 * ```
 *
 * 그리고 같이 고친 것: **슬래시 명령은 단독으로** 나간다 — 단체방의 [압축] 이 앞의
 * 깃발 줄 때문에 명령이 아니게 되던 것.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";
import { DEFAULT_LOOP_CAP, isBusy, type Room } from "../src/core/types.js";

const isBusyNow = (s: Parameters<typeof isBusy>[0]) => isBusy(s) === true;

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

type Env = Record<string, string>;

async function make(envs: Env[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-loop-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const states = envs.map((_, i) => path.join(dir, `fake${i}.jsonl`));
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: envs.map((env, i) => ({
      ...base, id: `a${i}`, label: `에이${i}`,
      env: { AIO_FAKE_HOLD: "20", AIO_FAKE_STATE: states[i]!, ...env },
    })),
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const room = await mgr.createRoom({
    title: "루프", bots: envs.map((_, i) => ({ agentId: `a${i}`, name: ["알파", "베타"][i]! })),
  });
  const prompts = async (i: number) =>
    (await fs.readFile(states[i]!, "utf8").catch(() => "")).split(NL).filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; text?: string }).filter((e) => e.t === "prompt");
  const asked = async (i: number) => (await prompts(i)).filter((p) => (p.text ?? "").includes("[ai-in-one 루프]")).length;
  const notes = (re: RegExp) => room.messages.filter((m) => m.role === "system" && re.test(m.text));
  /** 사용자가 그 봇에게 말한다 */
  const say = async (i: number, text: string) => {
    await mgr.sendCompose(room.id, [{ kind: "mention", botId: room.participants[i]!.id }, { kind: "text", text: " " + text }]);
  };
  const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
    for (let t = 0; t < ms; t += 50) { if (await cond()) return true; await nap(50); }
    return false;
  };
  return { dir, mgr, room, prompts, asked, notes, say, until };
}

const done = async (t: { mgr: RoomManager; dir: string }) => {
  t.mgr.dispose(); await nap(100);
  await fs.rm(t.dir, { recursive: true, force: true }).catch(() => {});
};

async function main(): Promise<void> {
  console.log(`${NL}[★ «종료» 하면 빠지고, 끝났다고 한 줄 남긴다]`);
  {
    const t = await make([{ AIO_FAKE_LOOP_DONE_AT: "2" }]);
    const bot = t.room.participants[0]!;
    await t.mgr.setPolicy(t.room.id, { answerPolicy: "auto" }, bot.id);
    await t.say(0, "일 해줘");
    ok(await t.until(() => t.notes(/모두 «종료»/).length === 1, 15000), "★ 끝났다고 남긴다");
    ok(await t.asked(0) === 2, `★ **두 번 물었다** — 둘째에 «종료» (${await t.asked(0)})`);
    ok(t.notes(/루프 — 알파에게 다시 물었습니다/).length === 2, "★ 물을 때마다 한 줄씩 남긴다");
    ok(!t.room.messages.some((m) => m.role === "user" && m.text.includes("ai-in-one 루프")),
       "★ **사용자가 한 말인 척 안 한다** — 묻는 말은 대화에 사용자 말풍선으로 안 남는다");
    await nap(3000);
    ok(await t.asked(0) === 2, "★ «종료» 한 뒤에는 더 안 묻는다");

    // 사용자가 새로 말을 걸면 처음부터 — 새 일이 생겼다
    await t.say(0, "하나 더");
    ok(await t.until(async () => (await t.asked(0)) >= 3, 8000), "★ **새로 말하면 다시 돈다**");
    await done(t);
  }

  console.log(`${NL}[★ 상한 — 끝내 «종료» 를 안 해도 멈춘다]`);
  {
    const t = await make([{}]);
    const bot = t.room.participants[0]!;
    await t.mgr.setLoopCap(t.room.id, 2);
    await t.mgr.setPolicy(t.room.id, { answerPolicy: "auto" }, bot.id);
    await t.say(0, "일 해줘");
    ok(await t.until(() => t.notes(/2번 다시 물어 멈췄습니다/).length === 1, 15000),
       "★ **상한에서 멈추고 그렇다고 남긴다**");
    await nap(3000);
    ok(await t.asked(0) === 2, `★ 상한만큼만 물었다 (${await t.asked(0)})`);
    await done(t);
  }

  console.log(`${NL}[★ 0 이면 제한 없음 — 기본 상한을 넘어간다]`);
  {
    const over = DEFAULT_LOOP_CAP + 1;
    const t = await make([{ AIO_FAKE_LOOP_DONE_AT: String(over) }]);
    const bot = t.room.participants[0]!;
    await t.mgr.setLoopCap(t.room.id, 0);
    await t.mgr.setPolicy(t.room.id, { answerPolicy: "auto" }, bot.id);
    await t.say(0, "일 해줘");
    ok(await t.until(() => t.notes(/모두 «종료»/).length === 1, 60000),
       `★ **기본 상한(${DEFAULT_LOOP_CAP})을 넘어** ${over}번째에 «종료» 할 때까지 묻는다`);
    ok(await t.asked(0) === over, `★ ${over}번 (${await t.asked(0)})`);
    await done(t);
  }

  console.log(`${NL}[★ 이번 일에 낀 봇만 — 사용자가 안 부른 봇은 안 깨운다 (2026-10-21)]`);
  {
    /*
     * 사용자: *"지금 내가 한 봇만 불렀는데 루프가 다른 봇한테서도 돌아"*. 둘 다 루프모드를
     * 켜 두고 알파만 부른다 — 베타는 이번 일에 안 꼈으니 다시 묻지 않는다.
     */
    const t = await make([{ AIO_FAKE_LOOP_DONE_AT: "1" }, { AIO_FAKE_LOOP_DONE_AT: "1" }]);
    const [a, b] = t.room.participants as [Room["participants"][0], Room["participants"][0]];
    await t.mgr.setPolicy(t.room.id, { answerPolicy: "auto" }, a.id);
    await t.mgr.setPolicy(t.room.id, { answerPolicy: "auto" }, b.id);
    await t.say(0, "일 해줘");
    ok(await t.until(() => t.notes(/모두 «종료»/).length === 1, 15000), "★ 알파가 «종료» 해 끝났다");
    ok(await t.asked(0) === 1, `★ 부른 알파에게는 다시 묻는다 (${await t.asked(0)})`);
    ok(await t.asked(1) === 0, `★ 🔴 **안 부른 베타에게는 안 묻는다** (${await t.asked(1)})`);
    ok(!t.notes(/다시 물었습니다/).some((m) => m.text.includes("베타")), "★ 방에 남는 줄에도 베타가 없다");

    // 다음 말에서 베타를 부르면 이번엔 베타가 낀다
    await t.say(1, "이번엔 너");
    ok(await t.until(async () => (await t.asked(1)) === 1, 10000), "★ 베타를 부르면 그때 베타에게 묻는다");
    await done(t);
  }

  console.log(`${NL}[★ 끄면 안 묻는다]`);
  {
    const t = await make([{}]);
    await t.say(0, "일 해줘");
    await nap(4000);
    ok(await t.asked(0) === 0, "★ 루프모드가 아닌 봇에게는 다시 묻지 않는다");
    await done(t);
  }

  console.log(`${NL}[★ 다른 봇이 도는 동안은 안 묻는다 — 보내기 직전에 본다]`);
  {
    // 알파(루프)는 금방 끝나고, 베타(루프 아님)는 6초 동안 답한다
    const t = await make([{ AIO_FAKE_LOOP_DONE_AT: "1" }, { AIO_FAKE_HOLD: "6000" }]);
    const [a, b] = t.room.participants as [Room["participants"][0], Room["participants"][0]];
    await t.mgr.setPolicy(t.room.id, { answerPolicy: "auto" }, a.id);
    // 🔴 기다리지 않는다 — sendCompose 는 **두 턴이 다 끝날 때까지** 돌아오지 않는다
    void t.mgr.sendCompose(t.room.id, [
      { kind: "mention", botId: a.id }, { kind: "mention", botId: b.id }, { kind: "text", text: " 둘 다 해줘" },
    ]);
    await nap(4000);
    ok(isBusyNow(t.mgr.statusOf(t.room.id, b.id)), `전제 — 베타는 아직 돈다 (${t.mgr.statusOf(t.room.id, b.id)})`);
    ok(await t.asked(0) === 0, "★ **베타가 아직 도는 동안은 알파에게 안 묻는다** — 방이 조용하지 않다");
    ok(await t.until(async () => (await t.asked(0)) === 1, 12000), "★ 베타가 끝난 뒤에 묻는다");
    await done(t);
  }

  console.log(`${NL}[★ 슬래시 명령은 단독으로 — 단체방의 압축]`);
  {
    const t = await make([{}, {}]);
    const bot = t.room.participants[0]!;
    await t.say(0, "안녕");
    await t.until(() => t.mgr.statusOf(t.room.id) === "idle", 5000);
    await nap(300);
    await t.mgr.compact(t.room.id, bot.id);
    ok(await t.until(async () => (await t.prompts(0)).some((p) => (p.text ?? "").includes("compact")), 5000),
       "전제 — 압축이 나갔다");
    const sent = (await t.prompts(0)).map((p) => p.text ?? "").find((x) => x.includes("compact"))!;
    ok(sent === "/compact", `★ **명령이 맨 앞** — 앞에 깃발 줄이 안 붙는다 (${JSON.stringify(sent)})`);
    // 미뤄 둔 깃발은 다음 일반 턴에 그대로 간다
    await t.say(0, "다음 일");
    ok(await t.until(async () => (await t.prompts(0)).some((p) => (p.text ?? "").includes("[ai-in-one]")
       && (p.text ?? "").includes("다음 일")), 5000), "★ 일반 턴에는 깃발이 그대로 붙는다");
    await done(t);
  }

  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
