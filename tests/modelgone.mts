/**
 * **CLI 가 모델을 바꾸면 어떻게 되나** (2026-09-29).
 *
 * 사용자 물음: *"cli에서 모델 업데이트 되면 어떻게 돼?"*
 *
 * 고른 모델(`configValues`)은 **우리 디스크에** 남는다. 그런데 CLI 가 올라가면서
 * 그 모델이 **목록에서 빠질 수** 있다 — 이름이 바뀌거나 내려가거나. 그때 우리가
 * 옛 id 를 우기면 무슨 일이 나는지, 그리고 **사용자가 알 수 있는지**를 잰다.
 *
 * ```
 * 우긴다   → 매번 실패한다. 화면은 옛 모델을 가리키는데 실제로는 다른 것이 돈다
 * 접는다   → 에이전트 기본값으로 간다. 그런데 **말해주지 않으면 모른다**
 * ```
 *
 * ★ 그런데 **모델이 바뀌는 길은 둘**이다 (`tests/probes/modelids.cjs` 실측).
 *
 * ```
 * ① id 가 사라진다      sonnet 이 목록에서 빠진다        ← 아래 둘째 칸
 * ② id 는 그대로다      「Sonnet 5」→「Sonnet 6」        ← 아래 셋째 칸
 * ```
 *
 * 어댑터가 주는 id 는 **전부 별명**이라(`sonnet`·`opus[1m]`·`haiku`) 판이
 * 올라갈 때 실제로 일어나는 쪽은 **②**다. ①만 지켜보면 정작 흔한 쪽을
 * 놓친다 — 같은 값이니 «되살릴 것 없음» 으로 조용히 지나간다.
 *
 * 가짜 에이전트에 `AIO_FAKE_DROP_MODEL` 이 **있는데 쓰는 검사가 없었다** —
 * 길을 만들어 두고 한 번도 안 밟아본 셈이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));

const current = (opts: Array<{ category?: string; currentValue?: unknown }>, cat: string) =>
  opts.find((o) => o.category === cat)?.currentValue;

function make(dir: string, state: string, env: Record<string, string> = {}) {
  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state, ...env },
  };
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir,
  };
  return { agent, host };
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-gone-"));
  const state = path.join(dir, "fake.jsonl");
  const store = new RoomStore(dir); await store.init();

  console.log("\n[★ 소넷을 골라 둔다]");
  let roomId: string;
  {
    const { agent, host } = make(dir, state);
    const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    mgr.on("roomError", () => {});
    const room = await mgr.createRoom({
      agentId: "fake", title: "소넷 방", configValues: { model: "sonnet" },
    });
    roomId = room.id;
    ok(current(await mgr.roomConfigOptions(room.id), "model") === "sonnet", "★ 소넷으로 잡혔다");

    const saved = (await store.loadRoom(room.id))!;
    ok(saved.participants[0]?.configValues?.["model"] === "sonnet",
       "★ **디스크에도 남는다** — 여기가 다음에 우길 값이다");
    mgr.dispose();
  }

  console.log("\n[★ CLI 가 올라가면서 소넷이 목록에서 빠졌다]");
  {
    const { agent, host } = make(dir, state, { AIO_FAKE_DROP_MODEL: "sonnet" });
    const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    mgr.on("roomError", () => {});

    const room = await mgr.openRoom(roomId);
    // 세션을 붙인다 — 여기서 저장해 둔 값을 적용하려 든다
    await mgr.send(room.id, "안녕");
    for (let i = 0; i < 400 && mgr.statusOf(room.id) !== "idle"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const opts = await mgr.roomConfigOptions(room.id);
    const now = current(opts, "model");
    const offered = (opts.find((o) => o.category === "model") as { options?: unknown[] })?.options ?? [];
    console.log(`   지금 모델: ${String(now)} · 고를 수 있는 것 ${offered.length}개`);

    ok(now !== "sonnet",
       `★ **사라진 모델을 안 우긴다** (${String(now)}) — 그쪽이 진실이다`);
    ok(typeof now === "string" && now.length > 0, "★ 빈 값으로 안 남는다");

    const bot = room.participants[0]!;
    console.log(`   저장된 값: ${JSON.stringify(bot.configValues?.["model"])} · 이름: ${bot.modelLabel}`);
    ok(bot.configValues?.["model"] === now,
       "★ **저장값도 따라간다** — 안 고치면 다음 판에서 또 우긴다");

    /*
     * ★ 여기가 이 검사의 핵심이다.
     *
     * 값은 스스로 낫는다. 그런데 **사용자는 아무 말도 못 듣는다** — 고른 모델이
     * 사라져 다른 것이 도는데, 화면 어딘가의 이름이 조용히 바뀔 뿐이다.
     * 직접 바꿨을 때는 «…으로 바뀌었습니다»를 적으면서(§0 뺄셈 규칙),
     * **남이 뺏어갔을 때는 안 적는다.**
     */
    const told = room.messages.filter(
      (m) => m.role === "system" && /모델|Sonnet|Opus/i.test(m.text),
    );
    console.log(`   알려준 줄: ${told.length}개 ${told.map((m) => `«${m.text}»`).join(" ")}`);
    ok(told.length > 0,
       "★ **바뀌었다고 알려준다** — 고른 것이 말없이 사라지면 «왜 딴 모델이 돌지»가 된다");

    mgr.dispose();
  }

  console.log("\n[★ 별명은 그대로인데 뒤의 판이 올라갔다]");
  {
    /*
     * 🔴 **이쪽이 진짜 흔한 길이다.** `sonnet` 은 그대로 있고 이름만
     * 「Sonnet 5」→「Sonnet 6」 이 된다. 값이 같으니 `restoreChoices` 는
     * 되살릴 것이 없다고 보고 넘어간다 — ①의 감시망에 **안 걸린다.**
     *
     * 잡을 수 있는 신호는 `noteModel` 의 «이름이 달라졌다» 뿐인데, 그걸
     * 화면 새로고침에만 쓰고 있었다.
     */
    const { agent, host } = make(dir, state, { AIO_FAKE_BUMP: "opus" });
    const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    mgr.on("roomError", () => {});

    const room = await mgr.openRoom(roomId);
    await mgr.send(room.id, "안녕");
    for (let i = 0; i < 400 && mgr.statusOf(room.id) !== "idle"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const bot = room.participants[0]!;
    console.log(`   지금: ${bot.modelLabel} · 고른 값: ${JSON.stringify(bot.model)}`);
    ok(bot.model === "opus", "★ **별명은 안 움직인다** — 고른 값은 그대로다");
    ok(bot.modelLabel === "Opus 6", `★ 이름이 올라갔다 (${String(bot.modelLabel)})`);

    const told = room.messages.filter((m) => m.role === "system" && /Opus 6/.test(m.text));
    console.log(`   알려준 줄: ${told.length}개 ${told.map((m) => `«${m.text}»`).join(" ")}`);
    ok(told.length === 1,
       "★ **올라간 것을 적는다** — 값은 그대로인데 답이 달라지면 영문을 모른다");
    ok(/그대로/.test(told[0]?.text ?? ""),
       "★ **«고른 값은 그대로»까지 적는다** — 내가 뭘 잘못 눌렀나 싶지 않게");

    mgr.dispose();
  }

  console.log("\n[★ 같은 이름이면 두 번 말하지 않는다]");
  {
    /*
     * 알림이 **붙을 때마다** 나오면 그건 알림이 아니라 잡음이다. 창을 껐다
     * 켤 때마다 «Opus 6으로 바뀌었습니다» 가 쌓이면 진짜 변화를 못 알아본다.
     */
    const { agent, host } = make(dir, state, { AIO_FAKE_BUMP: "opus" });
    const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    mgr.on("roomError", () => {});

    const room = await mgr.openRoom(roomId);
    await mgr.send(room.id, "또 안녕");
    for (let i = 0; i < 400 && mgr.statusOf(room.id) !== "idle"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const told = room.messages.filter((m) => m.role === "system" && /Opus 6/.test(m.text));
    console.log(`   누적 알림: ${told.length}개`);
    ok(told.length === 1, "★ **한 번만 적는다** — 붙을 때마다 나오면 잡음이 된다");
    mgr.dispose();
  }

  // 가짜 프로세스가 아직 붙들고 있을 수 있다 — 지워지든 말든 임시 폴더다
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
