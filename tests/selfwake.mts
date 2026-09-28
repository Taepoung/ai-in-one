/**
 * **봇이 스스로 깨어나면 우리가 막지 않나** (2026-09-28).
 *
 * 진짜 CLI 는 **턴이 끝난 뒤에 제 발로 말한다**(`probes/selfwake.cjs` 실측):
 * 백그라운드로 띄운 일이 끝나자, 우리가 아무것도 안 보냈는데 25초 뒤에
 * «출력은 감자칠십칠이고 종료 코드는 0이야» 가 왔다. 턴은 이미 `end_turn`
 * 으로 닫혀 있었다.
 *
 * 그러면 남는 질문은 우리 쪽이다 — **받아서 화면에 얹나, 흘리나.**
 *
 * 🔴 `onIdleEvent` 의 설명에는 *"말과 도구 호출은 여기서 방에 심지 않는다"* 고
 * 적혀 있었는데 **코드는 반대였다.** 글만 읽었으면 «안 되는구나» 하고 딴 데를
 * 팠을 것이다. 그래서 글이 아니라 **동작**으로 못 박는다.
 *
 * ★ **두 경우를 다 고정한다.** 턴이 끝나도 `TURN_TAIL_MS`(1.5초) 동안은 늦게
 * 온 조각을 **그 턴의 꼬리**로 본다 — 응답보다 늦는 조각이 실제로 있어서다.
 * 그 밖이면 **새 말풍선**이다. 둘을 같이 재지 않으면, 유예를 건드렸을 때
 * 한쪽만 깨져도 모른다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (t: number) => new Promise((r) => setTimeout(r, t));

/** `roomManager.ts` 의 `TURN_TAIL_MS` 와 같은 값이어야 한다 */
const TAIL_MS = 1500;
const LATE = "백그라운드 일이 끝났어";

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-wake-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...DEFAULT_AGENTS[0]!, id: "alpha", label: "알파",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
    }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await nap(25);
    }
  };
  return { mgr, settle };
}

async function main(): Promise<void> {
  const { mgr, settle } = await make();

  console.log("\n[★ 유예 **밖**에 온 말은 새 말풍선이 된다]");
  {
    const room = await mgr.createRoom({ agentId: "alpha", title: "백그라운드" });
    await mgr.send(room.id, `오래 걸리는 거 돌려놔줘 [[wake:${TAIL_MS + 1000}]]`);
    await settle(room.id);

    const before = room.messages.filter((m) => m.role === "agent").length;
    ok(mgr.statusOf(room.id) === "idle", "★ 턴은 끝났다 — 여기서부터가 «턴 밖»이다");

    // 아무것도 안 보내고 기다린다 — 진짜 CLI 에서 일어난 그대로
    await nap(TAIL_MS + 2000);

    const after = room.messages.filter((m) => m.role === "agent");
    const woke = after.find((m) => m.text.includes(LATE));
    console.log(`   말풍선 ${before} → ${after.length} · 늦게 온 말: «${woke?.text ?? "(없음)"}»`);

    ok(woke !== undefined,
       "★ **턴 밖 발화를 방에 심는다** — 흘리면 «CLI가 준 걸 우리가 숨긴» 것이 된다 (§0 P5)");
    ok(after.length === before + 1,
       `★ **새 말풍선으로** 뜬다 (${before} → ${after.length}) — 한참 전 말풍선에 이어 붙이면 시각이 거짓말을 한다`);
    ok(woke!.text === LATE,
       `★ 앞 턴의 말이 안 섞인다 («${woke!.text}»)`);
    ok(woke!.authorBotId === room.participants[0]!.id,
       "★ 누가 한 말인지도 붙는다 — 단체방에서 이게 없으면 익명이 된다");
  }

  console.log("\n[★ 유예 **안**에 온 조각은 그 턴의 꼬리다]");
  {
    /*
     * 응답(`session/prompt` 의 반환)보다 **늦게 오는 조각이 실제로 있다.**
     * 그걸 새 말풍선으로 만들면 한 턴의 답이 둘로 쪼개져 보인다. 그래서
     * 1.5초는 «아직 그 턴»으로 본다 — 이건 버그가 아니라 규칙이다.
     */
    const room = await mgr.createRoom({ agentId: "alpha", title: "꼬리" });
    await mgr.send(room.id, "짧은 거 [[wake:300]]");
    await settle(room.id);
    await nap(TAIL_MS + 800);

    const agents = room.messages.filter((m) => m.role === "agent");
    console.log(`   말풍선 ${agents.length}개 · «${agents.map((m) => m.text).join(" | ")}»`);
    ok(agents.length === 1,
       `★ **쪼개지지 않는다** (${agents.length}개) — 유예 안의 조각은 같은 답이다`);
    ok(agents[0]!.text.includes(LATE),
       "★ 그래도 내용은 들어 있다 — 버리는 게 아니라 이어 붙이는 것");
  }

  mgr.dispose();
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
