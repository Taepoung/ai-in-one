/**
 * **세 칸과 주고받기 상한** (v3.0 4-L).
 *
 * ```
 * 끄기        대화 기능 off — **답도 포함**
 * 승인        say 마다 승인 카드 — **답도 포함.** 그래서 상한이 할 일이 없다
 * 무조건 허용  자유. 대신 **주고받는 횟수** 상한
 * ```
 *
 * **세는 것이 곧 턴이고 돈이다** — 큐에 한 줄 들어가면 상대가 깨어나 한 턴을
 * 돈다. 사용자가 말을 걸면 0 부터 다시 센다.
 *
 * 🔴 **`say` 를 부르는 순간 센다.** 그래야 넘칠 때 **그 자리에서 거절**된다 —
 * 카드도, 큐 비우기도, «더 갈까요»도 필요 없다. 턴이 열리는 자리에서 막으면
 * 셋 다 필요해진다(그렇게 지었다가 걷어냈다).
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
  room.relayCap = cap;
  const [a, b] = room.participants as [typeof room.participants[0], typeof room.participants[0]];
  const inner = mgr as unknown as {
    queue: BotQueue;
    runtimes: Map<string, { relayed: number }>;
    botRuntime(roomId: string, botId: string): { fromUser?: boolean };
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
  /** 「이 턴을 사용자가 열었다/안 열었다」를 세워둔다 — 진짜로는 `runQueue` 가 한다 */
  const openedBy = (bot: { id: string }, user: boolean) => {
    inner.botRuntime(room.id, bot.id).fromUser = user;
  };
  /** 지금까지 몇 번 주고받았나 */
  const relayed = () => inner.runtimes.get(room.id)?.relayed ?? 0;
  const bump = (n: number) => {
    const rt = inner.runtimes.get(room.id);
    if (rt) rt.relayed = n;
  };
  return { dir, mgr, room, a, b, cards, inner, settle, until, say, openedBy, relayed, bump };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 주고받을 때마다 센다 — 사용자가 말하면 0]`);
  {
    const t = await make(12); dirs.push(t.dir);
    t.openedBy(t.a, true);
    await t.say(t.a, "리뷰어", "하나");
    ok(t.relayed() === 1, `★ 한 번 걸었으니 1 (${t.relayed()})`);

    await t.say(t.a, "리뷰어", "둘");
    ok(t.relayed() === 2,
       `★ **부채꼴도 센다** (${t.relayed()}) — 같은 사람에게 두 번도 턴 둘이다`);

    await t.mgr.send(t.room.id, "그만하고 이거 해줘", undefined, t.a.id);
    await t.settle();
    ok(t.relayed() === 0,
       `★ **사용자가 말을 걸면 0 부터 다시** (${t.relayed()}) — «이제 내가 본다»다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 상한에 닿으면 — 그 자리에서 거절된다]`);
  {
    const t = await make(3); dirs.push(t.dir);
    t.openedBy(t.a, true);
    t.bump(3);   // 이미 셋을 주고받았다

    const out = await t.say(t.a, "리뷰어", "한 번 더");
    ok(!out.ok, `★ **거절된다** (${out.reason})`);
    ok((out.reason ?? "").includes("3"), "★ **상한이 얼마인지 말해준다**");
    ok((out.reason ?? "").includes("사용자"),
       "★ **어떻게 풀리는지도** — 사용자가 말을 걸면 0 부터 다시다");
    ok(t.cards.length === 0,
       "★ 🔴 **카드가 안 뜬다** — 부르는 순간 알 수 있어 사람을 안 깨운다");
    ok(t.inner.queue.pending(t.b.id).length === 0,
       "★ 🔴 **큐에도 안 들어간다** — 그래서 나중에 비울 것도 없다");
    ok(t.relayed() === 3, `★ **거절은 안 센다** (${t.relayed()}) — 턴을 안 만들었다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 0 은 제한 없음]`);
  {
    const t = await make(0); dirs.push(t.dir);
    t.openedBy(t.a, true);
    t.bump(999);
    const out = await t.say(t.a, "리뷰어", "천 번째");
    ok(out.ok, `★ 닿을 데가 없다 (${JSON.stringify(out)})`);

    await t.mgr.setRelayCap(t.room.id, -5);
    ok(t.room.relayCap === 0, `★ 음수는 0 으로 접는다 (${t.room.relayCap})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 id "0" 은 사용자가 연 턴에서만]`);
  {
    /*
     * 🔴 **여기가 가지치기를 막는 자리다.** 사슬 깊은 데 있는 봇이 아무 때나
     * 새 대화를 시작할 수 있으면 가지가 갈리고, 턴이 **곱셈으로** 는다.
     *
     * 그리고 이 판단은 **우리가 아는 것**으로 한다 — 모델이 «사용자 때문»
     * 이라고 적는 것을 믿으면 그 한 줄로 규칙이 통째로 빠져나간다.
     */
    const t = await make(12); dirs.push(t.dir);

    t.openedBy(t.a, true);
    ok((await t.say(t.a, "리뷰어", "사용자가 시킨 일이야")).ok,
       "★ 사용자가 연 턴에서는 «0» 이 통한다");

    t.openedBy(t.a, false);   // 다른 봇이 깨운 턴
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
     * 물어보는 것. 받는 이가 제3자라 «답»은 아니지만, **받은 항목 때문**인
     * 것은 맞다. 막으면 일을 나눠주는 것이 **사용자와 직접 말하는 봇 하나**
     * 로 좁아진다.
     */
    const t = await make(12); dirs.push(t.dir);
    t.openedBy(t.a, true);
    const first = await t.say(t.a, "리뷰어", "이것 좀 봐줄래?");

    // 리뷰어는 깨워진 턴이다 — «0» 은 못 쓴다
    t.openedBy(t.b, false);
    const on = await t.say(t.b, "구현", "그 부분 네가 짰지?", first.id);
    ok(on.ok, `★ **받은 id 를 들고는 걸 수 있다** (${JSON.stringify(on)})`);
    ok(t.inner.queue.find(t.b.id, first.id!) === undefined,
       "★ 임자에게 보냈으니 그 항목은 닫힌다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «승인» — 답까지 전부 묻는다. 그래서 상한이 할 일이 없다]`);
  {
    /*
     * ⏪ 한때 **답은 승인 면제**였다. 근거가 *"안 그러면 이미 물어본 쪽이
     * 멈춘 채 남는다"* 였는데 — **`say` 는 막힌 적이 없다.** 묻는 쪽은 제 턴을
     * 이미 닫았고, 답이 안 오면 그냥 안 오는 것이다(§16: 사용자가 무시했을
     * 때와 똑같다).
     *
     * 면제가 치르던 값이 더 컸다: 「승인」이 **«모든 대화를 승인»이 아니게**
     * 되고, 답만 주고받는 고리가 **어느 문도 안 타고** 빠져나갔다.
     */
    const t = await make(1); dirs.push(t.dir);
    t.room.relay = "ask";
    t.openedBy(t.a, true);
    t.bump(9);   // 상한 1 을 한참 넘겨둔다

    const sent = t.say(t.a, "리뷰어", "봐줄래?");
    await t.until(() => t.cards.length > 0, "승인 카드가 안 떴다");
    const card = t.cards.shift()!;
    ok(card.req.title.includes("10번째"),
       `★ **몇 번째인지 보인다** (${card.req.title}) — 길어지는 것이 눈에 보여야 끊는다`);
    card.settle("aio-relay-allow");
    const first = await sent;
    ok(first.ok, "★ **상한은 안 걸린다** — 사람이 매 호출을 보고 있다");

    // 답도 마찬가지로 묻는다
    t.openedBy(t.b, false);
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
    t.openedBy(t.a, true);
    const first = await t.say(t.a, "리뷰어", "이것 좀");

    t.room.relay = "off";
    t.openedBy(t.b, false);
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
