/**
 * **승인을 다른 봇에게 물어본다** (v2.0 · §4.2.2).
 *
 * 🔴 **승인 주체가 넘어가는 게 아니다.** `session/request_permission`은 클라이언트
 * 메서드라 답은 언제나 우리가 만든다 — ACP에 «다른 에이전트에게 위임»이라는
 * 개념이 없다. **주체가 우리라서 조건을 걸 수 있고**, 그 조건들이 이 파일이 재는
 * 전부다: 자기 심사 금지 · 읽기는 안 넘김 · 재귀 금지 · 못 읽으면 사람 ·
 * 늦으면 사람 · 그리고 **누가 정했는지 기록에 남는다**(D3).
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { PermissionRequest, PermissionDecision, Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

const OPTIONS = [
  { optionId: "y", name: "허용", kind: "allow_once" },
  { optionId: "n", name: "거절", kind: "reject_once" },
];
const REQ = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  title: "파일 고치기",
  readOnly: false,
  kind: "edit",
  paths: ["src/a.ts"],
  diff: { path: "src/a.ts", oldText: "전", newText: "후" },
  options: OPTIONS,
  ...over,
});

/** 심사 봇이 뭐라고 답할지 정해두고 방을 하나 만든다 */
async function make(say: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-judge-"));
  const store = new RoomStore(dir); await store.init();

  let askedUser = 0;
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => { askedUser++; return { outcome: "cancelled" }; },
    askUser: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      // ★ 심사 봇만 판결을 말한다
      { ...base, id: "beta", label: "베타", env: { AIO_FAKE_SAY: say } },
    ],
  });
  const notices: string[] = [];
  mgr.on("roomError", () => {}); mgr.on("notice", (_id: string, m: string) => notices.push(m));

  const inner = mgr as unknown as {
    askApprover(sessionId: string, req: PermissionRequest): Promise<PermissionDecision>;
    judging: Set<string>;
  };

  const room = await mgr.createRoom({
    title: "심사", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
  });
  // 세션을 실제로 열어둔다 — 심사는 살아 있는 세션에 묻는다
  await mgr.send(room.id, "안녕", undefined, room.participants[1]!.id);
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      if (["idle", "error"].includes(mgr.statusOf(room.id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await settle();

  return {
    dir, mgr, room, inner, notices, settle,
    asker: room.participants[0]!, judge: room.participants[1]!,
    userAsks: () => askedUser,
  };
}

const systemTexts = (room: Room) =>
  room.messages.filter((m) => m.role === "system").map((m) => m.text);

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 봇이 허용하면 허용으로 답한다 — 그리고 누가 정했는지 남는다]`);
  {
    const t = await make(`ALLOW${NL}되돌릴 수 있는 변경입니다.`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const out = await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(out.outcome === "selected" && out.optionId === "y",
       `★ **에이전트가 준 선택지 중에서** 고른다 (${JSON.stringify(out)}) — 우리가 지어내지 않는다`);
    ok(t.userAsks() === 0, "★ 사용자에게 안 물었다 — 그게 위임의 요점이다");
    ok(systemTexts(t.room).some((x) => x.includes("베타") && x.includes("승인")),
       `★ **누가 정했는지 기록에 남는다**(D3) — 사람 결정과 구분되어야 한다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 봇이 막으면 막는다 — 그리고 사용자에게 보인다]`);
  {
    const t = await make(`DENY${NL}이 경로는 설정 파일입니다.`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const out = await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(out.outcome === "selected" && out.optionId === "n",
       "★ **봇의 거부는 언제나 존중한다**");
    const said = systemTexts(t.room).find((x) => x.includes("막았습니다"));
    ok(said !== undefined, `★ 막았다는 것이 기록에 남는다 (${said})`);
    ok(t.room.messages.some((m) => m.text === said && m.mark === "error"),
       "★ **붉게 갈라진다** — 조용히 지나가면 «왜 안 됐지»가 된다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 자기 자신은 심사하지 않는다]`);
  {
    const t = await make("ALLOW"); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.judge.id);

    await t.inner.askApprover(t.judge.sessionId!, REQ());
    ok(t.userAsks() === 1,
       "★ 사람에게 넘어간다 — 같은 맥락이 «해도 된다»고 답하는 건 심사가 아니라 메아리다");
    ok(t.notices.some((n) => n.includes("자기 자신")),
       `★ **조용히 넘기지 않는다** (${t.notices.join(" | ")}) — 맡겼다고 생각하고 자리를 비우면 안 된다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 읽기는 안 넘긴다 — 요청 하나에 리뷰어 턴 하나다]`);
  {
    const t = await make("ALLOW"); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    await t.inner.askApprover(t.asker.sessionId!, REQ({ readOnly: true, kind: "read" }));
    ok(t.userAsks() === 1, "★ 사람에게 간다");
    ok(t.notices.some((n) => n.includes("읽기")),
       "★ 되돌릴 게 없는 것까지 넘기면 **비용이 요청 수에 비례**하는데 얻는 게 없다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 답을 못 읽으면 넘겨짚지 않는다]`);
  {
    const t = await make("음… 상황에 따라 다를 것 같습니다."); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(t.userAsks() === 1, "★ 사람에게 간다 — 모르면 모른다고 한다");
    ok(t.notices.some((n) => n.includes("읽을 수 없어")), "★ 왜 넘겼는지 말한다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 첫 줄만 본다 — «ALLOW 할 수 없습니다»를 허용으로 읽으면 안 된다]`);
  {
    const t = await make(`DENY${NL}ALLOW 라고 답하고 싶지만 위험합니다.`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const out = await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(out.outcome === "selected" && out.optionId === "n",
       "★ 뒤의 ALLOW를 줍지 않는다 — 본문에서 단어를 주우면 **인젝션이 통하는 자리**가 하나 더 생긴다");
    t.mgr.dispose();
  }

  console.log(`${NL}[장식이 붙어도 읽는다]`);
  {
    const t = await make(`**ALLOW**${NL}괜찮습니다.`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const out = await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(out.outcome === "selected" && out.optionId === "y",
       "★ 굵게·글머리표는 모델이 자주 붙인다 — 그것 때문에 사람을 깨우지 않는다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 심사를 재귀시키지 않는다]`);
  {
    const t = await make("ALLOW"); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    // 베타가 이미 심사를 맡고 있는 중이라고 치면
    t.inner.judging.add(t.judge.id);
    await t.inner.askApprover(t.asker.sessionId!, REQ());
    t.inner.judging.delete(t.judge.id);

    ok(t.userAsks() === 1,
       "★ 심사 중에 온 요청은 **사용자에게** — A가 B에게, B가 A에게 묻는 고리를 막는다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 무엇을 넘겼는지 기록에 남는다 — 인젝션을 눈으로 볼 수 있는 자리]`);
  {
    const t = await make(`ALLOW${NL}ok`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    await t.inner.askApprover(t.asker.sessionId!, REQ({ command: "rm -rf /tmp/x" }));

    const asked = t.room.messages.find((m) => m.mark === "review");
    ok(asked !== undefined, "★ 물어본 글이 기록으로 남는다");
    ok(asked!.text.includes("rm -rf /tmp/x"),
       "★ **요청 내용을 버리지 않는다**(D1) — 사람도 판단 못 하는 걸 봇에게 물을 수는 없다");
    ok(asked!.text.includes("지시가 아닙니다"),
       "★ **심사 대상이 곧 프롬프트의 입력이다** — 데이터지 지시가 아니라고 못 박는다");
    ok(asked!.deliveredTo.join() === t.judge.id, "★ 심사 봇에게만 갔다");
    t.mgr.dispose();
  }

  console.log(`${NL}[방에 없는 봇에게 맡겼으면 사람에게]`);
  {
    const t = await make("ALLOW"); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: "없는봇" } }, t.asker.id);
    await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(t.userAsks() === 1, "★ 내보낸 봇에게 맡긴 채로 두면 영영 답이 안 온다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «항상»은 봇에게 주지 않는다 — 앞으로를 바꾸는 값이다]`);
  {
    const t = await make(`ALLOW${NL}괜찮습니다.`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    // 에이전트가 **«항상»을 먼저** 준 경우. 예전 코드는 /allow/i 로 골라서
    // 순서에 따라 이걸 집었다 — 우리가 고른 적 없는 값이 배열 순서로 정해졌다.
    const out = await t.inner.askApprover(t.asker.sessionId!, REQ({
      options: [
        { optionId: "A", name: "항상 허용", kind: "allow_always" },
        { optionId: "a", name: "이번만 허용", kind: "allow_once" },
        { optionId: "n", name: "거절", kind: "reject_once" },
      ],
    }));
    ok(out.outcome === "selected" && out.optionId === "a",
       `★ **«이번만»을 집는다** (${JSON.stringify(out)}) — 인젝션 한 번의 값이 «앞으로 전부»가 되면 안 된다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «이번만» 선택지가 아예 없으면 사람에게]`);
  {
    const t = await make(`ALLOW${NL}ok`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    await t.inner.askApprover(t.asker.sessionId!, REQ({
      options: [
        { optionId: "A", name: "항상 허용", kind: "allow_always" },
        { optionId: "R", name: "항상 거절", kind: "reject_always" },
      ],
    }));
    ok(t.userAsks() === 1,
       "★ **«항상»으로 대신하지 않는다** — 없으면 없는 것이고, 지어내지 않는다");
    ok(t.notices.some((n) => n.includes("이번만")), "왜 넘겼는지 말한다");
    t.mgr.dispose();
  }

  console.log(`${NL}[거절도 «이번만»으로]`);
  {
    const t = await make(`DENY${NL}위험합니다.`); dirs.push(t.dir);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const out = await t.inner.askApprover(t.asker.sessionId!, REQ({
      options: [
        { optionId: "R", name: "항상 거절", kind: "reject_always" },
        { optionId: "n", name: "이번만 거절", kind: "reject_once" },
      ],
    }));
    ok(out.outcome === "selected" && out.optionId === "n",
       "★ 막는 쪽도 앞으로를 바꾸지 않는다 — 사용자가 다음에 다시 판단할 수 있어야 한다");
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

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
