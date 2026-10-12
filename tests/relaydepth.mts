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
 * 🔴 **깊이로 고른 까닭은 «언제 아느냐»다.** 턴 수는 **이미 일어난 일**이라
 * 막으려면 턴이 열리는 자리에서 사람을 불러 세워야 했다 — 카드가 뜨고, 큐를
 * 비우고, «더 갈까요»가 생겼다. 깊이는 `say` 를 **부르는 그 순간** 알 수 있어서
 * **그 자리에서 거절**된다. 그래서 그 셋이 통째로 없어졌다.
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
  /** 그 봇이 하듯 — 지금 제 턴의 깊이에서 한 다리 더 건다 */
  const say = async (
    from: { id: string }, to: string, text: string, id?: string,
  ): Promise<SayOut> => {
    const out = await mgr.mcpCall(`${room.id}:${from.id}`, "say", { to, text, ...(id ? { id } : {}) });
    return out.isError ? { ok: false, reason: out.text } : JSON.parse(out.text) as SayOut;
  };
  /** 「이 봇은 지금 N다리째 턴을 돌고 있다」를 세워둔다 */
  const standAt = (bot: { id: string }, depth: number) => {
    inner.botRuntime(room.id, bot.id).depth = depth;
  };
  const depthOf = (botId: string, qid: string) => {
    const item = inner.queue.find(botId, qid);
    return item && item.kind === "message" ? item.depth : undefined;
  };
  return { dir, mgr, room, a, b, cards, inner, settle, until, say, standAt, depthOf };
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

  console.log(`${NL}[🔴 id 를 빼도 깊이가 안 되돌아간다]`);
  {
    /*
     * 🔴 깊이를 `say` 의 `id` 로 세면 **인자 하나를 빼는 것만으로** 1 로
     * 되돌아간다 — 막으려던 고리가 거기로 통째로 빠져나간다. 깊이는
     * **턴에 붙는 값**이라 인자로는 못 흔든다.
     */
    const t = await make(12); dirs.push(t.dir);
    t.standAt(t.a, 5);
    const out = await t.say(t.a, "리뷰어", "새 가닥인 척");
    ok(t.depthOf(t.b.id, out.id!) === 6,
       `★ **id 가 없어도 6다리째다** (${t.depthOf(t.b.id, out.id!)}) — 턴이 깊이를 들고 있다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 상한에 닿으면 — 그 자리에서 거절된다]`);
  {
    const t = await make(3); dirs.push(t.dir);
    t.standAt(t.a, 3);   // 여기서 거는 말은 4다리째 — 상한 3 을 넘는다
    const out = await t.say(t.a, "리뷰어", "한 다리 더");

    ok(!out.ok, `★ **거절된다** (${out.reason})`);
    ok((out.reason ?? "").includes("3"), "★ **상한이 얼마인지 말해준다**");
    ok((out.reason ?? "").includes("사용자"),
       "★ **어떻게 풀리는지도** — 사용자가 말을 걸면 깊이가 0 부터 다시다");
    ok(t.cards.length === 0,
       "★ 🔴 **카드가 안 뜬다** — 깊이는 부르는 순간 알 수 있어 사람을 안 깨운다");
    ok(t.inner.queue.pending(t.b.id).length === 0,
       "★ 🔴 **큐에도 안 들어간다** — 그래서 나중에 비울 것도 없다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 0 은 제한 없음]`);
  {
    const t = await make(0); dirs.push(t.dir);
    t.standAt(t.a, 99);
    const out = await t.say(t.a, "리뷰어", "백 다리째");
    ok(out.ok, `★ 닿을 데가 없다 (${JSON.stringify(out)})`);

    await t.mgr.setRelayDepth(t.room.id, -5);
    ok(t.room.depthCap === 0, `★ 음수는 0 으로 접는다 (${t.room.depthCap})`);
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
    t.standAt(t.a, 9);   // 상한 1 을 한참 넘는 깊이

    const sent = t.say(t.a, "리뷰어", "봐줄래?");
    await t.until(() => t.cards.length > 0, "승인 카드가 안 떴다");
    const card = t.cards.shift()!;
    ok(card.req.title.includes("10다리째"),
       `★ **몇 다리째인지 보인다** (${card.req.title}) — 길어지는 것이 눈에 보여야 끊는다`);
    card.settle("aio-relay-allow");
    ok((await sent).ok, "★ **깊이 상한은 안 걸린다** — 사람이 매번 보고 있다");

    // 답도 마찬가지로 묻는다
    t.standAt(t.b, 10);
    const back = t.say(t.b, "구현", "이렇습니다", undefined);
    await t.until(() => t.cards.length > 0, "답에는 안 물었다");
    ok(true, "★ 🔴 **답도 묻는다** — 그래야 «모든 대화를 승인» 이 참이 된다");
    t.cards.shift()!.settle("aio-relay-reject");
    ok(!(await back).ok, "★ 막으면 안 간다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «끄기» — 답도 포함해서 꺼진다]`);
  {
    const t = await make(12); dirs.push(t.dir);
    t.room.relay = "off";
    t.standAt(t.b, 1);
    const out = await t.say(t.b, "구현", "답입니다");
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
