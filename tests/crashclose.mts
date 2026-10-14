/**
 * ★ **CLI 가 죽으면 그 말풍선을 거기서 닫는다** (2026-10-14).
 *
 * 🔴 여태 `streaming: true` 인 채로 **남겨뒀다.** 아무것도 안 쓰고 있는데 칸은
 * «쓰는 중»이라고 말한다 — 점이 안 멈추던 버그는 상태로 막았지만 그건 증상
 * 쪽이고, **그 칸을 읽는 다음 사람은 또 속는다.** 사용자: *"cli가 죽었다가
 * 깨어나면 true인 애들을 false로 바꾸는건 안됨?"*
 *
 * 가짜 에이전트의 `AIO_FAKE_DIE_AFTER_CHUNK` 가 **실측에서 본 Codex 와 같은
 * 꼴**이다 — 말을 흘린 뒤 **응답 없이** 죽는다. 그러면 프롬프트 약속이 영영
 * 안 깨져서 턴 코드가 닫을 기회를 못 가진다(`tests/probes/killresume.mts`).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";
import type { PermissionDecision } from "../src/core/types.js";

const NL = "\n";
const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-crash-"));
  const state = path.join(dir, "fake.jsonl");
  const die = path.join(dir, "died");
  const store = new RoomStore(dir); await store.init();

  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state, AIO_FAKE_DIE_AFTER_CHUNK: die },
  };

  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
  mgr.on("roomError", () => {});
  const notices: string[] = [];
  mgr.on("notice", (_r, m) => notices.push(m));

  const room = await mgr.createRoom({ agentId: "fake", title: "도중 사망" });

  console.log(`${NL}[★ 말을 흘리다 죽으면 — **그 자리에서** 닫는다]`);
  {
    /* 🔴 **기다리지 않는다.** 저쪽이 응답을 안 주므로 이 약속은 영영 안 깨진다 */
    void mgr.send(room.id, "파일 좀 고쳐줘");
    for (let i = 0; i < 400 && mgr.statusOf(room.id) !== "error"; i++) await nap(25);
    ok(mgr.statusOf(room.id) === "error", "전제 — 죽은 것을 알아챘다");
    /*
     * 🔴 **상태와 알림은 다른 순간이다.** 프롬프트 약속이 먼저 깨지는
     * 에이전트에서는 catch 가 상태를 error 로 올리고, 프로세스 종료 신호는
     * 그 **뒤에** 온다. 상태만 보고 바로 세면 흔들린다 — 실제로 한 번 걸렸다.
     */
    for (let i = 0; i < 200 && !notices.some((n) => n.includes("종료되어")); i++) await nap(25);
    ok(notices.some((n) => n.includes("종료되어")), "전제 — 사용자에게 알렸다");

    const live = room.messages.at(-1)!;
    console.log(`   ${JSON.stringify(live.text)} · streaming=${String(live.streaming)} · truncated=${String(live.truncated)}`);
    ok(live.text === "파일을 고치는 중", "전제 — 흘린 말은 남아 있다");
    ok(live.streaming === false,
       "★ **«쓰는 중» 이 꺼진다** — 아무것도 안 쓰고 있는데 켜져 있으면 거짓말이다");
    ok(live.truncated === true,
       "★ **잘렸다고 적는다** — 다시 열 때까지 기다릴 이유가 없다");
  }

  console.log(`${NL}[★ 디스크도 같은 모양이다 — 다시 열어도 안 달라진다]`);
  {
    /*
     * ⚠️ 여기가 **에이전트마다 갈리던 자리**다 (실측). Claude 는 약속이 거절돼
     * 턴 코드가 닫고, Codex 는 안 깨져서 **다음에 열 때** `healAfterCrash` 가
     * 고쳤다. 이제 둘 다 죽는 자리에서 닫히므로 **다시 열어도 같다.**
     */
    mgr.dispose();
    await nap(200);
    const store2 = new RoomStore(dir); await store2.init();
    const again = new RoomManager({ host, store: store2, agents: [agent], configProbeMs: 20000 });
    again.on("roomError", () => {});
    const back = await again.openRoom(room.id);
    const last = back.messages.at(-1)!;
    ok(last.streaming === false && last.truncated === true,
       `★ 디스크에서 읽어도 같다 (streaming=${String(last.streaming)} truncated=${String(last.truncated)})`);
    ok(last.text === "파일을 고치는 중", "★ 흘린 말도 그대로다 — 버리지 않는다 (§0)");
    again.dispose();
    await nap(150);
  }

  console.log(`${NL}[★ **승인 카드가 떠 있는 중에** 죽으면 (2026-10-14)]`);
  {
    /*
     * 🔴 **답할 상대가 사라진다.** 승인을 기다리는 동안 저쪽은
     * `request_permission` 에 얼어 있고, 그때 프로세스가 죽으면 **카드만
     * 남는다.** 사용자가 눌러도 받을 데가 없다.
     *
     * 여기서 재는 것은 «무슨 일이 일어나나» 다 — 고치기 전에 본다.
     */
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "aio-askcrash-"));
    const state2 = path.join(dir2, "fake.jsonl");
    const store3 = new RoomStore(dir2); await store3.init();

    /** 떠 있는 카드 — 우리가 들고 있다가 손으로 답한다 */
    let card: { botId?: string; settle: (d: PermissionDecision) => void } | undefined;
    let settled = 0;
    /** 어느 봇을 집어 거뒀나 — «그 봇 것만» 이 지켜지는지 본다 */
    let pulledFor: string | undefined;
    const host2: WorkspaceHost = {
      readTextFile: async () => "", writeTextFile: async () => {},
      requestPermission: (req) =>
        new Promise<PermissionDecision>((settle) => {
          card = {
            ...(req.askerBotId ? { botId: req.askerBotId } : {}),
            settle: (d) => { settled++; settle(d); },
          };
        }),
      /*
       * 진짜 앱에서는 `ChatPanel` 이 이 자리다 — 떠 있는 카드를 거두고
       * «답 없음» 으로 풀어준다. 여기서도 같은 일을 한다.
       */
      cancelPermissions: (_roomId, botId) => {
        if (!card) return;
        if (botId && card.botId !== botId) return;
        pulledFor = botId;
        const c = card;
        card = undefined;
        c.settle({ outcome: "cancelled" });
      },
      log: () => {}, defaultCwd: () => dir2, hasWorkspace: () => true,
    };
    const agent2 = {
      ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
      env: { AIO_FAKE_STATE: state2 },
    };
    const m2 = new RoomManager({ host: host2, store: store3, agents: [agent2], configProbeMs: 20000 });
    m2.on("roomError", () => {});
    const notes: string[] = [];
    m2.on("notice", (_r, n) => notes.push(n));
    const r2 = await m2.createRoom({ agentId: "fake", title: "묻다가 죽기" });

    void m2.send(r2.id, "[[ask:파일 고치기]] 해줘");
    for (let i = 0; i < 400 && !card; i++) await nap(25);
    ok(card !== undefined, "전제 — 승인 카드가 떴다");
    ok(m2.statusOf(r2.id) === "permission",
       `전제 — 그 턴은 **멈춰 있다** (${m2.statusOf(r2.id)})`);

    /* 그 상태에서 죽인다 */
    const conn = (m2 as unknown as {
      connections: Map<string, { proc?: { kill(sig?: string): boolean } }>;
    }).connections.get("fake");
    conn?.proc?.kill("SIGKILL");
    for (let i = 0; i < 400 && m2.statusOf(r2.id) !== "error"; i++) await nap(25);

    const open2 = await m2.openRoom(r2.id);
    const last2 = open2.messages.at(-1)!;
    console.log(`   상태 ${m2.statusOf(r2.id)} · streaming=${String(last2.streaming)} · truncated=${String(last2.truncated)}`);
    console.log(`   알림 ${notes.length}개 · 카드 답함 ${settled}번`);
    ok(m2.statusOf(r2.id) === "error", "★ 죽은 것은 알아챈다");
    ok(last2.streaming === false && last2.truncated === true,
       "★ 말풍선도 닫힌다 — 묻는 중이었어도");

    /*
     * ★ **카드가 거둬진다** (2026-10-14).
     *
     * 🔴 실측 전에는 **그대로 떠 있었다.** 답할 상대가 없는 카드를 사용자가
     * 보고 있고, 눌러도 받을 데가 없다. 전체 중지가 쓰는 길(`cancelPermissions`)
     * 을 그대로 쓰되 **그 봇 것만** 거둔다 — 단체방에서 남의 카드까지 걷으면
     * 멈추라고 한 적 없는 일이 멈춘다.
     */
    ok(settled === 1,
       `★ **떠 있던 카드를 거둔다** — 답할 상대가 없다 (거둠 ${settled}번)`);
    ok(pulledFor === open2.participants[0]!.id,
       `★ **그 봇 것만** 집어 거둔다 — 단체방에서 남의 카드까지 걷으면 안 된다 (${pulledFor})`);

    /*
     * ★ **늦게 답해도 상태가 안 되살아난다** (2026-10-14).
     *
     * 🔴 `askPermission` 의 `finally` 가 **무조건** 원래 상태로 되돌렸다.
     * 그래서 죽어서 `error` 가 된 뒤에 카드가 풀리면 **`tool` 로 되살아났고**,
     * 죽은 프로세스를 기다리는 꼴이 됐다 — 점도 다시 돈다. 실측에서 그대로
     * 나왔다(상태 tool).
     */
    await nap(200);
    ok(m2.statusOf(r2.id) === "error",
       `★ **죽은 채로 남는다** — 늦은 답이 «작업하는 중» 으로 되살리지 않는다 (${m2.statusOf(r2.id)})`);
    m2.dispose();
    await nap(150);
    await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과${NL}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
