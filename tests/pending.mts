/**
 * **승인을 기다리는 동안 무엇이 멈춰 있나** (D1 · §4.3).
 *
 * `session/request_permission` 은 **블로킹 요청**이다 — 우리가 답할 때까지
 * 그 에이전트의 턴은 정말로 멈춘다. 그런데 화면은 그동안 뭐라고 말하는가?
 *
 * 재는 것:
 *   1. 멈춰 있는 동안 **방/봇 상태**가 무엇인가
 *   2. 쓰다 만 말풍선이 어떤 꼴인가 (`streaming`)
 *   3. **다른 봇은 계속 도는가** (§4.3 — 방 단위 병렬)
 *   4. 사용자가 그 사이에 **보낼 수 있는가**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { PermissionDecision, PermissionRequest } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-pend-"));
  const store = new RoomStore(dir); await store.init();

  /** 승인 카드가 뜨면 여기에 잡힌다. `answer()` 를 불러야 풀린다 */
  let held: ((d: PermissionDecision) => void) | undefined;
  let asked: PermissionRequest | undefined;
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: (req) => {
      asked = req;
      return new Promise<PermissionDecision>((r) => { held = r; });
    },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      { ...base, id: "beta", label: "베타", env: {} },
    ],
  });
  const statuses: string[] = [];
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  mgr.on("status", (_i: string, s: string) => statuses.push(s));

  const room = await mgr.createRoom({
    title: "대기", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
  });
  const settle = async () => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(room.id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return {
    dir, mgr, room, settle, statuses,
    a: room.participants[0]!, b: room.participants[1]!,
    waitCard: async () => {
      for (let i = 0; i < 400; i++) {
        if (held) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("승인 카드가 안 떴다");
    },
    answer: (optionId: string) => { held?.({ outcome: "selected", optionId }); held = undefined; },
    asked: () => asked,
  };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 승인을 기다리는 동안 — 그 봇은 정말 멈춰 있다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const turn = t.mgr.send(t.room.id, "[[ask:파일 고치기]] 해줘", undefined, t.a.id);
    await t.waitCard();

    ok(t.asked()?.title === "파일 고치기", "★ 승인 카드가 떴다");

    const mine = t.room.messages.find((m) => m.text.includes("[[ask:"))!;
    const reply = t.room.messages.find(
      (m) => m.role === "agent" && (m.replyToIds ?? []).includes(mine.id),
    )!;
    console.log(`     그때 봇 상태 : ${t.mgr.statusOf(t.room.id, t.a.id)}`);
    console.log(`     그때 방 상태 : ${t.mgr.statusOf(t.room.id)}`);
    console.log(`     쓰다 만 말풍선: streaming=${reply.streaming} · ${JSON.stringify(reply.text)}`);

    ok(reply.streaming === true,
       "★ **말풍선은 «쓰는 중»인 채로 멈춰 있다** — 실제로 그 턴은 안 끝났다");

    // ★ 여기가 핵심 질문이다
    ok(t.mgr.statusOf(t.room.id, t.a.id) === "permission",
       `★ **«권한 대기»라고 말한다** — 아니면 화면이 «답하는 중»이라고 거짓말한다 («${t.mgr.statusOf(t.room.id, t.a.id)}»)`);

    t.answer("y");
    await turn;
    await t.settle();
    ok(reply.text.includes("답은 y"), "★ 답하면 이어서 쓴다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 다른 봇은 계속 돈다 — 방이 통째로 멈추지 않는다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const blocked = t.mgr.send(t.room.id, "[[ask:멈춤]] 해줘", undefined, t.a.id);
    await t.waitCard();

    // 승인이 걸려 있는 동안 **다른 봇**에게 말을 건다
    await t.mgr.send(t.room.id, "너는 계속해", undefined, t.b.id);
    const his = t.room.messages.find((m) => m.text === "너는 계속해")!;
    const hisReply = t.room.messages.find(
      (m) => m.role === "agent" && (m.replyToIds ?? []).includes(his.id),
    );
    ok(hisReply !== undefined && hisReply.streaming !== true,
       "★ **베타는 멀쩡히 답했다** — 턴은 방 단위로 병렬이다(§4.3)");

    t.answer("n");
    await blocked; await t.settle();
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 사용자는 그 사이에도 보낼 수 있다 — 줄에 선다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const blocked = t.mgr.send(t.room.id, "[[ask:멈춤]] 해줘", undefined, t.a.id);
    await t.waitCard();

    const later = t.mgr.send(t.room.id, "이것도 해줘", undefined, t.a.id);
    await new Promise((r) => setTimeout(r, 200));
    const q = t.mgr.queuedIds(t.room.id);
    ok(q[t.a.id]?.length === 1,
       `★ **막히지 않고 줄에 선다** (${JSON.stringify(q)}) — 입력창이 얼어붙지 않는다`);

    t.answer("y");
    await Promise.all([blocked, later]);
    await t.settle();
    ok(t.mgr.queuedIds(t.room.id)[t.a.id] === undefined, "★ 풀리면 줄도 나간다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 답한 것은 «그 활동»에 접혀 들어간다 — 대화를 안 더럽힌다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const turn = t.mgr.send(t.room.id, "[[ask:파일 고치기]] 해줘", undefined, t.a.id);
    await t.waitCard();
    t.answer("y");
    await turn; await t.settle();

    const kinds = t.room.messages.map((m) => `${m.role}:${m.text.slice(0, 18)}`);
    console.log(`     대화: ${JSON.stringify(kinds)}`);

    ok(!t.room.messages.some((m) => m.role === "system" && m.text.includes("파일 고치기")),
       "★ **시스템 줄이 안 쌓인다** — 스무 번 물으면 읽을 내 대화가 묻힌다");

    const act = t.room.messages.flatMap((m) => m.tools ?? []).find((x) => x.decision);
    ok(act !== undefined, "★ **그 활동에 붙었다**");
    ok(act!.decision!.mark === "✓" && act!.decision!.label === "이번만 허용",
       `★ 무엇을 골랐는지까지 (${act!.decision!.mark} ${act!.decision!.label})`);
    ok(act!.title === "파일 고치기",
       "★ **어느 활동이었는지가 한 자리에** — 제목으로 넘겨짚지 않는다");
    t.mgr.dispose();
  }

  console.log(`${NL}[거절은 ✕ 로]`);
  {
    const t = await make(); dirs.push(t.dir);
    const turn = t.mgr.send(t.room.id, "[[ask:위험한 것]] 해줘", undefined, t.a.id);
    await t.waitCard();
    t.answer("n");
    await turn; await t.settle();

    const act = t.room.messages.flatMap((m) => m.tools ?? []).find((x) => x.decision);
    ok(act?.decision?.mark === "✕" && act.decision.label.includes("거절"),
       `★ ✓ 를 붙이면 통과한 것으로 읽힌다 (${act?.decision?.mark} ${act?.decision?.label})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 붙일 활동이 없으면 예전처럼 한 줄로 — 버리지는 않는다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const inner = t.mgr as unknown as {
      recordDecision(sessionId: string, note: Record<string, unknown>): void;
    };
    await t.mgr.send(t.room.id, "안녕", undefined, t.a.id);
    await t.settle();

    inner.recordDecision(t.a.sessionId!, {
      toolCallId: "없는-도구", title: "어딘가의 승인", mark: "✓", label: "허용",
    });
    ok(t.room.messages.some((m) => m.role === "system" && m.text.includes("어딘가의 승인")),
       "★ **폴백이 있다** (§0) — 못 붙인다고 조용히 사라지면 안 된다");
    t.mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
