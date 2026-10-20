/**
 * **방을 나가면 «모든» 봇의 세션이 정리되나** (2026-09-23).
 *
 * `leaveRoom` 은 v1.0 에 쓴 코드다. 그때는 방에 봇이 하나뿐이라 «그 세션»을
 * 지우면 끝이었다. v2.0 에서 봇이 여럿이 됐는데 **이 길을 다시 안 봤다.**
 *
 * 남는 것이 있으면 사용자는 우리 앱에서 방을 지웠는데 **claude 쪽에는 대화가
 * 그대로 있는** 것을 보게 된다. 실측으로 `session/delete` 는 대화를 진짜로
 * 비우고 `claude --resume` 도 막는다는 것까지 확인했으므로(`delsess2.cjs`),
 * 남은 질문은 하나다 — **우리가 봇마다 그걸 부르고 있나.**
 *
 * 🔴 **개수만 세면 안 된다.** `close` 는 *"frees up resources"* 일 뿐이라
 * 디스크에 대화가 그대로 남는다. «다 정리된 것처럼 보이고 실은 남아 있는»
 * 경우를 놓치지 않으려면 **어느 쪽으로 놓았는지**까지 봐야 한다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

type Ev = { t: string; sessionId?: string };

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-leaveall-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파" },
      { ...base, id: "beta", label: "베타" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const events = async (): Promise<Ev[]> => {
    try {
      const raw = await fs.readFile(state, "utf8");
      return raw.split(NL).filter(Boolean).map((l) => JSON.parse(l) as Ev);
    } catch { return []; }
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { dir, mgr, events, settle };
}

async function main(): Promise<void> {
  const { mgr, events, settle } = await make();

  console.log("\n[★ 단체방을 나가면 «두» 세션이 다 정리되나]");
  const room = await mgr.createRoom({
    title: "둘이 있는 방",
    bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
  });
  /*
   * 대화가 있어야 delete 가 의미를 갖는다 — 빈 세션은 애초에 디스크에 없다(실측).
   * **봇마다 따로** 건다 — 멘션 문자열로 묶으면 이 검사의 전제(«둘 다 말을 겁다»)가
   * 멘션 파서에 달려버려서, 정작 재려는 것을 못 재게 된다.
   */
  for (const b of room.participants) {
    await mgr.send(room.id, `${b.name}아 안녕`, undefined, b.id);
    await settle(room.id);
  }

  const before = await events();
  const opened = before.filter((e) => e.t === "new").map((e) => e.sessionId!);
  const prompted = new Set(before.filter((e) => e.t === "prompt").map((e) => e.sessionId!));
  console.log(`   열린 세션 ${opened.length}개: ${opened.join(", ")}`);
  console.log(`   말을 건 세션 ${prompted.size}개: ${[...prompted].join(", ") || "없음"}`);
  ok(opened.length === 2, "★ 봇마다 세션이 하나씩 — v2.2 의 전제 (§6)");
  ok(prompted.size === 2, "★ 둘 다 말을 걸었다 — 그래야 «지울 것»이 둘 다 있다");

  await mgr.leaveRoom(room.id);
  await new Promise((r) => setTimeout(r, 400));

  const closed = (await events()).filter((e) => e.t === "delete" || e.t === "close");
  const touched = new Set(closed.map((e) => e.sessionId!));
  const deleted = new Set(closed.filter((e) => e.t === "delete").map((e) => e.sessionId!));
  console.log(`   정리 내역: ${closed.map((e) => `${e.t}:${e.sessionId}`).join(" · ") || "없음"}`);

  const missed = opened.filter((s) => !touched.has(s));
  ok(missed.length === 0,
     missed.length === 0
       ? "★ **모든 봇의 세션을 놓는다** — 첫 봇만 지우던 것을 고쳤다"
       : `🔴 **${missed.length}개가 손도 안 탄다** (${missed.join(", ")})`);

  /*
   * ★ **어느 쪽으로 놓았는지까지 본다.**
   *
   * 말을 건 세션은 `delete` 여야 한다. `close` 로 놓으면 «정리했다»는 기록은
   * 남는데 **디스크의 대화는 그대로**라, 개수만 세는 검사는 이걸 통과시킨다.
   */
  const wrongly = [...prompted].filter((s) => !deleted.has(s));
  ok(wrongly.length === 0,
     wrongly.length === 0
       ? "★ **말을 건 세션은 `delete`** — close 는 디스크에 대화를 남긴다"
       : `🔴 **말을 건 세션을 close 로 놓았다** (${wrongly.join(", ")}) — 파일이 남는다`);

  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
