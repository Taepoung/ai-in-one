/**
 * **방은 서로 독립인가.**
 *
 * 같은 에이전트의 방 둘은 **프로세스를 공유하고 세션만 다르다**(A4·B1).
 * 그래서 «에이전트 단위로 들고 있는 것»과 «방 단위로 들고 있어야 하는 것»을
 * 헷갈리면 **한 방의 상태가 옆방에 샌다.** 실제로 그렇게 샜던 적이 있다 —
 * 설정 캐시가 에이전트별 하나였고, 압축 id를 방 없이 기억했다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { createBotInstance } from "../src/core/types.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { Message, Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const cur = (o: Array<{ category?: string; currentValue?: unknown }>, c: string) =>
  o.find((x) => x.category === c)?.currentValue;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-iso-"));
  const store = new RoomStore(dir); await store.init();
  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")], env: {},
  };
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    askUser: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
  mgr.on("roomError", () => {});
  const inner = mgr as unknown as {
    open: Map<string, Room>;
    applyEvent(r: Room, m: Message, ev: unknown): void;
    connections: Map<string, unknown>;
  };

  // **같은 에이전트**의 방 둘 — 여기가 제일 새기 쉽다
  const A = await mgr.createRoom({ agentId: "fake", title: "방 A" });
  const B = await mgr.createRoom({ agentId: "fake", title: "방 B" });

  console.log("\n[프로세스는 하나, 세션은 둘 (A4·B1)]");
  {
    ok(inner.connections.size === 1, "CLI 프로세스는 하나만 뜬다");
    ok(A.participants[0]!.sessionId !== B.participants[0]!.sessionId,
       "**세션은 방마다 다르다** — 대화가 섞이지 않는 근거");
  }

  console.log("\n[설정 — 한쪽을 바꿔도 옆방은 그대로]");
  {
    await mgr.setConfig(A.id, "mode", "plan");
    await mgr.setConfig(A.id, "model", "sonnet");
    ok(cur(await mgr.roomConfigOptions(A.id), "mode") === "plan", "A는 계획 모드");
    ok(cur(await mgr.roomConfigOptions(B.id), "mode") === "default", "**B는 기본값 그대로**");
    ok(cur(await mgr.roomConfigOptions(B.id), "model") === "opus", "모델도 안 옮는다");

    ok(A.participants[0]!.agentMode === "plan" && B.participants[0]!.agentMode !== "plan",
       "봇에 남는 값도 따로");
  }

  console.log("\n[자리 비움 — 방마다 따로 (D2·D5)]");
  {
    // 세션으로 읽던 `answerPolicyForSession` 은 없앴다(ROADMAP §D4) — 봇에서 읽는다
    await mgr.setPolicy(A.id, { answerPolicy: "auto" });
    const policyOf = (r: Room) => r.participants[0]!.answerPolicy;
    ok(policyOf(A) === "auto", "A는 자율");
    ok(policyOf(B) === "ask", "**B는 여전히 물어본다**");
  }

  console.log("\n[상태·미읽음·초안]");
  {
    const setStatus = (mgr as unknown as { setStatus(id: string, s: string): void }).setStatus;
    setStatus.call(mgr, A.id, "streaming");
    ok(mgr.statusOf(A.id) === "streaming" && mgr.statusOf(B.id) === "idle", "작업 중 표시는 방마다");

    mgr.setDraft(A.id, "A에 쓰던 글");
    await mgr.flushDraft();
    ok(inner.open.get(A.id)!.draft === "A에 쓰던 글", "A에 초안이 남고");
    ok(inner.open.get(B.id)!.draft === undefined, "**B는 비어 있다**");
    setStatus.call(mgr, A.id, "idle");
  }

  console.log("\n[압축 — `compactionId`는 세션 안에서만 유일하다]");
  {
    const reply = (id: string): Message =>
      ({ id, role: "agent", text: "", deliveredTo: [], createdAt: 1 });
    const roomA = inner.open.get(A.id)!;
    const roomB = inner.open.get(B.id)!;

    // 두 방이 **같은 id**를 쓴다 — 실제로 일어날 수 있는 일이다
    inner.applyEvent(roomA, reply("x"), {
      type: "compaction", id: "c1", status: "completed", summary: "A의 요약",
    });
    inner.applyEvent(roomB, reply("y"), {
      type: "compaction", id: "c1", status: "completed", summary: "B의 요약",
    });

    const cutA = roomA.messages.filter((m) => m.mark === "compaction");
    const cutB = roomB.messages.filter((m) => m.mark === "compaction");
    ok(cutA.length === 1, "A에 선이 그어진다");
    ok(cutB.length === 1, "**B에도 그어진다** — id가 같다고 삼키면 안 된다");
    ok(cutA[0]!.summary === "A의 요약" && cutB[0]!.summary === "B의 요약",
       "**요약도 각자 것** — 섞이면 엉뚱한 맥락이 되먹여진다");
  }

  console.log("\n[되먹임 약속도 방마다]");
  {
    inner.open.get(A.id)!.contextLost = true;
    await mgr.decideRefeed(A.id, true);
    ok(inner.open.get(A.id)!.refeedPending === true, "A는 되먹인다");
    ok(inner.open.get(B.id)!.refeedPending !== true, "**B는 아무 약속도 안 했다**");
  }

  console.log("\n[트랜스크립트도 섞이지 않는다]");
  {
    const roomA = inner.open.get(A.id)!;
    const msg: Message = { id: "only-a", role: "user", text: "A에만", deliveredTo: [], createdAt: 9 };
    roomA.messages.push(msg);
    await store.appendMessage(roomA, msg);

    const fresh = new RoomStore(dir); await fresh.init();
    ok((await fresh.loadRoom(A.id))!.messages.some((m) => m.id === "only-a"), "A에 남고");
    ok(!(await fresh.loadRoom(B.id))!.messages.some((m) => m.id === "only-a"), "**B에는 없다**");
  }

  console.log("\n[한 방을 나가도 옆방은 멀쩡하다]");
  {
    await mgr.leaveRoom(B.id);
    ok(mgr.listMetas().some((m) => m.id === A.id), "A는 목록에 남고");
    ok(!mgr.listMetas().some((m) => m.id === B.id), "B만 사라진다");
    ok(cur(await mgr.roomConfigOptions(A.id), "mode") === "plan",
       "**A의 설정도 그대로** — 옆방 정리에 휘말리지 않는다");
  }

  console.log("\n[봇이 둘인 방 — v2.0이 올라설 자리 (B1)]");
  {
    // 지금은 화면이 봇을 하나만 만들지만, **밑바닥은 이미 여럿을 감당한다.**
    const two = await mgr.createRoom({ agentId: "fake", title: "둘인 방" });
    const roomTwo = inner.open.get(two.id)!;
    const second = createBotInstance(agent, { agentMode: "default" });
    second.name = "둘째";
    roomTwo.participants.push(second);

    await mgr.setActiveRoom(null);
    await mgr.setActiveRoom(two.id);
    // 붙이기는 화면을 막지 않으려고 백그라운드로 돈다 — 끝날 때까지 기다린다
    await mgr.roomConfigOptions(two.id, second.id);

    const rts = (mgr as unknown as {
      runtimes: Map<string, { bots: Map<string, { sessionId?: string }> }>;
    }).runtimes.get(two.id)!;

    ok(rts.bots.size === 2, `**봇마다 런타임이 생긴다** (${rts.bots.size})`);
    const ids = roomTwo.participants.map((b) => rts.bots.get(b.id)?.sessionId);
    ok(ids.every(Boolean), "**둘 다 세션이 붙었다**");
    ok(ids[0] !== ids[1], "**세션은 서로 다르다** — 대화가 안 섞인다");

    await mgr.setConfig(two.id, "mode", "plan");
    ok(cur(await mgr.roomConfigOptions(two.id, roomTwo.participants[0]!.id), "mode") === "plan",
       "첫 봇만 계획 모드");
    ok(cur(await mgr.roomConfigOptions(two.id, second.id), "mode") === "default",
       "**같은 방 안에서도 봇끼리 안 샐다**");

    ok(mgr.listMetas().find((m) => m.id === two.id)!.agentIds.length === 2,
       "목록도 둘을 안다");
  }

  mgr.dispose();
  await new Promise((r) => setTimeout(r, 120));
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log("\n전부 통과\n");
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
