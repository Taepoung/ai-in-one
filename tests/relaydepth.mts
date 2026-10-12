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
 * id = "0"   사용자가 방금 한 말 때문에   ← 사용자가 연 턴에서만
 * id = "x7"  큐 항목 때문에
 * ```
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { BotQueue } from "../src/core/botQueue.js";
import type { PermissionRequest } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const busy = (s: string) => !["idle", "error"].includes(s);

interface SayOut { ok: boolean; reason?: string; id?: string }

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
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const room = await mgr.createRoom({
    title: "깊이", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
  });
  room.relay = "always";
  room.depthCap = cap;
  const [a, b] = room.participants as [typeof room.participants[0], typeof room.participants[0]];
  const inner = mgr as unknown as {
    queue: BotQueue;
    botRuntime(roomId: string, botId: string): { depth?: number };
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
    from: { id: string }, to: string, text: string, id = "0",
  ): Promise<SayOut> => {
    const out = await mgr.mcpCall(`${room.id}:${from.id}`, "say", { to, text, id });
    return out.isError ? { ok: false, reason: out.text } : JSON.parse(out.text) as SayOut;
  };
  /** 「이 봇은 지금 N다리째 턴을 돌고 있다」를 세워둔다 — 진짜로는 `runQueue` 가 한다 */
  const standAt = (bot: { id: string }, depth: number) => {
    inner.botRuntime(room.id, bot.id).depth = depth;
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
  return { dir, mgr, room, a, b, cards, inner, settle, until, say, standAt, plant, depthOf };
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
    ok(t.depthOf(t.b.id, first.id!) === 1,
       `★ **사용자 턴에서 건 말은 1다리째** (${t.depthOf(t.b.id, first.id!)})`);

    // 리뷰어가 그 말을 받아 도는 턴 — 거기서 거는 말은 2다리째다
    t.standAt(t.b, 1);
    const second = await t.say(t.b, "구현", "그건 이렇습니다", first.id);
    ok(t.depthOf(t.a.id, second.id!) === 2,
       `★ **답도 반응이라 한 다리 는다** (${t.depthOf(t.a.id, second.id!)})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 id 를 바꿔도 깊이가 안 되돌아간다]`);
  {
    /*
     * 🔴 깊이를 `say` 의 `id` 로 세면 **인자 하나로** 1 로 되돌아간다 —
     * 막으려던 고리가 거기로 통째로 빠져나간다. 깊이는 **턴에 붙는 값**이다.
     */
    const t = await make(12); dirs.push(t.dir);
    // 큐에는 **1다리째**라고 적힌 항목을 심어둔다 — 턴은 5다리째다
    const shallow = t.plant(t.a, t.b, 1);
    t.standAt(t.a, 5);
    const first = await t.say(t.a, "리뷰어", "다섯 다리째 턴에서", shallow);
    ok(t.depthOf(t.b.id, first.id!) === 6,
       `★ **6다리째다** (${t.depthOf(t.b.id, first.id!)}) — 항목에 1 이라 적혀 있어도 턴이 이긴다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 상한에 닿으면 — 그 자리에서 거절된다]`);
  {
    const t = await make(3); dirs.push(t.dir);
    const held = t.plant(t.a, t.b, 3);
    t.standAt(t.a, 3);   // 여기서 거는 말은 4다리째 — 상한 3 을 넘는다
    const out = await t.say(t.a, "리뷰어", "한 다리 더", held);

    ok(!out.ok, `★ **거절된다** (${out.reason})`);
    ok((out.reason ?? "").includes("3") && (out.reason ?? "").includes("4다리째"),
       "★ **상한과 지금 몇 다리째인지를 같이 말해준다**");
    ok((out.reason ?? "").includes("사용자"),
       "★ **어떻게 풀리는지도** — 사용자가 말을 걸면 깊이가 0 부터 다시다");
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
    const peek = async () =>
      JSON.parse((await t.mgr.mcpCall(`${t.room.id}:${t.a.id}`, "check_queue", {})).text) as
        { depth_left?: number };

    t.standAt(t.a, 0);
    ok((await peek()).depth_left === 2,
       `★ 사용자 턴에서는 둘 (${(await peek()).depth_left}) — 지금 거는 말이 이미 1다리째다`);
    t.standAt(t.a, 2);
    ok((await peek()).depth_left === 0,
       "★ **0 이면 «더 못 보낸다»가 자명하다** — 상한 값을 같이 적지 않는 이유다");

    /*
     * 🔴 **안 걸리는 방에는 아예 안 싣는다.** 「승인」·「끔」에서는 상한이
     * 안 걸리는데 숫자를 보여주면 **있지도 않은 벽**을 피해 가게 된다.
     */
    t.room.relay = "ask";
    ok((await peek()).depth_left === undefined, "★ 「승인」에서는 칸 자체가 없다");
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

  console.log(`${NL}[🔴 id "0" 은 사용자가 연 턴에서만]`);
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
       "★ 사용자가 연 턴에서는 «0» 이 통한다");

    t.standAt(t.a, 1);   // 다른 봇이 깨운 턴
    const deep = await t.say(t.a, "리뷰어", "갑자기 딴 얘기");
    ok(!deep.ok && (deep.reason ?? "").includes("0"),
       `★ 🔴 **다른 봇이 연 턴에서는 막힌다** (${deep.reason})`);
    ok((deep.reason ?? "").includes("check_queue"),
       "★ **대신 뭘 쓰라고 말해준다** — 거절은 언제나 «왜 + 어떻게»다");
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
    const on = await t.say(t.b, "구현", "그 부분 네가 짰지?", first.id);
    ok(on.ok, `★ **받은 id 를 들고는 걸 수 있다** (${JSON.stringify(on)})`);
    ok(t.depthOf(t.a.id, on.id!) === 2, `★ 그래도 깊이는 는다 (${t.depthOf(t.a.id, on.id!)})`);
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
    const back = t.say(t.b, "구현", "이렇습니다", first.id);
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
    const out = await t.say(t.b, "구현", "답입니다", first.id);
    ok(!out.ok && (out.reason ?? "").includes("꺼져"),
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
