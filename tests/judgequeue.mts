/**
 * **심사는 줄을 안 선다 — 큐에 들어간다** (v3.0 3-I · §4.2.2 · §4.3).
 *
 * ⏪ 이 파일은 원래 **줄서기**를 쟀다. 심사 봇의 세션은 하나라 직렬인데
 * (B1), 심사가 그 봇의 **턴을 가로채** 물어봤기 때문이다:
 *
 * ```
 * 바쁘면 기다린다      앞 일이 끝나야 턴을 쓸 수 있다 (최대 90초)
 * 물어보면 또 기다린다  답이 와야 한다 (최대 15초)
 * 늦으면 사람에게      기다리는 동안 **요청한 봇의 턴은 얼어 있다**
 * ```
 *
 * 🔴 **줄을 선 이유가 턴 하나를 써야 해서였다.** 큐는 턴을 안 쓴다 — 봇이
 * **제 턴에** 꺼내 보고 답한다. 그래서 **바빠도 바로 들어간다.**
 *
 * 남은 것은 하나다: 기다리는 동안 요청한 봇의 턴은 **여전히 얼어 있다.**
 * 그래서 보이게 하고, 사람이 가로챌 수 있게 둔다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import { McpServer } from "../src/core/mcpServer.js";
import type { BotQueue } from "../src/core/botQueue.js";
import type { PermissionRequest, PermissionDecision, ReviewWait } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

const REQ = (title = "파일 고치기"): PermissionRequest => ({
  title, readOnly: false, kind: "edit", paths: ["src/a.ts"],
  options: [
    { optionId: "y", name: "이번만 허용", kind: "allow_once" },
    { optionId: "n", name: "이번만 거절", kind: "reject_once" },
  ],
});

async function make(hold: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-jq-"));
  const store = new RoomStore(dir); await store.init();
  let askedUser = 0;
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => { askedUser++; return { outcome: "cancelled" }; },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mcp = new McpServer({ log: () => {} });
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000, mcp,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      { ...base, id: "beta", label: "베타", env: { AIO_FAKE_HOLD: String(hold) } },
      { ...base, id: "gamma", label: "감마", env: {} },
    ],
  });
  const seen: ReviewWait[][] = [];
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  mgr.on("reviews", (_id: string, list: ReviewWait[]) => { seen.push(list); });
  mcp.setHandlers(mgr.mcpTools(), (o, t, a) => mgr.mcpCall(o, t, a));

  const inner = mgr as unknown as {
    askApprover(sessionId: string, req: PermissionRequest): Promise<PermissionDecision>;
    queue: BotQueue;
  };
  const room = await mgr.createRoom({
    title: "줄", bots: [{ agentId: "alpha" }, { agentId: "beta" }, { agentId: "gamma" }],
  });
  const settle = async () => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(room.id))) return;
      await nap(25);
    }
  };
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 600; i++) { if (cond()) return; await nap(25); }
    throw new Error("FAIL: 전제가 안 섰다 — " + what);
  };

  const asker = room.participants[0]!;
  const judge = room.participants[1]!;
  const check = async () => {
    inner.queue.startTurn(judge.id);
    const out = await mgr.mcpCall(`${room.id}:${judge.id}`, "check_queue", {});
    return JSON.parse(out.text) as {
      kind: string | null; item: { id: string; title?: string } | null; queue_left: number;
    };
  };
  const verdict = (id: string, allow: boolean) =>
    mgr.mcpCall(`${room.id}:${judge.id}`, "verdict", { id, allow, reason: "그래서요" });

  return {
    dir, mgr, mcp, room, inner, seen, settle, until, check, verdict,
    asker, judge, other: room.participants[2]!, userAsks: () => askedUser,
  };
}

async function main(): Promise<void> {
  const dirs: string[] = [];
  const bye = (t: { mgr: RoomManager; mcp: McpServer; dir: string }) => {
    t.mcp.close(); t.mgr.dispose(); dirs.push(t.dir);
  };

  console.log(`${NL}[★ 심사 봇이 바빠도 바로 들어간다 — 줄 설 이유가 없다]`);
  {
    /*
     * ⏪ 여기서 «앞 일이 끝나기를 기다린다» 를 쟀다. 줄을 선 이유가 **턴
     * 하나를 써야 해서**였는데, 큐는 턴을 안 쓴다.
     *
     * 🔴 그 차이가 큰 이유: 기다리는 동안 **요청한 봇의 턴은 얼어 있다.**
     * 줄이 길면 그 얼음이 길어지고, 한때 그걸 «바쁘면 사람에게» 로 막았다가
     * **급할 때마다 위임이 꺼지는** 것이 됐다.
     */
    const t = await make(3000);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const busy = t.mgr.send(t.room.id, "긴 일", undefined, t.judge.id);
    await t.until(() => !["idle", "error"].includes(t.mgr.statusOf(t.room.id, t.judge.id)),
                  "심사 봇이 바빠지지 않았다");

    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("바쁜데 들어가나"));
    await t.until(() => t.inner.queue.pending(t.judge.id).length === 1, "큐에 안 들어갔다");
    ok(true, "★ **바쁜 채로 큐에 들어간다** — 기다리지 않는다");
    ok(t.userAsks() === 0, "★ 사람도 안 깨운다 — «바쁘면 사람에게» 였던 자리");

    // 심사 봇이 하던 일을 끝내고, 제 턴에 꺼내 본다
    await busy.catch(() => undefined);
    await t.settle();
    const got = await t.check();
    ok(got.item !== null, "★ 그리고 제 턴에 꺼내 본다");
    await t.verdict(got.item!.id, true);
    const out = await pending;
    ok(out.outcome === "selected", `★ 판정이 돌아간다 (${JSON.stringify(out)})`);

    const mine = t.room.messages.find((m) => m.text === "긴 일");
    const reply = t.room.messages.find(
      (m) => m.role === "agent" && (m.replyToIds ?? []).includes(mine?.id ?? ""),
    );
    ok((reply?.text ?? "").length > 0,
       "★ **하던 일도 멀쩡히 끝났다** — 턴을 안 가로채므로 끊을 일이 없다");
    bye(t);
  }

  console.log(`${NL}[★ 「봇끼리 부르기 — 끔」이어도 심사는 돈다]`);
  {
    /*
     * 🔴 **두 축이다.** 「끔」이 막는 것은 `say` 고, 심사는 `check_queue` ·
     * `verdict` 로 돈다 — `relay` 를 보는 곳은 `relaySay` 하나뿐이다.
     *
     * 섞이면 «대화를 껐으니 심사도 꺼졌겠지» 가 되고, 반대로 **심사를 쓰려고
     * 봇끼리 대화를 열어야** 하는 꼴이 된다. 둘이 같이 묶이는 것은 **MCP
     * 서버 하나**뿐이다.
     */
    const t = await make(40);
    await t.mgr.setRelay(t.room.id, "off");
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    // 전제 — 이 방에서 say 는 정말로 막혀 있다
    const blocked = await t.mgr.mcpCall(
      `${t.room.id}:${t.asker.id}`, "say", { to: [t.judge.name], text: "들려?", id: "0" },
    );
    if (!blocked.text.includes('"ok":false')) {
      throw new Error("FAIL: 전제가 안 섰다 — 「끔」인데 say 가 나갔다");
    }

    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("꺼져 있어도"));
    await t.until(() => t.inner.queue.pending(t.judge.id).length === 1,
                  "「끔」이라고 심사가 큐에 안 들어갔다");
    ok(t.userAsks() === 0, "★ **사람에게 안 넘긴다** — 끄기는 say 만 막는다");

    const got = await t.check();
    ok(got.item !== null, "★ **심사 봇은 그대로 꺼내 본다** — check_queue 는 relay 와 무관하다");
    await t.verdict(got.item!.id, true);
    const out = await pending;
    ok(out.outcome === "selected",
       `★ **판정도 그대로 돌아간다** (${JSON.stringify(out)}) — 두 축이 독립이다`);
    bye(t);
  }

  console.log(`${NL}[★ 기다리는 동안 화면에 보인다]`);
  {
    /*
     * 심사 봇이 언제 제 턴을 돌릴지는 알 수 없다. 그동안 **요청한 봇의
     * 턴은 얼어 있으므로**, 무엇이 누구를 기다리는지 보여야 한다.
     */
    const t = await make(100);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("보이나"));
    await t.until(() => t.mgr.reviewsIn(t.room.id).length === 1, "띠에 안 떴다");

    const now = t.mgr.reviewsIn(t.room.id);
    ok(now[0]!.askerBotId === t.asker.id && now[0]!.judgeBotId === t.judge.id,
       "★ 누가 누구를 기다리는지 적힌다");
    ok(now[0]!.title === "보이나", "무엇을 승인하려는지도");

    const got = await t.check();
    await t.verdict(got.item!.id, true);
    await pending;
    ok(t.mgr.reviewsIn(t.room.id).length === 0, "★ 답이 나면 띠에서 빠진다");
    ok(t.seen.some((l) => l.length === 1) && t.seen.at(-1)!.length === 0,
       "★ **바뀔 때마다 알린다** — 빈 것도 보내야 표시가 걷힌다");
    bye(t);
  }

  console.log(`${NL}[★ 둘이 쌓이면 한 번에 나온다 — 차례를 기다리지 않는다]`);
  {
    /*
     * ⏪ 예전에는 **하나씩** 물어봤다 — 턴을 하나씩 썼으므로. 둘째는 첫째가
     * 끝나기를 기다렸고, 그 사이 요청한 봇 **둘이** 얼어 있었다.
     *
     * 큐는 한 몫에 담아 준다. 봇은 한 턴에 둘 다 판정한다.
     */
    const t = await make(100);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    for (const b of [t.asker, t.other]) {
      await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, b.id);
    }

    const one = t.inner.askApprover(t.asker.sessionId!, REQ("첫째"));
    const two = t.inner.askApprover(t.other.sessionId!, REQ("둘째"));
    await t.until(() => t.inner.queue.pending(t.judge.id).length === 2, "둘이 안 쌓였다");

    const got = await t.check();
    console.log(`   하나 나오고 queue_left ${got.queue_left}`);
    /*
     * ⏪ 여기서 **«한 번에 둘 다»** 를 쟀다. 묶어 주면 얼어 있던 둘이 한 턴에
     * 풀린다는 것이었는데 — **그 이득은 모델이 다 답할 때만 생긴다.** 둘을
     * 주면 하나 답하고 나머지를 잊는 일이 생기고, 그러면 **잊힌 쪽이 더 오래**
     * 얼어 있는다. 그리고 어느 것부터 답할지를 모델이 정하게 된다.
     *
     * 지금은 **하나씩**이고, `queue_left` 가 «더 있다»를 말한다. 한 턴 안에서
     * 여러 번 꺼낼 수 있으므로 **둘 다 같은 턴에 풀리는 것은 그대로**다.
     */
    ok(got.item !== null && got.queue_left === 1,
       `★ **하나씩 나오고 남은 수를 말해준다** (queue_left ${got.queue_left})`);

    await t.verdict(got.item!.id, true);
    const next = await t.check();
    ok(next.item !== null && next.queue_left === 0,
       `★ **답하면 다음이 나온다** (queue_left ${next.queue_left}) — 같은 턴에서`);
    await t.verdict(next.item!.id, true);
    const outs = await Promise.all([one, two]);
    ok(outs.every((o) => o.outcome === "selected"), "★ **둘 다 봇이 판단했다**");
    ok(t.userAsks() === 0, "★ 사람을 한 번도 안 깨웠다");
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
