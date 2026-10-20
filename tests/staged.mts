/**
 * **큐를 없애고 «예약» 한 칸을 둔다** (v3.0 1-E · 4-21).
 *
 * ⏪ 예전에는 바쁠 때 보내면 **저절로** 줄에 섰다. 그게 엇갈림을 만들었다:
 *
 * ```
 * 봇이 10분짜리 일을 한다
 * 사용자가 «아 그거 말고 이거» 를 쳐둔다
 * 봇이 앞 일을 끝낸다 → 줄의 말이 나간다 → **이미 끝난 일에 대한 정정**이 나간다
 * ```
 *
 * 끼어들기(턴 끊기)가 있던 이유가 그것이었다. **그 끼어들기를 없앴으므로**
 * (1-D) 남겨둔 큐만 혼자 엇갈림을 계속 만든다.
 *
 * 🔴 **옛 큐와 결정적으로 다른 점 — 예약은 명시적 행동이다.** 옛 큐는 기본
 * 동작이라 모르고 쌓였다(«내가 언제 이걸 줄 세웠지»). 눌러서 올린 것이면
 * 엇갈려도 납득이 된다.
 *
 * N 과 1 의 차이도 크다 — 순서도 배치도 없고, 자료구조가 배열이 아니라
 * **칸 하나**다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const busy = (s: string) => !["idle", "error"].includes(s);

async function make(hold: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-staged-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
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
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const prompts = async (): Promise<string[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; text: string })
        .filter((e) => e.t === "prompt").map((e) => e.text);
    } catch { return []; }
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) { if (!busy(mgr.statusOf(id))) return; await nap(25); }
  };
  /** 스위트 예순 개 뒤에서도 설 만큼 넓게 — 시간으로 재면 느린 기계에서 흔들린다 */
  const until = async (cond: () => boolean, what = "") => {
    for (let i = 0; i < 1200; i++) { if (cond()) return true; await nap(25); }
    if (what) throw new Error("FAIL: 전제가 안 섬다 — " + what);
    return cond();
  };
  /*
   * 🔴 **말풍선은 프롬프트보다 먼저 생긴다.** `sendCompose` 가 메시지를 적고
   * 저장한 **다음에** 보내므로, «말풍선이 떴다»로 기다리면 아직 안 나갔을 수
   * 있다 — 실제로 스위트 안에서 그렇게 흔들렸다. **나간 것을 보고** 기다린다.
   */
  const untilSent = async (needle: string) => {
    for (let i = 0; i < 1200; i++) {
      if ((await prompts()).some((t) => t.includes(needle))) return;
      await nap(25);
    }
    throw new Error("FAIL: 전제가 안 섰다 — 올려둔 글이 안 나갔다: " + needle);
  };
  return { dir, mgr, store, prompts, settle, until, untilSent };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 바쁠 때 보내면 저절로 줄서지 않는다 — 올려둔다]`);
  {
    const { dir, mgr, prompts, settle, until, untilSent } = await make(1500); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "하나" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래 걸리는 일");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));

    // 화면이 모르고 보냈어도 **코어가 막아 올려둔다**
    await mgr.send(room.id, "그거 말고 이거");
    ok(room.staged !== undefined, "★ **예약 칸으로 간다** — 줄에 서지 않는다");
    ok(!room.messages.some((m) => m.text === "그거 말고 이거"),
       "★ **말풍선이 아직 없다** — 내리면 흔적 없이 사라져야 하므로 (§0)");

    await settle(room.id);
    // 올려둔 것은 **턴이 끝난 뒤에** 나간다 — 나간 것을 보고 기다린다
    await untilSent("그거 말고 이거");
    await settle(room.id);
    const sent = await prompts();
    console.log(`   프롬프트: ${JSON.stringify(sent)}`);
    ok(sent.some((t) => t.includes("그거 말고 이거")), "★ 턴이 끝나면 나간다");
    ok(room.messages.some((m) => m.text.includes("그거 말고 이거")),
       "★ 나갈 때 비로소 말풍선이 생긴다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 칸은 하나다 — 둘째가 첫째를 밀어내지 않는다]`);
  {
    const { dir, mgr, until } = await make(2500); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "하나만" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));

    ok(await mgr.stage(room.id, [{ kind: "text", text: "첫째" }]), "첫째가 올라간다");
    ok(!(await mgr.stage(room.id, [{ kind: "text", text: "둘째" }])),
       "★ **둘째는 거절된다** — 밀어내면 조용히 잃는다 (§0)");
    ok(room.staged?.tokens[0]?.kind === "text" &&
       room.staged.tokens[0].text === "첫째", "★ 첫째가 그대로 있다");
    await mgr.stopAll(room.id);
    mgr.dispose();
  }

  console.log(`${NL}[★ 기다릴 것이 없으면 지금이 그때다]`);
  {
    /*
     * 🔴 `maybeFireStaged` 는 **턴이 끝나는 자리**에서만 돈다. 끝낼 턴이
     * 없으면 영영 안 나간다 — 올려둔 글이 입력창 위에 뜬 채로 멎는다.
     *
     * 규칙을 그대로 읽으면 이미 답이 있다 — «기다리던 봇이 **전부 한가해지면**
     * 나간다». 한가하면 그 조건이 **이미 참**이다.
     *
     * ★ 이게 없으면 둘째 구멍이 딸린다: 그 상태에서 새로 친 말을 보내면
     * **새 말이 먼저 가고 올려둔 말이 그 뒤에** 간다 — 1-E 가 없애려던
     * 엇갈림과 같은 종류다.
     */
    const { dir, mgr, settle, untilSent } = await make(100); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "한가한데" });
    await mgr.send(room.id, "첫 말");
    await settle(room.id);

    ok(await mgr.stage(room.id, [{ kind: "text", text: "한가할 때 올린 글" }]), "올렸다");
    await untilSent("한가할 때 올린 글");
    await settle(room.id);
    ok(room.staged === undefined, "★ **저절로 나간다** — 끝낼 턴이 없어도");
    mgr.dispose();
  }

  console.log(`${NL}[★ 내리면 흔적이 없다 · 수정하면 글이 돌아온다]`);
  {
    /*
     * ⚠️ **봇을 바쁘게 해둔다.** 한가하면 올리는 **즉시 나가므로**(바로 위
     * 블록) 내릴 것이 없다 — 화면에서도 올리기는 바쁠 때만 생기는 일이다.
     */
    const { dir, mgr, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "물리기" });
    const bot = room.participants[0]!;
    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)), "봇이 안 바빠졌다");

    await mgr.stage(room.id, [{ kind: "text", text: "내릴 글" }]);
    await mgr.unstage(room.id);
    ok(room.staged === undefined, "내려갔다");
    ok(!room.messages.some((m) => m.text.includes("내릴 글")),
       "★ **자국이 없다** — 아무도 못 본 글이다 (§0)");

    await mgr.stage(room.id, [{ kind: "text", text: "고칠 글" }]);
    const back = await mgr.takeStaged(room.id);
    ok(back?.tokens[0]?.kind === "text" && back.tokens[0].text === "고칠 글",
       "★ **글을 돌려준다** — 화면이 입력창에 꽂는다");
    ok(room.staged === undefined, "★ 그리고 칸은 비워진다 — 둘이 동시에 안 뜬다");
    await mgr.stopAll(room.id);
    mgr.dispose();
  }

  console.log(`${NL}[★ 올려둔 것이 먼저다 — 한가한 봇에게도 안 간다]`);
  {
    /*
     * 🔴 **순서가 보이는 대로여야 한다.** 입력창 위에 «⏳ 끝나면 보냅니다» 가
     * 떠 있는데 나중에 친 말이 먼저 가면 **그 줄이 거짓이 된다.**
     *
     * ⏪ 한때 «바쁜 봇에게만» 막았다. 그러면 올려둔 글이 베타를 기다리는
     * 동안 **알파에게 친 말이 먼저 나갔다** — 예약을 한 칸으로 둔 근거가
     * «하나뿐이라 순서가 없다» 였는데, 그러면 «예약 1 + 즉시 전송» 이라
     * **순서가 둘**이 된다.
     *
     * 화면은 단추를 끄지만, 규칙은 **코어에서도** 지킨다 — 화면이 늦게
     * 알거나 다른 길로 들어왔을 때를 위해서다.
     */
    const { dir, mgr, prompts, settle, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "순서", bots: [{ agentId: "alpha", name: "알파" }, { agentId: "beta", name: "베타" }],
    });
    const [a, b] = room.participants;

    // 베타만 바쁘게 하고, 베타를 기다리는 글을 올려둔다
    void mgr.send(room.id, "오래", undefined, b!.id);
    await until(() => busy(mgr.statusOf(room.id, b!.id)), "베타가 안 바빠졌다");
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: b!.id }, { kind: "text", text: " 올려둘 글" },
    ]);
    ok(room.staged !== undefined, "올려뒀다");

    // 알파는 한가하다 — 그래도 안 간다
    const before = (await prompts()).length;
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: a!.id }, { kind: "text", text: " 새로 친 글" },
    ]);
    const after = (await prompts()).slice(before);
    console.log(`   나간 것: ${JSON.stringify(after)}`);
    ok(!after.some((t) => t.includes("새로 친 글")),
       "★ **한가한 알파에게도 안 간다** — 올려둔 것이 먼저다");
    ok(!room.messages.some((m) => m.text.includes("새로 친 글")),
       "★ 말풍선도 안 생긴다");
    ok(room.messages.some((m) => m.role === "system" && m.text.includes("먼저 나가야")),
       "★ **왜 안 갔는지 말해준다**");
    ok(room.staged !== undefined, "★ 그리고 올려둔 것은 그대로다 — 덮어쓰지 않는다");

    await mgr.stopAll(room.id);
    await settle(room.id);
    mgr.dispose();
  }

  console.log(`${NL}[★ 단체방 — 전부 한가해질 때까지 기다린다]`);
  {
    const { dir, mgr, prompts, settle, until, untilSent } = await make(1200); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "둘", bots: [{ agentId: "alpha", name: "알파" }, { agentId: "beta", name: "베타" }],
    });
    const [a, b] = room.participants;

    // 베타만 바쁘게 만든다
    void mgr.send(room.id, "오래", undefined, b!.id);
    await until(() => busy(mgr.statusOf(room.id, b!.id)));

    /*
     * 🔴 **한 명이라도 바쁘면 통째로 올려둔다.** 반만 나가면 «반만 나간 것»을
     * 사용자가 알아야 하고, 그걸 말해주려면 결국 «줄 서 있음» 표시가 다시
     * 필요해진다 — 없애려던 바로 그것이다.
     */
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: a!.id }, { kind: "mention", botId: b!.id },
      { kind: "text", text: " 둘 다 봐줘 — 수박열둘" },
    ]);
    ok(room.staged !== undefined, "★ **한 명만 바빠도 통째로 올라간다**");
    ok(room.staged?.botIds.length === 2, "★ 둘 다 기다린다고 적어둔다");

    await settle(room.id);
    await untilSent("수박열둘");
    await settle(room.id);
    const got = (await prompts()).filter((t) => t.includes("수박열둘"));
    console.log(`   간 횟수: ${got.length}`);
    ok(got.length === 2, `★ **둘 다에게 한 번씩** (${got.length}) — 두 번 가면 일을 두 번 한다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 전체 중지는 올려둔 것도 내린다]`);
  {
    const { dir, mgr, prompts, settle, until } = await make(2000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "중지" });
    const bot = room.participants[0]!;

    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)));
    await mgr.stage(room.id, [{ kind: "text", text: "중지 뒤에 나가면 안 되는 글" }]);

    await mgr.stopAll(room.id);
    await settle(room.id);
    await nap(300);

    ok(room.staged === undefined, "★ 올려둔 것도 같이 내려간다");
    const leaked = (await prompts()).filter((t) => t.includes("나가면 안 되는"));
    ok(leaked.length === 0,
       `★ **중지한 뒤에 뜬금없이 안 나간다** (${leaked.length}번)`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 껐다 켜도 올려둔 것은 남는다]`);
  {
    // ⚠️ 여기도 바쁘게 해둔다 — 한가하면 올리는 즉시 나가서 남을 것이 없다
    const { dir, mgr, store, until } = await make(4000); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "저장" });
    const bot = room.participants[0]!;
    void mgr.send(room.id, "오래");
    await until(() => busy(mgr.statusOf(room.id, bot.id)), "봇이 안 바빠졌다");
    await mgr.stage(room.id, [{ kind: "text", text: "남아야 하는 글" }]);
    mgr.dispose();

    const fresh = new RoomStore(dir); await fresh.init();
    const back = await fresh.loadRoom(room.id);
    ok(back?.staged?.tokens[0]?.kind === "text", "★ **디스크에 남는다** — 초안과 같은 대우다");

    // 내린 것도 남아야 한다 — 안 그러면 껐다 켜면 되살아난다
    const mgr2 = new RoomManager({
      host: { readTextFile: async () => "", writeTextFile: async () => {},
              requestPermission: async () => ({ outcome: "cancelled" }),
              log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true },
      store, configProbeMs: 20000, agents: [],
    });
    mgr2.on("roomError", () => {}); mgr2.on("notice", () => {});
    await mgr2.openRoom(room.id);
    await mgr2.unstage(room.id);
    mgr2.dispose();

    const fresh2 = new RoomStore(dir); await fresh2.init();
    ok((await fresh2.loadRoom(room.id))?.staged === undefined,
       "★ **내린 것도 남는다** — 안 그러면 껐다 켜면 되살아난다");
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await nap(200); }
    }
  }
  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
