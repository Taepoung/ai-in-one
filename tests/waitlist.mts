/**
 * ★ **봇 앞에 서 있는 것을 화면까지 보낸다** (§5-M, 2026-10-14).
 *
 * 큐는 여태 **우리끼리만 아는 물건**이었다 — 프롬프트의 `queue: 2` 와
 * `check_queue` 의 결과로만 보였고, 사용자 화면에는 **한 글자도 안 갔다.**
 * 그래서 «왜 저 봇이 가만히 있지» 에 답할 길이 없었다.
 *
 * 여기서 재는 것은 셋이다:
 *
 * ```
 * 모양    나가는 것은 WaitItem 이다 — fromId·depth·srcId 같은 장부는 안 간다
 * 알림    큐가 바뀌면 그 방에 한 번 알린다 (고치는 자리마다가 아니라 한 자리)
 * 버리기  메시지는 버려진다. **권한은 안 된다** — 낸 봇이 얼어 있으므로
 * ```
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { McpServer } from "../src/core/mcpServer.js";
import type { BotQueue } from "../src/core/mcp/botQueue.js";
import type { PermissionDecision, PermissionRequest, WaitItem } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

const REQ: PermissionRequest = {
  title: "터미널 명령", readOnly: false, kind: "execute",
  command: "rm -rf build/",
  options: [
    { optionId: "y", name: "이번만 허용", kind: "allow_once" },
    { optionId: "n", name: "이번만 거절", kind: "reject_once" },
  ],
};

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-wait-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mcp = new McpServer({ log: () => {} });
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000, mcp,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      { ...base, id: "beta", label: "베타", env: { AIO_FAKE_HOLD: "60" } },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  /** 화면에 간 것들 — **알림이 왔나**를 여기서 센다 */
  const sent: WaitItem[][] = [];
  mgr.on("waiting", (_id: string, list: WaitItem[]) => { sent.push(list); });
  mcp.setHandlers(mgr.mcpTools(), (o, t, a) => mgr.mcpCall(o, t, a));

  const inner = mgr as unknown as {
    askApprover(sessionId: string, req: PermissionRequest): Promise<PermissionDecision>;
    botRuntime(r: string, b: string): { depth?: number; fromUser?: boolean };
    queue: BotQueue;
  };
  const room = await mgr.createRoom({
    title: "대기", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
  });
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 600; i++) { if (cond()) return; await nap(25); }
    throw new Error("FAIL: 전제가 안 섰다 — " + what);
  };

  const asker = room.participants[0]!;
  const judge = room.participants[1]!;
  /** 봇이 하듯 — 알파가 베타에게 말을 건다 */
  const say = async (text: string) => {
    const bt = inner.botRuntime(room.id, asker.id);
    bt.depth = 0; bt.fromUser = true;
    const out = await mgr.mcpCall(
      `${room.id}:${asker.id}`, "say", { to: [judge.name], text, id: null },
    );
    if (!out.text.includes('"ok":true')) throw new Error("FAIL: 전제가 안 섰다 — say 가 막혔다: " + out.text);
  };

  return { dir, mgr, mcp, room, inner, sent, until, asker, judge, say };
}

async function main(): Promise<void> {
  const dirs: string[] = [];
  const t = await make();
  await t.mgr.setRelay(t.room.id, "always");

  console.log(`${NL}[★ 건 말이 **그 봇의 대기**로 보인다]`);
  {
    await t.say("이 테스트 좀 봐줄래?");
    await t.until(() => t.mgr.waitingIn(t.room.id).length === 1, "대기에 안 섰다");

    const [item] = t.mgr.waitingIn(t.room.id) as [WaitItem];
    ok(item.botId === t.judge.id, "★ **누구 앞에 서 있나** — 받을 봇의 칸이다");
    ok(item.from === t.asker.name, `★ **누가 넣었나**가 같이 간다 (${item.from})`);
    ok(item.kind === "message" && item.text === "이 테스트 좀 봐줄래?",
       "★ 한 말이 그대로 간다 — 화면이 줄여서 보여줄 뿐이다");
    /*
     * 🔴 **장부는 안 간다.** `fromId`·`depth`·`srcId` 는 우리가 가닥과 상한을
     * 재는 값이라 화면이 쓸 일이 없다. 모델에게 안 보내는 것(`wireItem`)과
     * 같은 줄이다 — **나가는 모양은 쓰는 쪽에 맞춰 깎는다.**
     */
    const keys = Object.keys(item).sort().join(",");
    ok(keys === "at,botId,from,id,kind,text", `★ **칸이 여섯뿐이다** (${keys})`);
  }

  console.log(`${NL}[★ 바뀌면 **한 자리에서** 알린다 — 고치는 자리마다가 아니라]`);
  {
    ok(t.sent.length > 0, "전제 — 알림이 왔다");
    const last = t.sent.at(-1)!;
    ok(last.length === 1 && last[0]!.kind === "message",
       "★ 방 하나치를 통째로 보낸다 — 봇별로 쪼개면 «0 이 됐다»를 빠뜨린다");
  }

  console.log(`${NL}[★ 권한도 같은 목록에 선다 — **무엇을 하려는지**까지]`);
  {
    const before = t.sent.length;
    // 알파의 승인은 **베타가 맡는다** — 그래야 베타의 큐로 들어간다 (§4.2.2)
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    void t.inner.askApprover(t.asker.sessionId!, REQ);
    await t.until(() => t.mgr.waitingIn(t.room.id).length === 2, "권한이 안 들어왔다");
    ok(t.sent.length > before, "★ 권한이 들어와도 화면에 알린다");

    const perm = t.mgr.waitingIn(t.room.id).find((w) => w.kind === "permission")!;
    ok(perm.text === "터미널 명령", "★ 제목이 한 줄로");
    /* 🔴 제목만 보면 `rm -rf build/` 와 `ls` 가 **똑같이 «터미널 명령»** 이다 (D1) */
    ok(perm.command === "rm -rf build/",
       "★ **명령 그대로** 간다 — 제목만으로는 무엇을 승인하는지 모른다");
  }

  console.log(`${NL}[🔴 권한은 **못 버린다** — 낸 봇이 얼어 있다]`);
  {
    const perm = t.mgr.waitingIn(t.room.id).find((w) => w.kind === "permission")!;
    const got = t.mgr.dropWaiting(t.room.id, perm.botId, perm.id);
    ok(got === false, "★ 거절한다 — 그쪽은 「유저 승인으로」가 사람에게 넘긴다");
    ok(t.mgr.waitingIn(t.room.id).some((w) => w.id === perm.id),
       "★ **그대로 서 있다** — 조용히 사라지면 낸 봇이 영영 기다린다");
  }

  console.log(`${NL}[★ 메시지는 버려진다 — 그 봇은 끝내 안 본다]`);
  {
    const msg = t.mgr.waitingIn(t.room.id).find((w) => w.kind === "message")!;
    const before = t.sent.length;
    ok(t.mgr.dropWaiting(t.room.id, msg.botId, msg.id) === true, "전제 — 버려졌다");
    ok(!t.mgr.waitingIn(t.room.id).some((w) => w.id === msg.id), "★ 목록에서 빠진다");
    ok(t.sent.length > before, "★ 버린 것도 화면에 알린다 — 수가 안 줄면 안 버린 것처럼 보인다");

    /*
     * 🔴 **큐에서도 빠져야 한다.** 화면에서만 지우면 그 봇은 제 턴에 또
     * 꺼내 보고, 사람은 버린 줄 안다 — 가로채기(`takeOverReview`)가 큐에서
     * 빼는 것과 같은 이유다.
     */
    t.inner.queue.startTurn(t.judge.id);
    const out = await t.mgr.mcpCall(`${t.room.id}:${t.judge.id}`, "check_queue", {});
    const view = JSON.parse(out.text) as { kind: string | null };
    ok(view.kind !== "message", `★ **봇도 다시는 못 꺼낸다** (${String(view.kind)})`);
  }

  console.log(`${NL}[★ 안 열린 방이면 조용히 넘어간다]`);
  {
    ok(t.mgr.waitingIn("없는-방") .length === 0, "★ 빈 목록 — 터지지 않는다");
    ok(t.mgr.dropWaiting("없는-방", t.judge.id, "x999") === false, "★ 없는 항목은 false");
  }

  t.mcp.close(); t.mgr.dispose(); dirs.push(t.dir);
  await nap(200);
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}다 지나갔다 — 대기 목록이 화면까지 간다.`);
}

void main();
