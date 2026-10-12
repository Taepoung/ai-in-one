/**
 * **`say(to, text, id?)` — 말 걸기와 가닥** (v3.0 4-J).
 *
 * 여기서 재는 것은 **문이 제대로 서 있나**다:
 *
 * ```
 * id 없음                     새 가닥   → 릴레이 설정 → 승인
 * id 있고 to 가 그 가닥의 임자   **답**    → 둘 다 면제. 그 항목이 닫힌다
 * id 있고 to 가 제3자          새 가닥   → 그 항목은 **열린 채로**
 * ```
 *
 * 🔴 **제일 중요한 줄은 새는 쪽이다.** B 가 C 에게 말할 때 `id` 는 B 의
 * 사정이고, 거기 실린 A 의 질문이 C 에게 가면 A↔B 가 통째로 샌다(§4.1.1).
 * «답일 때만 인용» 이 지켜지는지를 한 칸에서 본다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { BotQueue } from "../src/core/botQueue.js";
import type { PermissionRequest, Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const busy = (s: string) => !["idle", "error"].includes(s);

interface SayOut {
  ok: boolean;
  reason?: string;
  can_call?: string[];
  to?: string[];
  queue_left: number;
  items?: Array<{ id: string }>;
}


async function make(hold = 60) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-say-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();

  /** 떠 있던 승인 카드들 — 검사가 손으로 답한다 */
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
    env: { AIO_FAKE_HOLD: String(hold), AIO_FAKE_STATE: state, AIO_FAKE_ECHO: "1" },
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
    title: "말 걸기",
    bots: [{ agentId: "alpha" }, { agentId: "beta" }, { agentId: "gamma" }],
  });
  const [a, b, c] = room.participants as [typeof room.participants[0], typeof room.participants[0], typeof room.participants[0]];

  const inner = mgr as unknown as { queue: BotQueue };
  const settle = async () => {
    for (let i = 0; i < 1200; i++) {
      if (!busy(mgr.statusOf(room.id))) return;
      await nap(25);
    }
    throw new Error("FAIL: 전제가 안 섰다 — 방이 안 조용해진다");
  };
  const prompts = async (): Promise<string[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; text: string })
        .filter((e) => e.t === "prompt").map((e) => e.text);
    } catch { return []; }
  };
  /** 전제는 결론보다 먼저 선다 — 안 서면 «실패»가 아니라 «전제가 안 섰다» */
  const until = async (cond: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 1200; i++) { if (await cond()) return; await nap(25); }
    throw new Error("FAIL: 전제가 안 섰다 — " + what);
  };
  /** 봇이 하듯 — `say` 를 부른다 */
  /**
   * 봇이 하듯 — `say` 를 부른다.
   *
   * `id` 를 안 주면 «사용자가 방금 한 말 때문에»(`"0"`)로 친다. 그러려면 그
   * 턴을 사용자가 열었어야 하므로 **전제를 같이 세워준다** — 진짜로는
   * `runQueue` 가 세우는 값이다.
   */
  const say = async (
    from: { id: string }, to: string, text: string, id?: string,
  ): Promise<SayOut & { isError?: boolean }> => {
    if (!id) {
      // «0» 은 **사용자가 연 턴**에서만 통한다 — 진짜로는 `runQueue` 가 박는 값이다
      const bt = (mgr as unknown as {
        botRuntime(r: string, b: string): { depth?: number; fromUser?: boolean };
      }).botRuntime(room.id, from.id);
      bt.depth = 0;
      bt.fromUser = true;
    }
    const out = await mgr.mcpCall(
      `${room.id}:${from.id}`, "say",
      { to, text, id: id ?? "0" },
    );
    if (out.isError) return { ok: false, reason: out.text, left: 0, isError: true };
    return JSON.parse(out.text) as SayOut;
  };
  /** 그 봇의 몫을 꺼내 본다 */
  const check = async (bot: { id: string }) => {
    const out = await mgr.mcpCall(`${room.id}:${bot.id}`, "check_queue", {});
    return JSON.parse(out.text) as {
      kind: string | null;
      use?: string;
      item: { id: string; from: string; text?: string; about?: string } | null;
      left: number;
    };
  };
  /** 떠 있는 카드에 답한다 — 없으면 뜰 때까지 기다린다 */
  const answerCard = async (allow: boolean) => {
    await until(() => cards.length > 0, "승인 카드가 안 떴다");
    const card = cards.shift()!;
    card.settle(allow ? "aio-relay-allow" : "aio-relay-reject");
    return card.req;
  };

  return { dir, mgr, store, room, a, b, c, inner, settle, prompts, until, say, check, answerCard, cards };
}

const bubbles = (room: Room, from: string, to: string) =>
  room.messages.filter((m) =>
    m.role === "agent" && m.authorBotId === from && m.deliveredTo.includes(to) && !m.toUser);

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 새 가닥 — 승인을 묻고, 허락하면 간다]`);
  {
    const t = await make(); dirs.push(t.dir);
    // 세션을 열어둔다 — 깨우기가 실제로 프롬프트를 내보내야 하므로
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();

    const sent = t.say(t.a, "베타", "이 테스트 좀 봐줄래?");
    const req = await t.answerCard(true);
    ok(req.title.includes("알파") && req.title.includes("베타"),
       `★ **누가 누구를 부르는지**가 제목이다 (${req.title})`);
    ok(req.text === "이 테스트 좀 봐줄래?",
       "★ **보낼 말이 그대로 실린다** (D1) — 제목만으로는 승인할 수 없다");
    ok(req.options.some((o) => o.kind === "allow_once") &&
       req.options.every((o) => !o.kind.endsWith("always")),
       "★ **«항상»이 없다** — 인젝션 한 번의 값이 «앞으로 전부»가 되면 안 된다");

    const out = await sent;
    ok(out.ok, `★ 허락하면 간다 (${JSON.stringify(out)})`);

    const got = await t.check(t.b);
    ok(got.kind === "message" && got.use === "say",
       `★ 받는 쪽 큐에 들어 있다 — **say 를 쓰라고** 같이 온다 (${got.use})`);
    ok(got.item?.text === "이 테스트 좀 봐줄래?", "★ 글이 그대로");
    ok(got.item?.from === "알파", "★ 누가 걸었는지도 — 그게 답할 상대다");
    ok(got.item?.about === undefined,
       "★ **새로 거는 것에는 인용이 없다** — 인용은 답일 때만 뜻이 있다");

    const said = bubbles(t.room, t.a.id, t.b.id);
    ok(said.length === 1 && said[0]!.text === "이 테스트 좀 봐줄래?",
       "★ **말풍선이다** — «보이는 것은 누구에게 한 말인가»(§7)");
    ok(!said[0]!.text.includes("베타"),
       "★ **칩을 글에 안 넣는다** — 넣으면 에이전트에게 가는 글이 바뀐다(§4.1.1)");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 막으면 안 간다 — 그리고 왜 그런지 말해준다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const sent = t.say(t.a, "베타", "이것 좀");
    await t.answerCard(false);
    const out = await sent;
    ok(!out.ok, "★ 안 간다");
    ok((out.reason ?? "").includes("허락하지"), `★ 왜인지 말한다 (${out.reason})`);
    ok((out.can_call ?? []).join() === "베타,감마",
       `★ **부를 수 있는 목록이 같이 온다** (${out.can_call?.join(" · ")}) — 이름이 틀렸을 때와 같은 모양`);
    ok(t.inner.queue.pending(t.b.id).length === 0, "★ 큐에도 안 들어간다");
    ok(bubbles(t.room, t.a.id, t.b.id).length === 0,
       "★ **말풍선도 안 생긴다** — 간 적 없는 것만 지울 수 있다(§0)");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 답 — 그 항목이 닫히고 인용이 실린다]`);
  {
    const t = await make(); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.a.id);
    await t.settle();

    const first = t.say(t.a, "베타", "빌드 왜 깨졌어?");
    await t.answerCard(true);
    await first;

    const mine = await t.check(t.b);
    const id = mine.item!.id;

    /*
     * ⏪ 여기서 **릴레이를 끄고도 답이 나가는지**를 쟀다. 그 면제는 걷어냈다
     * (2026-10-12) — 근거가 *"안 그러면 묻는 쪽이 멈춘 채 남는다"* 였는데
     * **`say` 는 막힌 적이 없다.** 묻는 쪽은 제 턴을 이미 닫았고, 답이 안 오면
     * 그냥 안 오는 것이다(§16). 면제가 치르던 값이 더 컸다 — 「승인」이
     * «모든 대화를 승인»이 아니게 되고, 답 고리가 **어느 문도 안 타고** 샜다.
     */
    t.room.relay = "always";
    const back = await t.say(t.b, "알파", "의존성 판이 어긋났습니다.", id);
    ok(back.ok, `★ 답이 간다 (${JSON.stringify(back)})`);
    ok(t.inner.queue.find(t.b.id, id) === undefined,
       "★ **그 항목이 닫힌다** — 공이 넘어갔다");

    const got = await t.check(t.a);
    ok(got.item?.about === "«빌드 왜 깨졌어?»",
       `★ **무엇에 대한 답인지 실린다** (${got.item?.about}) — 알파 제 질문이라 새는 것이 없다`);
    t.mgr.dispose();
  }

  console.log(`${NL}[🔴 제3자에게 넘길 때 — 앞 가닥이 안 샌다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const first = t.say(t.a, "베타", "이 비밀번호 좀 봐줘: hunter2");
    await t.answerCard(true);
    await first;
    const id = (await t.check(t.b)).item!.id;

    // 베타가 **감마**에게 묻는다 — 같은 가닥 번호를 들고
    const on = t.say(t.b, "감마", "이 부분 네가 짰지?", id);
    await t.answerCard(true);
    const out = await on;
    ok(out.ok, "★ 제3자에게도 걸 수 있다 — 체인이 자연스럽다");

    const toGamma = await t.check(t.c);
    ok(toGamma.item?.about === undefined,
       `★ 🔴 **인용이 안 간다** (${JSON.stringify(toGamma.item?.about)}) — 그건 베타의 사정이다`);
    ok(!JSON.stringify(toGamma.item).includes("hunter2"),
       "★ 🔴 **알파가 쓴 글이 감마에게 한 글자도 안 간다** (§4.1.1)");
    ok(t.inner.queue.find(t.b.id, id) === undefined,
       "★ **반응했으니 닫힌다** — 받는 이가 제3자여도. 들고 있어 봐야 " +
         "큐는 턴 시작에 떼어낸 스냅샷이라 그 턴에서 기다릴 수가 없다");

    ok(bubbles(t.room, t.b.id, t.c.id).length === 1, "★ 감마에게 간 말풍선은 있다");
    ok(bubbles(t.room, t.b.id, t.c.id)[0]!.text === "이 부분 네가 짰지?",
       "★ 거기 실린 것은 **베타가 쓴 말뿐**이다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 릴레이 «끔» — 대화 기능이 통째로 꺼진다]`);
  {
    const t = await make(); dirs.push(t.dir);
    t.room.relay = "off";
    const out = await t.say(t.a, "베타", "이것 좀");
    ok(!out.ok && (out.reason ?? "").includes("꺼져"), `★ 돌려보낸다 (${out.reason})`);
    ok(t.cards.length === 0,
       "★ **사람을 안 깨운다** — 싼 문이 앞에 있어서 어차피 거절될 것으로 안 묻는다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 릴레이 «무조건 허용» — 안 묻는다]`);
  {
    const t = await make(); dirs.push(t.dir);
    t.room.relay = "always";
    const out = await t.say(t.a, "베타", "이것 좀");
    ok(out.ok && t.cards.length === 0, `★ 바로 간다 (${JSON.stringify(out)})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 틀린 인자는 넷 다 «거절 + 목록»으로 끝난다]`);
  {
    const t = await make(); dirs.push(t.dir);
    t.room.relay = "always";

    const self = await t.say(t.a, "알파", "혼잣말");
    ok(!self.ok && (self.can_call ?? []).length === 2,
       `★ **자기에게는 못 건다** (${self.reason})`);

    const none = await t.say(t.a, "델타", "없는 봇");
    ok(!none.ok && (none.reason ?? "").includes("델타"), `★ 없는 이름 (${none.reason})`);

    const ghost = await t.say(t.a, "베타", "답인 척", "x999");
    ok(!ghost.ok, `★ 없는 id (${ghost.reason})`);
    ok(Array.isArray(ghost.items),
       "★ **지금 들고 있는 것을 다시 실어준다** — 모델이 되묻지 않고 고칠 수 있다");

    // 권한 항목 id 에 say 를 쓰면 — 도구를 나눠둔 덕에 검사가 한 줄이다
    const pid = t.inner.queue.put({
      kind: "permission", to: t.a.id, from: "베타", fromId: t.b.id,
      title: "파일 고치기", readOnly: false,
    });
    const wrong = await t.say(t.a, "베타", "허용합니다", pid);
    ok(wrong.isError === true && (wrong.reason ?? "").includes("verdict"),
       `★ **종류가 어긋나면 어느 도구로 답할지 말해준다** (${wrong.reason})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 넣는 쪽이 깨운다 — 말풍선은 안 쌓인다]`);
  {
    const t = await make(); dirs.push(t.dir);
    t.room.relay = "always";
    // 받는 쪽 세션을 열어둔다 — 깨우기가 실제 프롬프트로 나가야 잴 수 있다
    await t.mgr.send(t.room.id, "안녕", undefined, t.b.id);
    await t.settle();
    const before = t.room.messages.length;
    const systems = t.room.messages.filter((m) => m.role === "system").length;

    await t.say(t.a, "베타", "일어나 봐");
    await t.until(
      async () => (await t.prompts()).some((p) => p.includes("check_queue 로 꺼내세요")),
      "놀고 있는 봇이 안 깨어났다",
    );
    await t.settle();

    const woke = (await t.prompts()).filter((p) => p.includes("check_queue 로 꺼내세요"));
    ok(woke.length >= 1, `★ **놀고 있으면 그 자리에서 프롬프트가 나간다** (${woke.length}번)`);
    ok(woke.some((p) => /큐에 \d+개/.test(p)),
       "★ **몇 개인지 같이 센다** — 몫을 떼어낸 직후라 낡은 값이 아니다");
    /*
     * ⏪ 여기 «메시지는 say, 권한은 verdict» 와 «몇 다리 더» 도 실려 있었다.
     * **둘 다 `check_queue` 결과가 들고 온다**(`use`·`depth_left`) — 거기
     * 수는 **보내기 직전의 참**이고, 프롬프트에 적은 것은 턴이 열릴 때 찍은
     * 값이라 그 턴 안에서 낡는다. 같은 말을 두 번 하면서 한쪽이 틀리는 것이다.
     */
    ok(woke.every((p) => !p.includes("다리 더") && !p.includes("verdict 로 답합니다")),
       "★ **깨우는 줄은 «할 일»만** — 자세한 것은 도구 결과가 든다");
    ok(woke.every((p) => p.includes("ai-in-one:")),
       "★ **누가 하는 말인지 이름을 댄다** — 안 대면 모델에게는 사용자 말로 보인다");
    ok(!woke.some((p) => p.includes("일어나 봐")),
       "★ 🔴 **말을 프롬프트로 안 밀어 넣는다** — 그건 check_queue 로 꺼내는 것이다");

    ok(t.room.messages.filter((m) => m.role === "system").length === systems,
       "★ 🔴 **시스템 줄이 안 쌓인다** — 스무 번 깨우면 읽을 대화가 묻힌다");
    const grew = t.room.messages.length - before;
    ok(grew <= 2,
       `★ 는 것은 «간 말»과 «깬 봇의 산문» 둘뿐이다 (${grew}개)`);
    ok(t.room.messages.slice(before).every((m) => m.role !== "user"),
       "★ **사용자 말풍선이 안 생긴다** — 깨우는 줄은 전달 방식이지 누가 한 말이 아니다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 바쁜 봇은 그 턴이 끝날 때 깨운다]`);
  {
    // 한 턴이 오래 걸리게 해둔다 — 가짜 에이전트는 턴마다 이만큼 붙잡는다
    const t = await make(900); dirs.push(t.dir);
    t.room.relay = "always";
    void t.mgr.send(t.room.id, "오래 걸리는 일", undefined, t.b.id);
    await t.until(() => busy(t.mgr.statusOf(t.room.id, t.b.id)), "베타가 안 바빠졌다");

    await t.say(t.a, "베타", "턴 중에 왔다");
    ok(t.inner.queue.waiting(t.b.id) === 1,
       "★ **다음 몫으로 간다** — 스냅샷이 떼어져 있어 이번 턴에는 안 보인다");

    await t.settle();
    await t.until(
      () => t.inner.queue.waiting(t.b.id) === 0,
      "턴이 끝났는데도 다음 몫이 안 떼어졌다",
    );
    ok(t.inner.queue.pending(t.b.id).length === 1,
       "★ **턴이 닫히면서 깨운다** — 넣는 쪽이 놓친 것을 여기서 줍는다");
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
