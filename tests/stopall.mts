/**
 * **전체 중지 — 중지는 이것 하나다** (v3.0 1-D · C6).
 *
 * ⏪ 한때 넷이었다: 방 전체 중단 · 봇 하나만 중단 · 끼어들기 · 줄에서 빼기.
 * 넷을 다 두면 **각각이 MCP 큐·권한 대기·심사 줄과 어떤 관계인지 따로
 * 정의해야 한다** — v3.0 에서 그게 열여섯 가지 조합이 된다. 하나면 한 번만
 * 정하면 되고, 사용자도 «무엇이 멈추는지»를 한 번만 배우면 된다.
 *
 * ```
 * 멈춘다    도는 턴 전부 · 줄 서 있던 것 전부
 * 정리한다  심사 줄 · 떠 있던 승인 카드 — cancelled 로 답하고 거둔다
 * 내린다    «무조건 허용» → «물어봄»
 * 남긴다    말풍선 · 내 말은 «안 갔다»+↻ · 그리고 **왜 끊겼는지 한 줄**
 * ```
 *
 * 마지막 줄이 특히 중요하다. `session/cancel` 은 **«왜»를 안 남긴다**(진짜
 * CLI 로 실측 2026-09-23). 그 빈칸을 모델이 추측으로 메우는데 판마다 다르고,
 * 한 판은 «권한이 거부돼서»라고 지어냈다 — 그러면 우회를 시도하거나 «권한을
 * 열어달라»는 엉뚱한 말을 한다. ⏪ 원래 끼어들기가 지키던 자리인데, 끼어들기를
 * 없앴다고 **이 한 줄까지 같이 버리면 안 된다.**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

/** 「도는 중」 — 화면이 쓰는 것과 같은 잣대 */
const busy = (s: string) => !["idle", "error"].includes(s);

async function make(hold: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-stop-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: String(hold), AIO_FAKE_STATE: state },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파" },
      { ...base, id: "beta", label: "베타" },
      { ...base, id: "gamma", label: "감마" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const prompts = async (): Promise<Array<{ text: string }>> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; text: string })
        .filter((e) => e.t === "prompt");
    } catch { return []; }
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (!busy(mgr.statusOf(id))) return;
      await nap(25);
    }
  };
  /** 조건이 설 때까지 기다린다 — 시간으로 재면 느린 기계에서 흔들린다 */
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (cond()) return true;
      await nap(20);
    }
    return cond();
  };
  return { dir, mgr, prompts, settle, until };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 방이 통째로 멈춘다 — 봇을 지목하지 않는다]`);
  {
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "전부", bots: [{ agentId: "alpha" }, { agentId: "beta" }, { agentId: "gamma" }],
    });
    const ids = room.participants.map((b) => b.id);
    for (const id of ids) void mgr.send(room.id, "오래 걸리는 일", undefined, id);

    ok(await until(() => ids.every((id) => busy(mgr.statusOf(room.id, id)))),
       "셋 다 돌고 있다");

    await mgr.stopAll(room.id);
    await settle(room.id);
    ok(ids.every((id) => !busy(mgr.statusOf(room.id, id))),
       "★ **한 번에 셋 다 멈춘다** — 봇마다 눌러야 하면 병렬의 뜻이 없다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 올려둔 것도 같이 내린다 (v3.0 1-E)]`);
  {
    /*
     * ⏪ 여기서 «줄에 있던 것을 안 갔다로 적는다»를 쟀다. 줄을 없앴으니
     * (1-E) 적을 것도 없다 — 대신 **예약 칸**이 그 자리를 잇는다.
     *
     * 🔴 남겨두면 **중지한 뒤에 뜬금없이 한 마디가 나간다.** 멈추라고
     * 눌렀는데 10분 뒤에 말이 나가면 «이게 왜 나가?»가 된다.
     */
    const { dir, mgr, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "예약" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "첫 일");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    await mgr.stage(room.id, [{ kind: "text", text: "중지 뒤에 나가면 안 되는 글" }]);
    ok(room.staged !== undefined, "올려뒀다");

    await mgr.stopAll(room.id);
    await settle(room.id);

    ok(room.staged === undefined, "★ **올려둔 것도 내려간다**");
    ok(!room.messages.some((m) => m.text.includes("나가면 안 되는")),
       "★ **자국도 없다** — 아무도 못 본 글이다 (§0)");
    mgr.dispose();
  }

  console.log(`${NL}[★ 왜 끊겼는지를 다음 프롬프트에 적어준다]`);
  {
    const { dir, mgr, prompts, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "설명" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래 걸리는 일");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    await mgr.stopAll(room.id);
    await settle(room.id);

    await mgr.send(room.id, "이거 먼저");
    await settle(room.id);

    const last = (await prompts()).at(-1)!;
    /*
     * 🔴 `session/cancel` 은 **«왜»를 안 남긴다**(실측). 그 빈칸을 모델이
     * 추측으로 메우는데 판마다 다르고, 한 판은 «권한이 거부돼서»라고
     * 지어냈다 — 그러면 우회를 시도한다.
     */
    ok(last.text.includes("중단했습니다"),
       "★ **빈칸을 우리가 채운다** — 안 채우면 모델이 지어낸다");
    ok(last.text.includes("권한 거부나 오류가 아닙니다"),
       "★ **제일 흔한 오해를 콕 집어 막는다**");
    ok(last.text.includes("이거 먼저"), "★ 그리고 진짜 요청이 뒤에 온다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 한 번만 얹는다 — 다음 턴에는 안 붙는다]`);
  {
    const { dir, mgr, prompts, settle, until } = await make(3000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "한 번" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    await mgr.stopAll(room.id);
    await settle(room.id);

    await mgr.send(room.id, "중지 뒤 첫 말");
    await settle(room.id);
    await mgr.send(room.id, "그 다음 평범한 말");
    await settle(room.id);

    const cut = (await prompts()).filter((p) => p.text.includes("중단했습니다"));
    ok(cut.length === 1,
       `★ **끊긴 그 턴에만** (${cut.length}개) — 매번 붙으면 노이즈이고 거짓이다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 안 돌던 봇에는 «끊겼다»를 안 적는다]`);
  {
    /*
     * 🔴 멈출 것이 없던 봇에게까지 «중단했습니다»를 얹으면 **거짓말**이다 —
     * 그 봇은 하던 일이 없었고, 다음 말 앞에 «하다 말았다»가 붙으면 모델이
     * 있지도 않은 앞 작업을 가리킨다.
     */
    const { dir, mgr, prompts, settle } = await make(100); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "조용" });

    await mgr.send(room.id, "짧은 일");
    await settle(room.id);
    await mgr.stopAll(room.id);        // 아무도 안 돌고 있다
    await mgr.send(room.id, "그 다음");
    await settle(room.id);

    const cut = (await prompts()).filter((p) => p.text.includes("중단했습니다"));
    ok(cut.length === 0, `★ **한 줄도 안 붙는다** (${cut.length}개)`);
    mgr.dispose();
  }

  console.log(`${NL}[★ «무조건 허용»을 내린다 — 안 내리면 «잠깐 멈춤»이다]`);
  {
    const { dir, mgr, settle } = await make(100); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "맡김", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.setPolicy(room.id, { answerPolicy: "auto" }, a!.id);
    ok(a!.answerPolicy === "auto", "맡겨둔 상태로 만들었다");

    await mgr.stopAll(room.id);
    await settle(room.id);

    ok(a!.answerPolicy === "ask",
       "★ **내려온다** — 안 내리면 다음 말 한 마디에 같은 자리로 돌아간다");
    ok(b!.answerPolicy === "ask", "원래 «물어봄»이던 봇은 그대로");
    // 🔴 사용자가 켠 것을 우리가 껐으면 **적어야 한다** (§0)
    const said = room.messages.filter(
      (m) => m.role === "system" && m.text.includes("무조건 허용"),
    );
    ok(said.length === 1, `★ **조용히 바꾸지 않는다** (${said.length}줄) — 안 적으면 «왜 또 묻지»가 된다`);
    mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await nap(200); }
    }
  }
  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
