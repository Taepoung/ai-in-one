/**
 * **세 칸과 깊이 상한** (v3.0 4-L).
 *
 * ```
 * 끄기        대화 기능 off — **답도 포함**
 * 승인        say 마다 승인 카드 — **답도 포함.** 그래서 상한이 할 일이 없다
 * 무조건 허용  자유. 대신 **깊이 상한**
 * ```
 *
 * 깊이는 «사용자에게서 몇 다리째인가» 다:
 *
 * ```
 * 0  사용자 메시지
 * 1  그 메시지에 반응해서 봇이 거는 말
 * 2  1 에 반응해서 거는 말 — **답도 반응이다**
 * ```
 *
 * 🔴 **깊이는 턴이 들고 간다 — `say` 의 `id` 가 아니다.** `id` 로 세면 인자를
 * 빼는 것만으로 1 로 되돌아간다.
 *
 * 🔴 **부르는 순간 안다 → 그 자리에서 거절된다.** 카드도, 큐 비우기도,
 * «더 갈까요»도 필요 없다 — 턴이 열리는 자리에서 막으면 셋 다 필요해진다.
 *
 * 그리고 **모든 `say` 는 «무엇에 대한 반응인가»를 들고 온다**:
 *
 * ```
 * id = null  처음 시작하는 say        ← 사용자가 연 턴에서만
 * id = "x7"  큐 항목 때문에
 * ```
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { BotQueue } from "../src/core/mcp/botQueue.js";
import type { PermissionRequest } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const busy = (s: string) => !["idle", "error"].includes(s);

interface SayOut { ok: boolean; reason?: string; queue_left?: number; got?: string[] }

async function make(cap: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-depth-"));
  const store = new RoomStore(dir); await store.init();
  const cards: Array<{ req: PermissionRequest; settle: (id: string | null) => void }> = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: (req) => new Promise((resolve) => {
      cards.push({
        req,
        settle: (id) => resolve(id ? { outcome: "selected", optionId: id } : { outcome: "cancelled" }),
      });
    }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: "40" },
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

  const room = await mgr.createRoom({
    title: "깊이",
    bots: [
      { agentId: "alpha", name: "구현" },
      { agentId: "beta", name: "리뷰어" },
      // 제3자가 있어야 «위임» 과 «답» 이 갈린다 — 임자에게 보내야 항목이 닫힌다
      { agentId: "gamma", name: "테스터" },
    ],
  });
  room.relay = "always";
  room.depthCap = cap;
  const [a, b, c] = room.participants as
    [typeof room.participants[0], typeof room.participants[0], typeof room.participants[0]];
  const inner = mgr as unknown as {
    queue: BotQueue;
    botRuntime(roomId: string, botId: string): {
      depth?: number; fromUser?: boolean; saidZero?: Set<string>;
    };
  };

  const settle = async () => {
    for (let i = 0; i < 1200; i++) {
      if (!busy(mgr.statusOf(room.id))) return;
      await nap(25);
    }
    throw new Error("FAIL: 전제가 안 섰다 — 방이 안 조용해진다");
  };
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 1200; i++) { if (cond()) return; await nap(25); }
    throw new Error("FAIL: 전제가 안 섰다 — " + what);
  };
  /** 그 봇이 하듯 — `id` 를 안 주면 «사용자가 방금 한 말 때문에» 다 */
  const say = async (
    from: { id: string }, to: string | string[], text: string, id: string | null = null,
  ): Promise<SayOut> => {
    const out = await mgr.mcpCall(`${room.id}:${from.id}`, "say", { to, text, id });
    return JSON.parse(out.text) as SayOut;   // 거절도 성공도 **JSON 한 모양**
  };
  /** 「이 봇은 지금 N다리째 턴을 돌고 있다」를 세워둔다 — 진짜로는 `runQueue` 가 한다 */
  const standAt = (bot: { id: string }, depth: number) => {
    const bt = inner.botRuntime(room.id, bot.id);
    bt.depth = depth;
    // «누가 열었나»는 «얼마나 멀리»와 **다른 질문**이다 — 0 이면 사용자가 연 턴
    bt.fromUser = depth === 0;
  };
  /**
   * 그 봇의 큐에 항목 하나를 심는다 — **깊은 데서 걸려면 받은 id 가 있어야** 한다.
   * 진짜로는 상대가 `say` 로 넣는다.
   */
  const plant = (to: { id: string }, from: { id: string; name: string }, depth: number) =>
    inner.queue.put({
      kind: "message", to: to.id, from: from.name, fromId: from.id, depth, text: "앞선 말",
    });
  const depthOf = (botId: string, qid: string) => {
    const item = inner.queue.find(botId, qid);
    return item && item.kind === "message" ? item.depth : undefined;
  };
  /**
   * 그 봇의 큐에 **가장 나중에 들어온** 항목의 id.
   *
   * 🔴 `say` 는 **번호를 안 돌려준다** — 보낸 쪽이 쓸 데가 없는 값이라서.
   * 검사는 받는 쪽에서 집는다.
   */
  const newest = (botId: string): string | undefined =>
    inner.queue.pending(botId).at(-1)?.id;
  return {
    dir, mgr, room, a, b, c, cards, inner, settle, until, say, standAt, plant, depthOf, newest,
  };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 깊이는 턴에서 온다 — 사용자 턴이 0, 거기서 건 말이 1]`);
  {
    const t = await make(12); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.a.id);
    await t.settle();

    const first = await t.say(t.a, "리뷰어", "이것 좀");
    ok(first.ok, "★ 전제: 갔다");
    ok(t.depthOf(t.b.id, t.newest(t.b.id)!) === 1,
       `★ **사용자 턴에서 건 말은 1다리째** (${t.depthOf(t.b.id, t.newest(t.b.id)!)})`);

    // 리뷰어가 그 말을 받아 도는 턴 — 거기서 거는 말은 2다리째다
    t.standAt(t.b, 1);
    const second = await t.say(t.b, "구현", "그건 이렇습니다", t.newest(t.b.id));
    ok(t.depthOf(t.a.id, t.newest(t.a.id)!) === 2,
       `★ **답도 반응이라 한 다리 는다** (${t.depthOf(t.a.id, t.newest(t.a.id)!)})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 깊이는 «고른 것»에서 온다 — 턴이 아니라]`);
  {
    /*
     * ★ 한 턴에 **사용자 말과 밀려 있던 깊은 항목**이 같이 실릴 수 있다
     * (항목은 답해야 빠지므로). 턴 하나에 깊이를 하나만 두면 둘 중 하나가
     * 샌다 — 반응한 것에서 세면 **둘 다 맞는다.**
     *
     * 얕게 돌아갈 길은 둘 다 막혀 있다: «0» 은 사용자가 연 턴에서만이고,
     * 그 밖의 id 는 **내 큐에 있는 것**뿐이며 **쓰면 올라간다.**
     */
    const t = await make(12); dirs.push(t.dir);
    const deep = t.plant(t.a, t.b, 5);
    const out = await t.say(t.a, "테스터", "다섯 다리짜리에 반응해서", deep);
    ok(t.depthOf(t.c.id, t.newest(t.c.id)!) === 6,
       `★ **6다리째다** (${t.depthOf(t.c.id, t.newest(t.c.id)!)}) — 고른 것이 5 였으니까`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 상한에 닿으면 — 그 자리에서 거절된다]`);
  {
    const t = await make(3); dirs.push(t.dir);
    const held = t.plant(t.a, t.b, 3);
    t.standAt(t.a, 3);   // 여기서 거는 말은 4다리째 — 상한 3 을 넘는다
    const out = await t.say(t.a, "리뷰어", "한 다리 더", held);

    ok(!out.ok, `★ **거절된다** (${out.reason})`);
    ok(out.reason === "max depths error", `★ **무엇이 막았는지 한 마디** (${out.reason})`);
    /*
     * ⚠️ **옛 글은 상한과 «몇 다리째»와 «사용자에게 말하라» 를 같이 실었다.**
     * 짧게 간 대가로 그게 빠졌다 — 남은 수습 거리는 `can_call` 뿐이다.
     */
    ok((out.can_call ?? []).length > 0, "★ 부를 수 있는 목록은 그대로 온다");
    ok(t.cards.length === 0,
       "★ 🔴 **카드가 안 뜬다** — 부르는 순간 알 수 있어 사람을 안 깨운다");
    ok(t.inner.queue.pending(t.b.id).length === 0,
       "★ 🔴 **큐에도 안 들어간다** — 그래서 나중에 비울 것도 없다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ check_queue 가 «몇 다리 더»를 싣는다]`);
  {
    /*
     * 프롬프트의 큐 줄에도 같은 수가 있지만 **그것은 턴이 열릴 때 한 번**이다.
     * `check_queue` 는 보내기 직전에 불리므로 여기 수가 그 순간의 참이다.
     */
    const t = await make(3); dirs.push(t.dir);
    /** 🔴 `depth_left` 는 **`item` 안**이다 (사용자가 고친 글, 2026-10-15) */
    const peek = async () => {
      const got = JSON.parse(
        (await t.mgr.mcpCall(`${t.room.id}:${t.a.id}`, "check_queue", {})).text,
      ) as { kind: string | null; item: { depth_left?: number | null } | null };
      return { kind: got.kind, item: got.item ?? {} };
    };

    /*
     * ★ **메세지를 꺼낼 때만 실린다** (사용자, 2026-10-15) — 그래서 심어둔다.
     * 꺼내 봐도 안 빠지므로(답해야 빠진다) 여러 번 들여다봐도 같은 것이 나온다.
     */
    t.plant(t.a, t.b, 1);
    t.inner.queue.startTurn(t.a.id);

    t.standAt(t.a, 0);
    ok((await peek()).item.depth_left === 2,
       `★ 사용자 턴에서는 둘 (${(await peek()).item.depth_left}) — 지금 거는 말이 이미 1다리째다`);
    t.standAt(t.a, 2);
    ok((await peek()).item.depth_left === 0,
       "★ **0 이면 «더 못 보낸다»가 자명하다** — 상한 값을 같이 적지 않는 이유다");

    /*
     * ★ **안 걸리는 방에서는 `null`** (사용자, 2026-10-15).
     *
     * 「승인」에서는 상한이 안 걸린다. 숫자를 보여주면 **있지도 않은 벽**을
     * 피해 가므로 수는 안 싣되, ⏪ **칸까지 빼던 것은 물렀다** — 같은 갈래
     * 안에서 모양이 갈리면 «빠뜨린 건가»가 생긴다.
     *
     * 🔴 **`null` 과 `0` 은 반대 뜻이다** — `0` 은 «더 못 보낸다», `null` 은
     * «상한이 없다». 섞이면 **갈 수 있는데 포기하는** 쪽으로 틀린다.
     *
     * (「끔」은 물음이 안 생긴다 — `say` 가 통째로 거절되어 봇끼리 말이 큐에
     * 들어오지 않는다.)
     */
    t.room.relay = "ask";
    const off = await peek();
    ok("depth_left" in off.item, "★ **칸은 그대로 있다** — 메세지 갈래에서는 늘 있다");
    ok(off.item.depth_left === null,
       `★ 「승인」에서는 **null** — «상한이 없다» 다 (${JSON.stringify(off.item.depth_left)})`);

    /*
     * 🔴 **권한 갈래에는 안 싣는다** (사용자): *"message 내에 있어야하는거지
     * permission에는 아니고"*. 권한을 꺼낸 봇이 할 수 있는 것은 `verdict`
     * 뿐이라, 그 옆의 숫자는 **답에 쓰이지 않는 수**다.
     */
    t.room.relay = "always";
    t.inner.queue.put({
      kind: "permission", to: t.a.id, from: t.b.name, fromId: t.b.id,
      title: "터미널 명령", command: "ls", readOnly: true,
    });
    t.inner.queue.startTurn(t.a.id);
    const perm = await peek();
    ok(perm.kind === "permission", `전제 — 권한이 먼저 나온다 (${String(perm.kind)})`);
    ok(!("depth_left" in perm.item),
       `★ **권한에는 칸이 없다** (${JSON.stringify(perm.item.depth_left)}) — 깊이는 say 쪽 이야기다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 0 은 제한 없음]`);
  {
    const t = await make(0); dirs.push(t.dir);
    const held = t.plant(t.a, t.b, 99);
    t.standAt(t.a, 99);
    const out = await t.say(t.a, "리뷰어", "백 다리째", held);
    ok(out.ok, `★ 닿을 데가 없다 (${JSON.stringify(out)})`);

    await t.mgr.setRelayDepth(t.room.id, -5);
    ok(t.room.depthCap === 0, `★ 음수는 0 으로 접는다 (${t.room.depthCap})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 처음 시작하는 say 는 사용자가 연 턴에서만]`);
  {
    /*
     * 🔴 **여기가 가지치기를 깊이 0 으로 묶는 자리다.** 사슬 깊은 데 있는
     * 봇이 아무 때나 새 대화를 시작할 수 있으면 가지가 갈린다.
     *
     * 그리고 이 판단은 **우리가 아는 것**으로 한다 — 모델이 «사용자 때문»
     * 이라고 적는 것을 믿으면 그 한 줄로 규칙이 통째로 빠져나간다.
     */
    const t = await make(12); dirs.push(t.dir);

    t.standAt(t.a, 0);
    ok((await t.say(t.a, "리뷰어", "사용자가 시킨 일이야")).ok,
       "★ 사용자가 연 턴에서는 통한다");

    t.standAt(t.a, 1);   // 다른 봇이 깨운 턴
    const deep = await t.say(t.a, "리뷰어", "갑자기 딴 얘기");
    ok(!deep.ok && deep.reason === "id null is only for user turn",
       `★ 🔴 **다른 봇이 연 턴에서는 막힌다** (${deep.reason})`);
    ok(typeof deep.queue_left === "number",
       "★ **남은 큐가 같이 온다** — 대신 할 일은 글이 아니라 칸이 가리킨다");
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 처음 시작하는 say 는 같은 봇에게 한 번만 — 무한 가지치기를 막는다]`);
  {
    /*
     * 🔴 **처음 시작하는 say 는 깊이가 1 이라 상한에 구조적으로 안 걸린다.** 묶지 않으면
     * 사용자 말 한 마디가 가지를 **무한히** 연다 — 재봤더니 한 턴에 스무 번이
     * 다 나갔다(상한 3 인 방에서).
     *
     * 「같은 봇에게 한 번」이면 **방의 봇 수가 곧 상한**이고 숫자는 안 는다.
     * 막는 것은 «같은 봇에게 또»뿐이고, 그건 **이미 말한 것**이다.
     */
    const t = await make(3); dirs.push(t.dir);
    t.standAt(t.a, 0);

    ok((await t.say(t.a, "리뷰어", "한 번")).ok, "★ 한 번은 간다");
    const again = await t.say(t.a, "리뷰어", "또");
    ok(!again.ok && again.reason === "duplicated sending error",
       `★ 🔴 **두 번째는 막힌다** (${again.reason})`);

    // 다른 봇에게는 된다 — 묶이는 것은 «같은 봇» 이다
    ok((await t.say(t.a, "테스터", "너한테도")).ok,
       "★ **다른 봇에게는 간다** — 방의 봇 수가 곧 상한이다");

    // 한 번에 여럿도 된다 — 중복만 걸러진다
    const both = await t.say(t.a, ["리뷰어", "테스터"], "둘 다");
    ok(!both.ok && both.reason === "duplicated sending error",
       `★ 섞여 있으면 **통째로 거절** (${both.reason}) — 반만 가면 알릴 길이 는다`);

    // 🔴 턴이 새로 열리면 다시 샌다 — 사용자가 또 말했으니까
    t.standAt(t.a, 0);
    (t.inner.botRuntime(t.room.id, t.a.id) as { saidZero?: Set<string> }).saidZero = new Set();
    ok((await t.say(t.a, "리뷰어", "새 턴에서")).ok,
       "★ **턴이 바뀌면 다시 샌다** — 사용자가 또 말한 것이다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 받은 id 로는 깊은 데서도 건다 — 위임은 살아 있다]`);
  {
    /*
     * §4-J 가 일부러 넣은 모양이다 — B 가 A 의 부탁을 처리하다가 C 에게
     * 물어보는 것. 받는 이가 제3자라 «답»은 아니지만 **받은 항목 때문**인 것은
     * 맞다. 막으면 일을 나눠주는 것이 **사용자와 직접 말하는 봇 하나**로 좁아진다.
     */
    const t = await make(12); dirs.push(t.dir);
    t.standAt(t.a, 0);
    const first = await t.say(t.a, "리뷰어", "이것 좀 봐줄래?");

    t.standAt(t.b, 1);   // 깨워진 턴이라 «0» 은 못 쓴다
    const on = await t.say(t.b, "구현", "그 부분 네가 짰지?", t.newest(t.b.id));
    ok(on.ok, `★ **받은 id 를 들고는 걸 수 있다** (${JSON.stringify(on)})`);
    ok(t.depthOf(t.a.id, t.newest(t.a.id)!) === 2, `★ 그래도 깊이는 는다 (${t.depthOf(t.a.id, t.newest(t.a.id)!)})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 답 안 한 옛 항목이 다른 사슬을 오염시키지 않는다]`);
  {
    /*
     * 🔴 **항목은 답해야 빠진다.** 턴의 깊이를 «몫 전체의 max» 로 재면, 아무도
     * 답 안 한 8다리짜리 하나가 그 봇의 깊이를 **영구히** 8 로 올려놓는다 —
     * 사용자가 새 대화를 시작해도 상한 근처에서 출발하고, 눈에는 «갑자기
     * 봇들이 말을 못 건다» 로만 보인다.
     *
     * **이 턴을 연 것이 이 턴의 깊이다.** 그래서 끼어들기에 손댈 것이 없다 —
     * 사용자가 말을 걸면 그 봇은 0 에서 시작하고, 거기서 뻗는 가지는 1·2·3…
     * 으로 저절로 다시 센다.
     */
    const t = await make(3); dirs.push(t.dir);
    t.plant(t.b, t.a, 8);   // 아무도 답 안 한 옛 항목
    ok(t.inner.queue.pending(t.b.id).length === 1, "★ 전제: 답 안 한 8다리짜리가 있다");

    await t.mgr.send(t.room.id, "그거 말고 이거 해줘", undefined, t.b.id);
    await t.settle();
    ok(t.inner.queue.pending(t.b.id).length === 1,
       "★ **옛 항목은 그대로 남는다** — 거리를 고치려고 할 말을 건드리지 않는다");

    const out = await t.say(t.b, "구현", "이제 물어볼게");
    ok(out.ok, `★ **그래도 새 대화는 간다** (${JSON.stringify(out)})`);
    ok(t.depthOf(t.a.id, t.newest(t.a.id)!) === 1,
       `★ 1다리째부터 (${t.depthOf(t.a.id, t.newest(t.a.id)!)}) — 옛 사슬이 안 섞인다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 사용자가 말을 걸어도 **그 봇이 들고 있던 깊은 사슬**은 안 되살아난다]`);
  {
    /*
     * 🔴 **한 턴에 사용자 말과 밀린 깊은 항목이 같이 실릴 수 있다.** 그때
     * 턴을 0 으로 내리면 그 깊은 사슬의 답까지 1다리째가 되어, **사용자가
     * 그 봇에게 한 마디만 하면 돌던 사슬이 통째로 되살아난다.**
     *
     * 사용자 말은 «깊이 0 짜리 항목이 하나 더 온 것»이다 — 그래서 둘 중
     * **깊은 쪽**을 쓰면 저절로 맞는다.
     */
    const t = await make(3); dirs.push(t.dir);
    const deep = t.plant(t.b, t.a, 8);   // 리뷰어가 들고 있던 8다리짜리

    await t.mgr.send(t.room.id, "리뷰어야 이것도 봐줘", undefined, t.b.id);
    await t.settle();

    // ① 사용자가 시킨 일로 새로 거는 것은 **1다리째** — 막히면 안 된다
    const fresh = await t.say(t.b, "구현", "사용자가 시킨 건데");
    ok(fresh.ok && t.depthOf(t.a.id, t.newest(t.a.id)!) === 1,
       `★ **새 가닥은 1다리째** (${t.depthOf(t.a.id, t.newest(t.a.id)!)}) — 사용자가 방금 말했으니까`);

    // ② 그런데 8다리짜리에 답하는 것은 **9다리째** — 상한 3 에 걸린다
    const old8 = await t.say(t.b, "구현", "아까 그거 말인데", deep);
    ok(!old8.ok && old8.reason === "max depths error",
       `★ 🔴 **옛 사슬은 그대로 깊다** (${old8.reason}) — 한 마디로 안 되살아난다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 반응하면 닫힌다 — 받는 이가 임자든 아니든]`);
  {
    /*
     * 🔴 **열어둘 수가 없다.** 열어두는 뜻은 «이 가닥을 아직 들고 있다, 답을
     * 기다린다» 인데, 턴이 시작될 때 큐를 **스냅샷으로 떼어내므로**(2-H) 그
     * 턴 안에서 기다릴 길이 없다. 다음 턴에 **같은 것을 또 보는 것**뿐이고,
     * 그때 새로 아는 것도 없다.
     *
     * 🔴 **그리고 안 닫으면 영구 발판이 된다.** 제3자에게 넘긴 뒤 그 항목을
     * 계속 가리키면 깊이가 2·3·2·3 으로 영영 돈다.
     */
    const t = await make(12); dirs.push(t.dir);
    // 테스터가 보낸 1다리짜리를 구현이 들고 있다
    const got = t.plant(t.a, t.c, 1);

    // **임자(테스터)가 아니라 제3자(리뷰어)에게** 반응한다
    const out = await t.say(t.a, "리뷰어", "테스터 말 때문인데", got);
    ok(out.ok, `★ 제3자에게 보낼 수 있다 (${JSON.stringify(out.got)})`);
    ok(t.inner.queue.find(t.a.id, got) === undefined,
       "★ 🔴 **그래도 닫힌다** — 들고 있어 봐야 그 턴에서 할 수 있는 것이 없다");

    const again = await t.say(t.a, "리뷰어", "같은 걸 또", got);
    ok(!again.ok, `★ **같은 걸 두 번 못 집는다** (${again.reason}) — 발판이 안 된다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 여러 명에게 한 번에 — 몫은 따로, 깊이는 같다]`);
  {
    const t = await make(12); dirs.push(t.dir);
    const got = t.plant(t.a, t.c, 4);

    const out = await t.say(t.a, ["리뷰어", "테스터"], "둘 다 봐줘", got);
    /* ★ 돌려주는 `to` 에는 **사용자가 끝에 선다** — 언제나 받으므로 */
    ok(out.ok && out.got?.join("·") === "리뷰어·테스터·user",
       `★ 둘에게 간다 (${JSON.stringify(out.got)}) — **우리가 고른 이름**으로 돌려준다`);
    const mine = t.newest(t.b.id)!, hers = t.newest(t.c.id)!;
    ok(t.depthOf(t.b.id, mine) === 5 && t.depthOf(t.c.id, hers) === 5,
       "★ **깊이는 같다** — 한 번의 반응이니까");

    /*
     * 🔴 **인용은 임자에게 가는 몫에만** — 제3자에게 붙이면 §4.1.1 이 샌다.
     * 테스터는 그 항목의 임자라 제 글을 다시 보는 것이고, 리뷰어는 아니다.
     */
    const toJudge = t.inner.queue.find(t.b.id, mine);
    const toTester = t.inner.queue.find(t.c.id, hers);
    ok(toJudge?.kind === "message" && toJudge.about === undefined,
       "★ 🔴 **제3자에게는 인용이 안 간다**");
    ok(toTester?.kind === "message" && toTester.about !== undefined,
       "★ 임자에게는 간다 — 제 글을 다시 보는 것이라 새는 것이 없다");

    const one = t.room.messages.filter(
      (m) => m.role === "agent" && m.authorBotId === t.a.id && m.text === "둘 다 봐줘");
    ok(one.length === 1 && one[0]!.deliveredTo.length === 2,
       `★ **말풍선은 하나**고 받는 이 칩이 둘이다 (${one[0]?.deliveredTo.length})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «승인» — 답까지 전부 묻는다. 그래서 상한이 할 일이 없다]`);
  {
    /*
     * ⏪ 한때 **답은 승인 면제**였다. 근거가 *"안 그러면 이미 물어본 쪽이
     * 멈춘 채 남는다"* 였는데 — **`say` 는 막힌 적이 없다.** 묻는 쪽은 제 턴을
     * 이미 닫았고, 답이 안 오면 그냥 안 오는 것이다(§16).
     *
     * 면제가 치르던 값이 더 컸다: 「승인」이 **«모든 대화를 승인»이 아니게**
     * 되고, 답만 주고받는 고리가 **어느 문도 안 타고** 빠져나갔다.
     */
    const t = await make(1); dirs.push(t.dir);
    t.room.relay = "ask";
    const held = t.plant(t.a, t.b, 9);
    t.standAt(t.a, 9);   // 상한 1 을 한참 넘는 깊이

    const sent = t.say(t.a, "리뷰어", "봐줄래?", held);
    await t.until(() => t.cards.length > 0, "승인 카드가 안 떴다");
    const card = t.cards.shift()!;
    ok(card.req.title.includes("10다리째"),
       `★ **몇 다리째인지 보인다** (${card.req.title}) — 길어지는 것이 눈에 보여야 끊는다`);
    card.settle("aio-relay-allow");
    const first = await sent;
    ok(first.ok, "★ **깊이 상한은 안 걸린다** — 사람이 매 호출을 보고 있다");

    // 답도 마찬가지로 묻는다
    t.standAt(t.b, 10);
    const back = t.say(t.b, "구현", "이렇습니다", t.newest(t.b.id));
    await t.until(() => t.cards.length > 0, "답에는 안 물었다");
    ok(true, "★ 🔴 **답도 묻는다** — 그래야 «모든 대화를 승인» 이 참이 된다");
    t.cards.shift()!.settle("aio-relay-reject");
    ok(!(await back).ok, "★ 막으면 안 간다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «끄기» — 답도 포함해서 꺼진다]`);
  {
    const t = await make(12); dirs.push(t.dir);
    t.standAt(t.a, 0);
    const first = await t.say(t.a, "리뷰어", "이것 좀");

    t.room.relay = "off";
    t.standAt(t.b, 1);
    const out = await t.say(t.b, "구현", "답입니다", t.newest(t.b.id));
    ok(!out.ok && out.reason === "relay is off",
       `★ **답도 안 나간다** (${out.reason}) — «대화 기능 off» 가 말 그대로다`);
    ok(t.cards.length === 0, "★ 사람도 안 깨운다");
    t.mgr.dispose();
  }

  await nap(100);
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과`);
}

main()
  .then(() => new Promise((r) => setTimeout(r, 50)))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
