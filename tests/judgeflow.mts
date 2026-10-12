/**
 * **승인을 다른 봇에게 물어본다** (v3.0 3-I · §4.2.2).
 *
 * 🔴 **승인 주체가 넘어가는 게 아니다.** `session/request_permission` 은
 * 클라이언트 메서드라 답은 **언제나 우리가** 만든다 — ACP 에 «다른 에이전트에게
 * 위임» 이라는 개념이 없다. **주체가 우리라서 조건을 걸 수 있고**, 그 조건들이
 * 이 파일이 재는 전부다.
 *
 * ⏪ **묻는 방법이 바뀌었다** (v3.0 3-I). 예전에는 심사 봇의 **턴을 가로채**
 * 프롬프트로 묻고 **답의 첫 줄을 읽었다.** 그래서 넷이 딸려 있었다:
 *
 * ```
 * 읽기 전용 거르기   «요청 하나에 리뷰어 턴 하나» 라서 비용이 아까웠다
 * 90초 줄서기       앞 일이 끝나야 턴을 쓸 수 있었다
 * 첫 줄 파서        산문에서 ALLOW 를 주웠다 — **인젝션이 통하는 자리**였다
 * 15초 재촉          턴을 하나 쓰는 일이라 늦으면 포기해야 했다
 * ```
 *
 * 이제 **큐에 넣고 봇이 제 턴에 꺼내 본다.** 턴을 안 쓰므로 넷이 다 사라졌고,
 * 답은 `verdict` **도구**로 온다 — `allow` 가 불리언이라 **읽을 것이 없다.**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import { McpServer } from "../src/core/mcpServer.js";
import type { BotQueue } from "../src/core/botQueue.js";
import type { PermissionRequest, PermissionDecision, Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-judge-"));
  const store = new RoomStore(dir); await store.init();

  let askedUser = 0;
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => { askedUser++; return { outcome: "cancelled" }; },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
  };
  const mcp = new McpServer({ log: () => {} });
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000, mcp,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      { ...base, id: "beta", label: "베타", env: {} },
    ],
  });
  const notices: string[] = [];
  mgr.on("roomError", () => {}); mgr.on("notice", (_id: string, m: string) => notices.push(m));
  mcp.setHandlers(mgr.mcpTools(), (o, t, a) => mgr.mcpCall(o, t, a));

  const inner = mgr as unknown as {
    askApprover(sessionId: string, req: PermissionRequest): Promise<PermissionDecision>;
    judging: Set<string>;
    queue: BotQueue;
  };

  const room = await mgr.createRoom({
    title: "심사", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
  });
  // 세션을 실제로 열어둔다 — 심사는 살아 있는 세션에 맡긴다
  await mgr.send(room.id, "안녕", undefined, room.participants[1]!.id);
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      if (["idle", "error"].includes(mgr.statusOf(room.id))) return;
      await nap(25);
    }
  };
  await settle();

  const asker = room.participants[0]!;
  const judge = room.participants[1]!;

  /** 심사 봇이 하듯 — 제 몫을 꺼내 본다 */
  const check = async () => {
    inner.queue.startTurn(judge.id);
    const out = await mgr.mcpCall(`${room.id}:${judge.id}`, "check_queue", {});
    return JSON.parse(out.text) as {
      kind: string | null;
      use?: string;
      item: { id: string; from: string; title?: string; command?: string } | null;
    };
  };
  /** 그리고 판정한다 */
  const verdict = (id: string, allow: boolean, reason = "그래서요", who = judge.id) =>
    mgr.mcpCall(`${room.id}:${who}`, "verdict", { id, allow, reason });

  /** 큐에 들 때까지 기다린다 — 넣는 쪽이 `await` 를 건너뛴다 */
  const untilQueued = async () => {
    for (let i = 0; i < 400; i++) {
      if (inner.queue.waiting(judge.id) > 0 || inner.queue.pending(judge.id).length > 0) return;
      await nap(25);
    }
  };

  return {
    dir, mgr, mcp, room, inner, notices, settle, check, verdict, untilQueued,
    asker, judge, userAsks: () => askedUser,
  };
}

const systemTexts = (room: Room) =>
  room.messages.filter((m) => m.role === "system").map((m) => m.text);

async function main(): Promise<void> {
  const dirs: string[] = [];
  const bye = (t: { mgr: RoomManager; mcp: McpServer; dir: string }) => {
    t.mcp.close(); t.mgr.dispose(); dirs.push(t.dir);
  };

  console.log(`${NL}[★ 큐에 넣는다 — 턴을 가로채지 않는다]`);
  {
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ());
    await t.untilQueued();

    /*
     * ⏪ 여기서 **말풍선 개수**를 셌다. 4-J 에서 «넣는 쪽이 깨운다»가 들어오면서
     * 그 숫자가 **경합**이 됐다 — 깨어난 심사 봇의 산문이 그 사이에 들어온다.
     * 그건 **봇이 제 턴에 한 말**이라 들어오는 것이 맞고(4-14), 재려던 것이
     * 아니었다. 재려던 것은 **심사 프롬프트가 대화에 섞이나**다.
     */
    ok(!t.room.messages.some((m) => m.text.includes("파일 고치기")),
       "★ **심사할 거리가 대화에 안 들어간다** — 예전에는 프롬프트로 밀어 넣었다");
    ok(t.mgr.reviewsIn(t.room.id).length === 1, "★ 대신 «기다리는 중»으로 보인다");

    const got = await t.check();
    ok(got.kind === "permission" && got.use === "verdict",
       `★ 심사 봇이 꺼내 보면 권한이 나온다 (${got.kind} · ${got.use})`);
    ok(got.item?.from === t.asker.name, `★ 누가 하려는지 (${got.item?.from})`);

    await t.verdict(got.item!.id, true, "되돌릴 수 있는 변경입니다.");
    const out = await pending;
    ok(out.outcome === "selected" && out.optionId === "y",
       `★ **«이번만 허용»으로 옮겨 답한다** (${JSON.stringify(out)})`);
    ok(t.mgr.reviewsIn(t.room.id).length === 0, "★ 띠에서도 빠진다");
    bye(t);
  }

  console.log(`${NL}[★ 누가 정했고 왜 그랬는지 남는다 (D3)]`);
  {
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ());
    await t.untilQueued();
    const got = await t.check();
    await t.verdict(got.item!.id, false, "되돌릴 수 없는 삭제입니다.");
    const out = await pending;

    ok(out.outcome === "selected" && out.optionId === "n", "★ 막으면 거절로 답한다");
    const said = systemTexts(t.room).find((x) => x.includes("막았습니다"));
    console.log(`   ${said}`);
    ok(said !== undefined, "★ **사용자에게 보인다** — 봇이 막은 것을 모르고 지나가면 안 된다");
    ok(said!.includes(t.judge.name), "★ 누가 정했는지");
    ok(said!.includes("되돌릴 수 없는"), "★ **왜 그랬는지도** — 이유를 모르면 그냥 열어주게 된다");
    bye(t);
  }

  console.log(`${NL}[★ 읽기도 넘긴다 — 이제 턴이 안 든다]`);
  {
    /*
     * ⏪ 예전에는 «요청 하나에 리뷰어 턴 하나» 라서 **읽기는 안 넘겼다.**
     * 큐는 턴을 안 쓴다 — 거를 이유가 사라졌다. 사용자가 «전부 넘긴다» 고
     * 정한 것을 우리가 비용 때문에 반만 지키던 자리다.
     */
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ({ readOnly: true, kind: "read" }));
    await t.untilQueued();
    const got = await t.check();
    ok(got.item !== null, "★ **읽기도 큐에 든다**");
    await t.verdict(got.item!.id, true);
    await pending;
    ok(t.userAsks() === 0, "★ 사람을 안 깨웠다");
    bye(t);
  }

  console.log(`${NL}[★ 자기 자신은 심사하지 않는다]`);
  {
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.asker.id } }, t.asker.id);
    await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(t.userAsks() === 1, "★ **사람에게 간다** — 같은 맥락이 «해도 된다»면 메아리다");
    ok(t.notices.some((m) => m.includes("자기 자신")), `★ 왜인지 말해준다 (${t.notices.at(-1)})`);
    bye(t);
  }

  console.log(`${NL}[★ 심사를 맡고 있는 봇의 요청은 사람에게 — 재귀 금지]`);
  {
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    t.inner.judging.add(t.asker.id);
    await t.inner.askApprover(t.asker.sessionId!, REQ());
    ok(t.userAsks() === 1, "★ **사람에게** — A가 B에게, B가 A에게 묻는 고리를 막는다");
    bye(t);
  }

  console.log(`${NL}[★ «항상»은 봇에게 주지 않는다 — 앞으로를 바꾸는 값이다]`);
  {
    /*
     * 🔴 `*_always` 는 이 요청 하나를 넘어 **앞으로를 바꾼다.** 봇이 그걸
     * 고르면 이후 같은 종류는 **아무에게도 안 물어보고** 지나간다 —
     * 프롬프트 인젝션 한 번의 값이 «이번 편집» 이 아니라 «앞으로 전부» 가 된다.
     */
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ({
      options: [
        { optionId: "always", name: "항상 허용", kind: "allow_always" },
        { optionId: "once", name: "이번만", kind: "allow_once" },
        { optionId: "no", name: "거절", kind: "reject_once" },
      ],
    }));
    await t.untilQueued();
    const got = await t.check();
    await t.verdict(got.item!.id, true);
    const out = await pending;
    ok(out.outcome === "selected" && out.optionId === "once",
       `★ **«이번만»으로 옮긴다** (${JSON.stringify(out)}) — 순서가 아니라 kind 로 고른다`);
    bye(t);
  }

  console.log(`${NL}[★ «이번만» 선택지가 아예 없으면 — 넣기 전에 사람에게]`);
  {
    /*
     * ⏪ 예전에는 답을 받은 **뒤에** 이걸 알았다. 그러면 심사 봇의 턴을 한 번
     * 쓰고 나서 사용자에게 넘기게 된다 — **값을 치르고 아무것도 안 사는** 꼴이다.
     */
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    await t.inner.askApprover(t.asker.sessionId!, REQ({
      options: [{ optionId: "always", name: "항상 허용", kind: "allow_always" }],
    }));
    ok(t.userAsks() === 1, "★ **사람에게 간다**");
    ok(t.inner.queue.pending(t.judge.id).length === 0,
       "★ **큐에 넣지도 않는다** — 옮길 데가 없는 것을 물어봐야 값만 치른다");
    bye(t);
  }

  console.log(`${NL}[★ 남의 판정은 안 먹는다 — 소유자 검사]`);
  {
    /*
     * 🔴 이게 없으면 봇이 **제 요청을 스스로 승인**할 수 있다. 큐에서 빼는
     * 것이 곧 검사다 — 남의 항목이면 `answer` 가 아무것도 안 돌려준다.
     */
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ());
    await t.untilQueued();
    const got = await t.check();

    const stolen = await t.verdict(got.item!.id, true, "내가 할게", t.asker.id);
    ok(stolen.isError === true, `★ **요청한 봇이 답하면 안 먹는다** (${stolen.text})`);
    ok(t.mgr.reviewsIn(t.room.id).length === 1, "★ 그래서 아직 기다리고 있다");

    await t.verdict(got.item!.id, true);
    await pending;
    bye(t);
  }

  console.log(`${NL}[★ 모양이 안 맞으면 지어내지 않는다]`);
  {
    const t = await make();
    const bad = await t.mgr.mcpCall(`${t.room.id}:${t.judge.id}`, "verdict", { id: "p1" });
    ok(bad.isError === true,
       `★ **allow 가 없으면 거절도 승인도 아니다** (${bad.text}) — false 로 읽으면 우리가 막은 것이 된다`);
    bye(t);
  }

  console.log(`${NL}[★ 사람이 가로채면 봇의 답은 안 먹는다]`);
  {
    /*
     * 🔴 안 빼면 심사 봇이 나중에 제 턴에 꺼내 보고 `verdict` 를 부르는데,
     * 그때는 **이미 사람이 답한 뒤**다 — 봇은 제 판정이 먹힌 줄 알고,
     * 사람은 모르는 답이 하나 더 생긴다.
     */
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ());
    await t.untilQueued();
    const got = await t.check();

    ok(t.mgr.takeOverReview(got.item!.id), "★ 가로챈다");
    const out = await pending;
    ok(t.userAsks() === 1, "★ **승인 카드가 사람에게 떴다**");
    ok(out.outcome === "cancelled", "사람이 답한 대로 (여기선 취소)");

    const late = await t.verdict(got.item!.id, true);
    ok(late.isError === true, `★ **늦은 판정은 안 먹는다** (${late.text})`);
    bye(t);
  }

  console.log(`${NL}[★ 전체 중지는 기다리던 것을 푼다]`);
  {
    const t = await make();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ());
    await t.untilQueued();

    await t.mgr.stopAll(t.room.id);
    const out = await pending;
    ok(out.outcome === "cancelled",
       `★ **cancelled 로 답해준다** (${JSON.stringify(out)}) — 안 답하면 저쪽은 영영 기다린다`);
    ok(t.inner.queue.pending(t.judge.id).length === 0, "★ 큐도 비었다");
    ok(t.mgr.reviewsIn(t.room.id).length === 0, "★ 띠도 걷혔다");
    bye(t);
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await nap(200); }
    }
  }
  console.log(`${NL}전부 통과`);
}

main()
  .then(() => nap(50))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
