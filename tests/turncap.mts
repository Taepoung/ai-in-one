/**
 * **턴 상한 — «내 말 한 마디당 봇들이 도는 턴»** (v3.0 4-L).
 *
 * ```
 * 세는 것   봇이 돈 턴. **언제나 센다** (예외를 두면 알림 고리가 안 잡힌다)
 * 리셋      **사용자 메시지가 오면 0**
 * 닿으면    멈추고 «더 갈까요 [+N턴] [그만]»
 * [그만]    **전체 중지**와 같다 — 이 호출만 막으면 다음 봇 호출이 이어진다
 * ```
 *
 * 🔴 상한이 **「무조건 허용」일 때만** 쓰인다고 적었던 적이 있다. 구멍이
 * 있었다 — 알림 턴은 `say` 승인과 무관하게 돌므로, 「물어봄」에서 **안 답하는
 * 봇을 영원히 깨우는 고리**가 안 잡힌다. 예외를 없애면 구멍도 없어진다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { PermissionRequest } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const busy = (s: string) => !["idle", "error"].includes(s);

interface SayOut { ok: boolean; reason?: string }

async function make(cap: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-cap-"));
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
    cancelPermissions: () => {
      for (const c of cards.splice(0, cards.length)) c.settle(null);
    },
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
    title: "상한", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
  });
  // 상한은 **새로 거는 것**에만 걸리므로 승인 문은 열어둔다
  room.relay = "always";
  room.turnCap = cap;
  const [a, b] = room.participants as [typeof room.participants[0], typeof room.participants[0]];

  const settle = async () => {
    for (let i = 0; i < 1200; i++) {
      if (!busy(mgr.statusOf(room.id))) return;
      await nap(25);
    }
    throw new Error("FAIL: 전제가 안 섰다 — 방이 안 조용해진다");
  };
  const say = async (to: string, text: string): Promise<SayOut> => {
    const out = await mgr.mcpCall(`${room.id}:${a.id}`, "say", { to, text });
    return out.isError ? { ok: false, reason: out.text } : JSON.parse(out.text) as SayOut;
  };
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 1200; i++) { if (cond()) return; await nap(25); }
    throw new Error("FAIL: 전제가 안 섰다 — " + what);
  };
  const turns = () =>
    ((mgr as unknown as { runtimes: Map<string, { turns: number }> })
      .runtimes.get(room.id)?.turns ?? 0);

  return { dir, mgr, room, a, b, cards, settle, say, until, turns };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 봇이 돈 턴을 센다 — 사용자 말이 오면 0]`);
  {
    const t = await make(12); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();
    ok(t.turns() === 1, `★ 사용자가 부른 턴도 **센다** (${t.turns()}) — 예외를 두면 구멍이 생긴다`);

    await t.mgr.send(t.room.id, "또", undefined, t.b.id);
    await t.settle();
    ok(t.turns() === 1,
       `★ **사용자가 말을 걸면 0 부터 다시** (${t.turns()}) — 말을 거는 것이 곧 «이제 내가 본다»다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 상한에 닿으면 멈추고 묻는다 — «더 갈까요»]`);
  {
    const t = await make(1); dirs.push(t.dir);
    // 상한 1 — 사용자 턴 하나로 이미 꽉 찬다
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();
    ok(t.turns() === 1, "★ 전제: 한 턴을 돌았다");

    const sent = t.say("리뷰어", "한 번 더 돌자");
    await t.until(() => t.cards.length > 0, "«더 갈까요» 를 안 물었다");
    const card = t.cards.shift()!;
    ok(card.req.title.includes("더 갈까요"), `★ **멈추고 묻는다** (${card.req.title})`);
    ok(card.req.options.map((o) => o.name).join(" · ") === "+1턴 · 그만",
       `★ 길은 둘이다 (${card.req.options.map((o) => o.name).join(" · ")})`);

    card.settle("aio-cap-more");
    const out = await sent;
    ok(out.ok, `★ **«더»를 고르면 간다** (${JSON.stringify(out)})`);
    /*
     * 🔴 **`turns` 를 바로 재면 안 된다.** 간 말이 상대를 깨우고, 그 턴이
     * 또 하나를 센다 — 재려는 것(구간이 새로 열렸나)이 아니라 **그 다음에
     * 일어난 일**을 재게 된다. 대신 **사용자에게 적은 자국**을 본다.
     */
    ok(t.room.messages.some((m) => m.role === "system" && m.text.includes("더 돌도록")),
       "★ **구간이 새로 열린다 — 그리고 방에 적는다**(§0: 조용히 바꾸지 않는다)");
    ok((t.room.turnCap ?? 0) === 1,
       `★ **상한 값은 그대로다** (${t.room.turnCap}) — 올리는 것이 아니라 그만큼 다시다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ «그만»은 전체 중지와 같다]`);
  {
    const t = await make(1); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();
    // 자리를 비운 상태로 둔다 — 중지가 이것을 내리는지 같이 본다
    t.b.answerPolicy = "auto";
    /*
     * ★ **큐에 거리를 남겨둔다** — «그만» 이 이것까지 치우는지 본다.
     *
     * 🔴 안 치우면 **멈추라고 눌렀는데 하던 이야기가 이어진다** — 다음에
     * 누가 그 봇을 깨우는 순간 밀린 말이 그대로 나간다.
     */
    const inner = t.mgr as unknown as {
      queue: { put(x: unknown): string; pending(id: string): unknown[] };
    };
    inner.queue.put({
      kind: "message", to: t.b.id, from: t.a.name, fromId: t.a.id, text: "밀려 있던 말",
    });
    ok(inner.queue.pending(t.b.id).length === 1, "★ 전제: 큐에 하나 들어 있다");

    const sent = t.say("리뷰어", "더 가자");
    await t.until(() => t.cards.length > 0, "«더 갈까요» 를 안 물었다");
    t.cards.shift()!.settle("aio-cap-stop");

    const out = await sent;
    ok(!out.ok && (out.reason ?? "").includes("상한"), `★ 그 호출은 막힌다 (${out.reason})`);
    ok(t.b.answerPolicy === "ask",
       "★ 🔴 **«무조건 허용»도 내려간다** — 멈추라고 누른 사람의 뜻은 거기까지다");
    ok(!t.room.staged, "★ 올려둔 것도 같이 내린다");
    ok(inner.queue.pending(t.b.id).length === 0 && inner.queue.pending(t.a.id).length === 0,
       "★ 🔴 **MCP 큐도 비운다** — 안 비우면 다음에 깨우는 순간 밀린 말이 나간다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 0 은 «제한 없음» — «한 턴도 안 돈다»가 아니다]`);
  {
    /*
     * 🔴 **같은 뜻을 두 군데서 말하지 않는다.** «봇끼리 한 턴도 안 돈다»는
     * `relay: "off"` 가 할 일이다. 숫자 칸의 0 이 그걸 또 하면 **끔과 0 이
     * 뭐가 다른지**를 아무도 답할 수 없다.
     */
    const t = await make(0); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();
    // 상한이 1 이었으면 여기서 물었을 자리다
    const out = await t.say("리뷰어", "계속 가자");
    ok(out.ok, `★ **안 묻고 간다** (${JSON.stringify(out)})`);
    ok(t.cards.length === 0, "★ 닿을 데가 없으니 카드도 안 뜬다");

    await t.mgr.setTurnCap(t.room.id, -5);
    ok(t.room.turnCap === 0, `★ 음수는 0 으로 접는다 (${t.room.turnCap}) — 안 세는 쪽이 짐작이 덜 섞인다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 답은 상한을 안 탄다]`);
  {
    /*
     * 🔴 답까지 막으면 **이미 물어본 쪽이 멈춘 채 남는다.** 상한은 «새로
     * 시작하기»에 거는 것이지 «이미 온 질문에 대답하기»에 거는 것이 아니다.
     * 그리고 답에 상한을 또 세면 **왕복마다 깎인다.**
     */
    const t = await make(1); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();

    // 구현이 받아둔 가닥 하나 — 이게 열려 있어야 «답» 이 성립한다
    const inner = t.mgr as unknown as {
      queue: { put(x: unknown): string };
    };
    const qid = inner.queue.put({
      kind: "message", to: t.a.id, from: t.b.name, fromId: t.b.id, text: "빌드 왜 깨졌어?",
    });

    const out = await t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say",
      { to: "리뷰어", text: "의존성 판이 어긋났습니다.", id: qid },
    );
    const body = JSON.parse(out.text) as SayOut;
    ok(body.ok, `★ **상한이 꽉 차도 답은 간다** (${JSON.stringify(body)})`);
    ok(t.cards.length === 0, "★ 그리고 사람을 안 깨운다");
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
