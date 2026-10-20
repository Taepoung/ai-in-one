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
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { EVERYONE } from "../src/core/mentions.js";
import type { BotQueue } from "../src/core/mcp/botQueue.js";
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
  /** 누가 받았나 — 보낼 때의 `to` 와 **다른 이름**이다 (2026-10-16) */
  got?: string[];
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
   * `id` 를 안 주면 **처음 시작하는 say**(`null`)로 친다. 그러려면 그
   * 턴을 사용자가 열었어야 하므로 **전제를 같이 세워준다** — 진짜로는
   * `runQueue` 가 세우는 값이다.
   */
  const say = async (
    from: { id: string }, to: string, text: string, id?: string,
  ): Promise<SayOut & { isError?: boolean }> => {
    if (!id) {
      // 처음 시작하는 say 는 **사용자가 연 턴**에서만 된다 — 진짜로는 `runQueue` 가 박는 값이다
      const bt = (mgr as unknown as {
        botRuntime(r: string, b: string): { depth?: number; fromUser?: boolean };
      }).botRuntime(room.id, from.id);
      bt.depth = 0;
      bt.fromUser = true;
    }
    const out = await mgr.mcpCall(
      `${room.id}:${from.id}`, "say",
      { to, text, id: id ?? null },
    );
    // ★ 거절도 성공도 **JSON 한 모양**이다 — 갈라 받을 것이 없다
    return JSON.parse(out.text) as SayOut;
  };
  /** 그 봇의 몫을 꺼내 본다 */
  const check = async (bot: { id: string }) => {
    const out = await mgr.mcpCall(`${room.id}:${bot.id}`, "check_queue", {});
    return JSON.parse(out.text) as {
      kind: string | null;
      use?: string;
      item: { id: string; author: string; text?: string; about?: string } | null;
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
    ok(got.item?.author === "알파", "★ 누가 썼는지도 — 저자를 적는다");
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
    ok(out.reason === "user denied", `★ 왜인지 말한다 (${out.reason})`);
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

    /*
     * ★ **답장이 그 말풍선에 걸린다** (2026-10-13).
     *
     * 🔴 `id` 를 여태 **쓰고 버렸다** — 상한 계산과 «닫기»에만 썼다. 그래서
     * 모든 `say` 말풍선이 `replyToIds` 가 빈 채였고, 화면은 그걸 «봇이 먼저
     * 보냈습니다» 로 읽었다. **사용자가 시켜서 보낸 것까지** 그렇게 적혔다.
     *
     * 걸어두면 화면이 ««빌드 왜 깨졌어?»에 답합니다» 로 잇고 누르면 그 자리로
     * 간다 — 그 기계(`answerNote`)는 이미 있었고 **이을 값이 없었을 뿐**이다.
     */
    const ask = bubbles(t.room, t.a.id, t.b.id).at(-1)!;
    const back2 = bubbles(t.room, t.b.id, t.a.id).at(-1)!;
    ok(back2.replyToIds?.length === 1 && back2.replyToIds[0] === ask.id,
       `★ **답장이 그 말풍선에 걸린다** (${JSON.stringify(back2.replyToIds)})`);
    /*
     * ★ **«0» 도 걸린다** — 사용자가 방금 한 말 때문에 보낸 것이므로, 그
     * 말풍선에 건다. 그래야 «봇이 먼저 보냈습니다» 가 **진짜로 먼저 보낸
     * 것에만** 남는다.
     */
    const said = t.room.messages.find((m) => m.role === "user" && m.text === "안녕")!;
    ok(ask.replyToIds?.length === 1 && ask.replyToIds[0] === said.id,
       `★ **«0» 은 사용자 말풍선에 걸린다** (${JSON.stringify(ask.replyToIds)})`);
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 꺼내 봤으면 **턴이 끝날 때 닫힌다** (2026-10-13)]`);
  {
    /*
     * 🔴 항목을 빼는 길이 `say`·`verdict` **하나뿐**이었다. 그런데 깨어난 봇이
     * **사용자에게만 답하는** 경우가 흔하다 — 사용자: *"봇이 반응을 나한테 할때,
     * say를 안쓰니까 큐에서 안빠지는 문제가 있네"*. 그러면 그 항목이 영영 몫에
     * 남아 매 턴 «queue: 1 · do: check_queue» 로 찌르고, check_queue 는 **이미
     * 처리한 것**을 또 꺼내준다.
     *
     * 전달이 약속이고 **답장은 약속이 아니다**(단방향 전송). «읽었다» 가 곧
     * 전달이 끝난 것이다.
     */
    const t = await make(); dirs.push(t.dir);
    const first = t.say(t.a, "베타", "이거 봐줄래?");
    await t.answerCard(true);
    await first;
    await t.settle();

    const mine = await t.check(t.b);
    ok(mine.item !== null, "전제 — 베타 몫에 있다");
    ok(t.inner.queue.shareLeft(t.b.id) === 1,
       "★ **꺼냈다고 빠지지는 않는다** — 답 못 하고 턴이 끊겨도 잃지 않으려고");

    // 베타가 `say` 를 안 쓰고 **사용자에게만** 답하는 턴
    await t.mgr.send(t.room.id, "베타야 고마워", undefined, t.b.id);
    await t.settle();
    ok(t.inner.queue.shareLeft(t.b.id) === 0,
       "★ **턴이 끝나면 닫힌다** — 안 닫으면 매 턴 같은 것을 다시 찌른다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ to: null 은 **사용자에게** — 말풍선으로 선다 (사용자, 2026-10-15)]`);
  {
    /*
     * 🔴 항목을 빼는 길이 «답하기» 하나뿐이면 **답할 것이 아닌 말에 억지로
     * 답하게** 된다. 턴 끝 자동 닫기가 받쳐주지만 그건 조용해서, 사용자는
     * «봤는데 안 한 것»과 «못 본 것»을 구별할 수 없다.
     *
     * ⏪ **«넘김»이었다** (2026-10-13) — 항목을 닫고 **활동 한 줄**로 «왜
     * 넘겼나»를 남겼다. 사용자: *"MCP에 to, null은 사용자에게 메시지를
     * 보내는 것로 바꿀 수 있어? 말풍선으로 나오는거지 @사용자 를 달고!
     * 얘는 산문이랑 구별되게 별도의 말풍선으로 나오고 (반응을 달고)"*.
     *
     * ★ **갈라야 할 것은 «누구에게»지 «말인가 아닌가»가 아니다.** 봇에게
     * 가는 말과 사용자에게 가는 말은 둘 다 **말**이라 말풍선으로 서야 흐름이
     * 한 줄로 읽힌다. 활동 한 줄은 «말이 아닌 것»으로 보이고, 턴의 산문에
     * 섞으면 **무엇에 대한 말인지가 안 붙는다** — 여기서는 붙는다.
     */
    const t = await make(); dirs.push(t.dir);
    const first = t.say(t.a, "베타", "이 로그 좀 봐줄래?");
    await t.answerCard(true);
    await first;
    await t.settle();

    const mine = await t.check(t.b);
    const id = mine.item!.id;

    /* 넘기는 줄이 붙을 **턴**을 세워준다 — 진짜로는 `runQueue` 가 깔아둔다 */
    const bt = (t.mgr as unknown as {
      botRuntime(r: string, b: string): { turn?: { tools?: Array<{ title: string; output?: string }> } };
    }).botRuntime(t.room.id, t.b.id);
    const turn = t.room.messages.filter((m) => m.authorBotId === t.b.id).at(-1)!;
    bt.turn = turn as unknown as { tools?: Array<{ title: string; output?: string }> };

    /* 🔴 **빠뜨린 것과 구별한다** — `to` 는 언제나 있어야 한다 */
    const missed = await t.mgr.mcpCall(`${t.room.id}:${t.b.id}`, "say", { text: "뭔가", id });
    ok(missed.isError === true
       && JSON.parse(missed.text).reason === "to is unvalid form(list or null)",
       `★ **to 를 빠뜨리면 오류다** — 한 번의 빠뜨림이 조용한 전송이 되면 안 된다`);

    const asked = bubbles(t.room, t.a.id, t.b.id).at(-1)!;

    /*
     * 🔴 **단독 «user» 는 막힌다** (사용자, 2026-10-16). 턴의 산문이 이미
     * 사용자에게 가므로 그 호출은 **언제나 두 번째 말**이다 — 모델에 따라 둘 다
     * 쓰는 것이 실제로 보였다. 비울 거리만 남기고 길은 `to: null` 하나로 줄인다.
     */
    const solo = await t.mgr.mcpCall(
      `${t.room.id}:${t.b.id}`, "say", { to: ["user"], text: "제 일이 아닙니다", id },
    );
    ok(solo.isError === true
       && JSON.parse(solo.text).reason === "user is not callable",
       `★ **to 의 user 는 막는다** (${solo.text})`);
    ok(t.inner.queue.find(t.b.id, id) !== undefined,
       "★ **막힌 호출은 큐를 안 건드린다** — 거절하고 나서 비우면 되돌릴 길이 없다");

    const out = await t.mgr.mcpCall(
      `${t.room.id}:${t.b.id}`, "say", { to: null, text: "제 일이 아닙니다", id },
    );
    const body = JSON.parse(out.text) as
      { ok: boolean; to?: unknown; got?: unknown; queue_left: number };
    /*
     * 🔴 **답의 이름은 `got` 이다** — 보낼 때의 `to` 와 가른다(2026-10-16).
     * 같으면 성공한 답이 **입력 예시처럼** 읽혀, 우리가 거절할 `["user"]` 를
     * 잘했다는 답에 실어 보내는 꼴이 된다.
     */
    ok(body.ok === true && body.to === undefined
       && JSON.stringify(body.got) === JSON.stringify(["user"]),
       `★ **누가 받았는지는 got 이 말한다** (${out.text}) — `
       + "보낼 때의 to 와 이름이 갈려 베껴 쓸 모양이 아니다");
    ok(t.inner.queue.find(t.b.id, id) === undefined,
       "★ **그 항목이 닫힌다** — 사용자에게 말하는 것도 그 항목에 대한 반응이다");
    ok(bubbles(t.room, t.b.id, t.a.id).length === 0,
       "★ **알파에게는 안 간다** — [\"user\"] 는 «아무에게도»가 아니라 «사용자에게»다");

    const toMe = t.room.messages.filter((m) => m.authorBotId === t.b.id && m.toUser).at(-1)!;
    ok(toMe.text === "제 일이 아닙니다" && toMe.id !== turn.id,
       `★ **말풍선이 선다 — 산문과 따로** (${toMe.text})`);
    ok((toMe.replyToIds ?? [])[0] === asked.id,
       `★ **무엇에 반응한 말인지 달고 선다** (${JSON.stringify(toMe.replyToIds)}) — ` +
       "화면이 ««…»에 반응했습니다» 로 잇고, 누르면 그 자리로 간다");
    ok(toMe.composeGroupId !== undefined && toMe.composeGroupId === turn.composeGroupId,
       "★ 같은 턴이면 묶인다 — 산문과 이 말은 한 턴의 두 말풍선이다 (4-14)");

    /* 할 말이 없으면 안 받는다 — 빈 말풍선을 세울 이유가 없다 */
    const bare = await t.mgr.mcpCall(`${t.room.id}:${t.b.id}`, "say", { to: null, text: "  ", id });
    ok(bare.isError === true
       && JSON.parse(bare.text).reason === "text is empty",
       "★ **빈 말은 못 보낸다** — 글자 검사가 먼저라 «비었다»로 답한다");

    /*
     * 🔴 **«0» 은 사용자가 연 턴에서만** — 여기 턴은 알파가 열었다. 받아주면
     * 사슬 깊은 봇이 **아무 때나 사용자에게 새 말을 거는** 길이 생긴다.
     */
    const zero = await t.mgr.mcpCall(
      `${t.room.id}:${t.b.id}`, "say", { to: null, text: "안녕하세요", id: null },
    );
    ok(zero.isError === true
       && JSON.parse(zero.text).reason === "id null is only for user turn",
       `★ **깨어난 턴에서는 «0» 을 못 쓴다** (${zero.text.slice(0, 40)}…)`);
    t.mgr.dispose();
  }

console.log(`${NL}[🔴 사용자가 연 턴에서는 **사용자에게 say 를 못 쓴다** (사용자, 2026-10-15)]`);
  {
    /*
     * 사용자: *"사용자에 반응해서 산문도 쓰면서 이것도 쓰는 경우가 있는듯"*.
     *
     * 🔴 `id: null` 은 **사용자가 열었다는 뜻**이고 그 턴의 산문은 어차피
     * 사용자에게 간다 — 거기에 또 사용자를 가리키면 **같은 사람에게 두 번**이다.
     */
    const t = await make(); dirs.push(t.dir);
    const bt = (t.mgr as unknown as {
      botRuntime(r: string, b: string): { depth?: number; fromUser?: boolean };
    }).botRuntime(t.room.id, t.a.id);
    bt.depth = 0; bt.fromUser = true;

    const only = await t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say", { to: null, text: "다 했습니다", id: null },
    );
    /*
     * ⚠️ **«대신 뭘 할지» 는 이제 글에 없다** (사용자, 2026-10-15). `reason` 이
     * 정해진 한 마디가 되면서 «이 턴의 글로 쓰세요» 가 빠졌다 — 지켜야 할 것은
     * **사용자에게 두 번 말하지 않는다**는 것이고, 그건 거절되는 것으로 선다.
     */
    ok(only.isError === true
       && JSON.parse(only.text).reason === "id null and to null cannot be used together",
       `★ **사용자가 연 턴에는 사용자에게 say 를 못 쓴다** (${only.text})`);

    const dropped = await t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say", { to: null, text: "버립니다", id: null },
    );
    ok(dropped.isError === true,
       "★ `to: null` + `id: null` 도 마찬가지 — **비울 것도 없고** 보낼 곣도 없다");

    /*
     * ★ **사용자가 열었어도 큐에는 메세지가 있을 수 있다** (사용자,
     * 2026-10-15): *"ㄴㄴ 사용자가 열어도 큐에 메세지가 있을 수 있지"*.
     *
     * 🔴 막는 것은 **`id` 까지 `null` 일 때** 하나뿐이다. 큐 항목을 가리키면
     * 사용자가 연 턴에서도 버릴 수 있어야 한다 — 그 항목은 그 턴과 상관없이
     * 쌓여 있던 것이다.
     */
    const mine = t.inner.queue.put({
      kind: "message", to: t.a.id, from: t.b.name, fromId: t.b.id,
      text: "옮 부탁", depth: 1,
    });
    t.inner.queue.startTurn(t.a.id);
    const tossed = await t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say", { to: null, text: "제 일이 아닙니다", id: mine },
    );
    ok(!tossed.isError && tossed.text.includes('"ok":true'),
       `★ **큐 항목은 사용자 턴에서도 버릴 수 있다** (${tossed.text})`);
    ok(t.inner.queue.find(t.a.id, mine) === undefined, "★ 그 항목이 비었다");

    /*
     * 🔴 **봇과 같이 적어도 거절한다** (사용자, 2026-10-16). ⏪ 한때는 받아주고
     * 사용자만 뺐다. 명단이 더는 그 이름을 안 보여주므로(`callable`) **받아줄
     * 까닭도 없다** — 받아주면 사용자에게 가는 길이 둘이 된다.
     */
    const mixed = await t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say", { to: ["베타", "user"], text: "봐줘", id: null },
    );
    ok(mixed.isError === true
       && JSON.parse(mixed.text).reason === "user is not callable",
       `★ **섞어 적어도 막는다** (${mixed.text})`);
    ok(t.cards.length === 0, "★ **카드도 안 뜬다** — 문 앞에서 끝난다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 깨어난 턴에서도 to 의 user 는 막힌다 (사용자, 2026-10-16)]`);
  {
    /*
     * 🔴 **턴을 누가 열었는지와 무관하다.** 사용자에게 가는 길이 `to: null`
     * 하나라는 것은 방의 규칙이지 턴의 규칙이 아니다 — 턴마다 갈리면 모델이
     * «지금은 되나» 를 매번 따져야 한다.
     */
    const t = await make("ask"); dirs.push(t.dir);
    const mine = t.inner.queue.put({
      kind: "message", to: t.a.id, from: "베타", fromId: t.b.id, srcId: "m-x",
      text: "이거 봐줄래?", depth: 1,
    });
    t.inner.queue.startTurn(t.a.id);

    const mixed = await t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say", { to: ["베타", "user"], text: "둘 다 보세요", id: mine },
    );
    ok(mixed.isError === true
       && JSON.parse(mixed.text).reason === "user is not callable",
       `★ **깨어난 턴에서도 막는다** (${mixed.text})`);
    ok(t.inner.queue.find(t.a.id, mine) !== undefined,
       "★ **큐는 그대로다** — 거절하고 나서 비우면 되돌릴 길이 없다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ **같이 받은 이**를 적어 보낸다 — also_got (사용자, 2026-10-15)]`);
  {
    /*
     * 🔴 **모르면 한 번 더 보낸다.** 사용자: *"봇한테 온 메세지가 다른 봇한테도
     * 갔는지는 알아야할거 같아. 그게 아니면 봇1이 봇2한테 명령을 한 전적이 있을때
     * 봇2한테 다시 전달하더라고?"* — 받는 쪽에 보이는 것이 «나한테 왔다»
     * 뿐이면, 전에 심부름을 시켜본 사이는 **그대로 옮기는 것**이 자연스러운 수다.
     * 그러면 같은 말이 두 번 가고, 그 두 번째는 상한(4-L)을 한 칸 쓰면서 간다.
     */
    const t = await make(); dirs.push(t.dir);
    const bt = (t.mgr as unknown as {
      botRuntime(r: string, b: string): { depth?: number; fromUser?: boolean };
    }).botRuntime(t.room.id, t.a.id);
    bt.depth = 0; bt.fromUser = true;

    const call = t.mgr.mcpCall(
      `${t.room.id}:${t.a.id}`, "say",
      { to: ["베타", "감마"], text: "둘 다 봐줘", id: null },
    );
    await t.answerCard(true);
    const out = JSON.parse((await call).text) as SayOut;
    ok(out.ok === true, `★ 전제 — 둘에게 갔다 (${out.got?.join("·")})`);

    const forB = (await t.check(t.b)).item as { also_got?: string[] } | null;
    const forC = (await t.check(t.c)).item as { also_got?: string[] } | null;
    ok(JSON.stringify(forB?.also_got) === JSON.stringify(["감마", "user"]),
       `★ 베타는 **감마와 사용자도 받은 것을 안다** (${JSON.stringify(forB?.also_got)})`);
    ok(JSON.stringify(forC?.also_got) === JSON.stringify(["베타", "user"]),
       `★ 감마는 베타를 (${JSON.stringify(forC?.also_got)})`);
    ok(forB?.also_got?.includes("베타") !== true,
       "★ **제 이름은 안 들어간다** — 물음은 «나 말고 누가 더»다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 사용자가 둘에게 한 말도 마찬가지 — 깃발에 적혀 간다]`);
  {
    /*
     * 🔴 **사용자가 둘에게 한 말도 각자에게는 «나한테 온 말»로 보인다.**
     * 틀리는 쪽은 한결같다 — 지시를 받은 봇이 친절하게 옮기면 같은 지시가 두 번 간다.
     */
    const t = await make(); dirs.push(t.dir);
    /*
     * ★ **화면이 쓰는 길로 보낸다** (리팩토링 ⑥, 2026-10-20). ⏪ 예전엔 단체방에서
     * `send` 를 봇을 안 짚고 불렀다 — 화면은 그 길을 안 쓰는데, 옛 `soleBot` 이
     * **첫 봇을 대신 골라** 줘서 돌았다. «셋 다 보세요» 를 재는 검사가 실은 첫 봇
     * 하나에게만 턴을 돌리고 있었다. 단체방의 «모두» 는 `@everyone` 칩이다.
     */
    await t.mgr.sendCompose(t.room.id, [
      { kind: "mention", botId: EVERYONE },
      { kind: "text", text: " 셋 다 보세요" },
    ]);
    await t.settle();
    const ps = await t.prompts();
    const two = ps.filter((p) => /"also_got":\["[^"]+","[^"]+"\]/.test(p));
    // 이제 셋이 **다** 받는다 — 셋 다 «나 말고 둘» 을 받아야 한다
    ok(two.length >= 3,
       `★ **같이 받은 둘이 적혀 간다** (${two.length}개) — 그 칸이 없으면 «나한테만 왔다»로 읽는다`);
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
    ok(!out.ok && out.reason === "relay is off", `★ 돌려보낸다 (${out.reason})`);
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
    ok(!none.ok && none.reason === "unknown name", `★ 없는 이름 (${none.reason})`);
    // 🔴 **글이 짧아진 몫은 칸이 진다** — «델타» 대신 부를 수 있는 목록이 답이다
    ok((none.can_call ?? []).join() === "베타,감마", `★ 부를 수 있는 목록 (${none.can_call})`);

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
      async () => (await t.prompts()).some((p) => p.includes('"do":"check_queue"')),
      "놀고 있는 봇이 안 깨어났다",
    );
    await t.settle();

    const woke = (await t.prompts()).filter((p) => p.includes('"do":"check_queue"'));
    ok(woke.length >= 1, `★ **놀고 있으면 그 자리에서 프롬프트가 나간다** (${woke.length}번)`);
    ok(woke.some((p) => /"queue_left":[1-9]/.test(p)),
       "★ **몇 개인지 같이 센다** — 몫을 떼어낸 직후라 낡은 값이 아니다");
    /*
     * ⏪ 여기 «메시지는 say, 권한은 verdict» 와 «몇 다리 더» 도 실려 있었다.
     * **둘 다 `check_queue` 결과가 들고 온다**(`use`·`depth_left`) — 거기
     * 수는 **보내기 직전의 참**이고, 프롬프트에 적은 것은 턴이 열릴 때 찍은
     * 값이라 그 턴 안에서 낡는다. 같은 말을 두 번 하면서 한쪽이 틀리는 것이다.
     */
    ok(woke.every((p) => p.includes('"null_id":"invalid"')),
       "★ **쓸 수 있나를 그대로 적는다** — 규칙을 안 외워도 된다");
    ok(woke.every((p) => p.includes("[ai-in-one] {")),
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
