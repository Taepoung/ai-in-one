/**
 * **봇이 스스로 깨어나면 우리가 막지 않나** (2026-09-28).
 *
 * 진짜 CLI 는 **턴이 끝난 뒤에 제 발로 말한다**(`probes/selfwake.cjs` 실측):
 * 백그라운드로 띄운 일이 끝나자, 우리가 아무것도 안 보냈는데 25초 뒤에
 * «출력은 감자칠십칠이고 종료 코드는 0이야» 가 왔다. 턴은 이미 `end_turn`
 * 으로 닫혀 있었다.
 *
 * 그러면 남는 질문은 우리 쪽이다 — **받아서 화면에 얹나, 흘리나.**
 *
 * 🔴 `onIdleEvent` 의 설명에는 *"말과 도구 호출은 여기서 방에 심지 않는다"* 고
 * 적혀 있었는데 **코드는 반대였다.** 글만 읽었으면 «안 되는구나» 하고 딴 데를
 * 팠을 것이다. 그래서 글이 아니라 **동작**으로 못 박는다.
 *
 * ★ **두 경우를 다 고정한다.** 턴이 끝나도 `TURN_TAIL_MS`(1.5초) 동안은 늦게
 * 온 조각을 **그 턴의 꼬리**로 본다 — 응답보다 늦는 조각이 실제로 있어서다.
 * 그 밖이면 **새 말풍선**이다. 둘을 같이 재지 않으면, 유예를 건드렸을 때
 * 한쪽만 깨져도 모른다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (t: number) => new Promise((r) => setTimeout(r, t));

/** `roomManager.ts` 의 `TURN_TAIL_MS` 와 같은 값이어야 한다 */
const TAIL_MS = 1500;
const LATE = "백그라운드 일이 끝났어";

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-wake-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{
      ...DEFAULT_AGENTS[0]!, id: "alpha", label: "알파",
      command: "node", args: [path.join(here, "fakeagent.cjs")],
    }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await nap(25);
    }
  };
  return { mgr, settle };
}

async function main(): Promise<void> {
  const { mgr, settle } = await make();

  console.log("\n[★ 유예 **밖**에 온 말은 새 말풍선이 된다]");
  {
    const room = await mgr.createRoom({ agentId: "alpha", title: "백그라운드" });
    await mgr.send(room.id, `오래 걸리는 거 돌려놔줘 [[wake:${TAIL_MS + 1000}]]`);
    await settle(room.id);

    const before = room.messages.filter((m) => m.role === "agent").length;
    ok(mgr.statusOf(room.id) === "idle", "★ 턴은 끝났다 — 여기서부터가 «턴 밖»이다");

    // 아무것도 안 보내고 기다린다 — 진짜 CLI 에서 일어난 그대로
    await nap(TAIL_MS + 2000);

    const after = room.messages.filter((m) => m.role === "agent");
    const woke = after.find((m) => m.text.includes(LATE));
    console.log(`   말풍선 ${before} → ${after.length} · 늦게 온 말: «${woke?.text ?? "(없음)"}»`);

    ok(woke !== undefined,
       "★ **턴 밖 발화를 방에 심는다** — 흘리면 «CLI가 준 걸 우리가 숨긴» 것이 된다 (§0 P5)");
    ok(after.length === before + 1,
       `★ **새 말풍선으로** 뜬다 (${before} → ${after.length}) — 한참 전 말풍선에 이어 붙이면 시각이 거짓말을 한다`);
    ok(woke!.text === LATE,
       `★ 앞 턴의 말이 안 섞인다 («${woke!.text}»)`);
    ok(woke!.authorBotId === room.participants[0]!.id,
       "★ 누가 한 말인지도 붙는다 — 단체방에서 이게 없으면 익명이 된다");

    ok(woke!.replyToIds === undefined,
       "★ **답장이 아니다** — 가리킬 질문이 애초에 없다");
    /*
     * 🔴 한때 «이 봇이 마지막으로 답한 턴»을 물려받게 했었다. 그럴듯했지만
     * **도중에 딴 말을 하면 그쪽으로 걸린다.** 이제는 **깨운 활동을 짚었을
     * 때만** 적는다 — 여기선 백그라운드 흉내를 안 냈으므로 비어 있어야 한다.
     */
    ok(woke!.afterIds === undefined && woke!.afterToolId === undefined,
       "★ **못 짚으면 비워 둔다** — 틀린 연결은 없느니만 못하다");
  }

  console.log("\n[★ 유예 **안**에 온 조각은 그 턴의 꼬리다]");
  {
    /*
     * 응답(`session/prompt` 의 반환)보다 **늦게 오는 조각이 실제로 있다.**
     * 그걸 새 말풍선으로 만들면 한 턴의 답이 둘로 쪼개져 보인다. 그래서
     * 1.5초는 «아직 그 턴»으로 본다 — 이건 버그가 아니라 규칙이다.
     */
    const room = await mgr.createRoom({ agentId: "alpha", title: "꼬리" });
    await mgr.send(room.id, "짧은 거 [[wake:300]]");
    await settle(room.id);
    await nap(TAIL_MS + 800);

    const agents = room.messages.filter((m) => m.role === "agent");
    console.log(`   말풍선 ${agents.length}개 · «${agents.map((m) => m.text).join(" | ")}»`);
    ok(agents.length === 1,
       `★ **쪼개지지 않는다** (${agents.length}개) — 유예 안의 조각은 같은 답이다`);
    ok(agents[0]!.text.includes(LATE),
       "★ 그래도 내용은 들어 있다 — 버리는 게 아니라 이어 붙이는 것");
  }

  console.log("\n[★ 깨어난 뒤가 성한가 — 상태·미읽음·다음 말]");
  {
    /*
     * «답장이 아닌 말풍선» 은 우리 모델에 없던 것이다. 턴 경로가 **끝나면서**
     * 하는 일들 — 미읽음 세기 · 상태 되돌리기 — 을 이쪽은 안 거친다.
     *
     * 🔴 상태가 `streaming` 에 걸린 채 남으면 **큐가 영영 안 빠진다.** 줄은
     * 턴이 끝날 때 나가는데, 끝날 턴이 없기 때문이다. 대화가 통째로 멈춘다.
     * 🔴 미읽음이 안 오르면 **아무도 안 기다리던 말**이라 화면 어디에도 안 뜬다.
     */
    const room = await mgr.createRoom({ agentId: "alpha", title: "깨어난 뒤" });
    // 다른 방을 보고 있다 — 미읽음이 의미를 갖는 조건 (B8)
    await mgr.setActiveRoom(null);
    await mgr.send(room.id, `돌려놔줘 [[wake:${TAIL_MS + 1000}]]`);
    await settle(room.id);

    const unreadBefore = room.unread;
    /*
     * 🔴 시간을 세서 보다가 **400ms 일찍 봤다.** 깨어난 시각이 프롬프트 기준인데
     * 닫힘은 «깨어난 뒤 1.5초»라, 둘을 더한 자리를 손으로 맞추면 흔들린다.
     * 말이 **오게** 한 다음, **가라앉을 때까지** 기다린다.
     */
    await nap(TAIL_MS + 2000);   // 깨어나는 것까지는 기다려야 한다
    await settle(room.id);        // 그 뒤로는 닫힐 때까지 (안 닫히면 여기서 걸린다)

    console.log(`   상태  : ${mgr.statusOf(room.id)}`);
    console.log(`   미읽음: ${unreadBefore} → ${room.unread}`);

    ok(mgr.statusOf(room.id) === "idle",
       `★ **말을 마치면 다시 idle** (${mgr.statusOf(room.id)}) — streaming 으로 올려놓고 안 내리면 큐가 영영 안 빠진다`);
    ok(room.unread > unreadBefore,
       `★ **안 보는 방이면 미읽음으로 센다** (${unreadBefore} → ${room.unread}) — 아무도 안 기다리던 말이라 표시가 없으면 묻힌다`);

    // 그리고 그 뒤의 말이 실제로 나가는가
    await mgr.send(room.id, "그래서?");
    await settle(room.id);
    const got = room.messages.filter((m) => m.role === "user" && m.text.includes("그래서?"));
    ok(got.length === 1 && got[0]!.placedAt !== undefined,
       "★ **그 뒤의 말도 나간다** — 줄에 선 채 멈추면 대화가 죽는다");
  }

  console.log("\n[★ 혼잣말 «도중에» 올려둔 말도 나가나]");
  {
    /*
     * 🔴 **혼잣말에는 끝낼 턴이 없다.** 봇이 스스로 깨어나 말하는 동안 상태는
     * `streaming` 이라 그때 보낸 말은 바로 못 나간다 — 올려둔 칸으로 간다.
     * 그런데 그 칸을 내보내는 고리가 **`runQueue` 안에만** 있으면, 턴이 없는
     * 혼잣말 뒤에는 **아무도 안 내보낸다.**
     *
     * 그러면 입력창 위에 «⏳ 끝나면 보냅니다»가 떠 있고, 사용자가 **다음 말을
     * 보낼 때까지** 안 나간다. 봇이 혼자 떠드는 사이에 말을 걸면 그렇게 된다.
     *
     * ⏪ 줄(큐)이던 시절에도 같은 자리였다(2026-09-28). 그릇만 바뀌었다.
     */
    const room = await mgr.createRoom({ agentId: "alpha", title: "도중에" });
    await mgr.send(room.id, `돌려놔줘 [[wake:${TAIL_MS + 1000}]]`);
    await settle(room.id);

    // 혼잣말이 시작될 때까지 기다린다 — 그 한가운데서 말을 걸어야 한다
    let hit = false;
    for (let i = 0; i < 400; i++) {
      if (mgr.statusOf(room.id) === "streaming") { hit = true; break; }
      await nap(25);
    }
    ok(hit, "★ 혼잣말이 도는 중이다 — 여기서 말을 건다");

    await mgr.send(room.id, "그 사이에 한마디");
    ok(room.staged !== undefined, "★ 올려둔 칸으로 갔다 — 혼잣말 한가운데라 지금은 못 간다");

    // 혼잣말이 끝나고도 한참 둔다 — 누가 내보내기를 기다려 본다
    await settle(room.id);
    for (let i = 0; i < 400 && room.staged !== undefined; i++) await nap(25);
    await settle(room.id);

    const sent = room.messages.find((m) => m.text.includes("그 사이에"));
    console.log(`   올려둔 칸: ${room.staged === undefined ? "비었다" : "남았다"} · 나갔나: ${sent !== undefined}`);
    ok(room.staged === undefined && sent !== undefined,
       "★ **혼잣말이 끝나면 저절로 나간다** — 안 나가면 다음 말을 보낼 때까지 멈춰 있다");
  }

  console.log("\n[★ 깨운 활동을 짚는다 — «도중에 딴 말»이 있어도]");
  {
    /*
     * ★ 이게 이 기능의 심장이다.
     *
     * 백그라운드가 도는 사이에 사용자가 **딴 말**을 하면, «마지막으로 답한 턴»
     * 으로 거는 방식은 **그 딴 말을 가리킨다.** 실제로 «2 더하기 2는?» 을
     * 가리켰다. 그래서 대화 순서가 아니라 **일**을 따라간다:
     *
     * ```
     * 띄울 때   output: "…written to: …\tasks\<id>.output"
     * 깨어나서  paths : ["…\tasks\<id>.output"]
     * ```
     */
    const room = await mgr.createRoom({ agentId: "alpha", title: "추적" });
    await mgr.send(room.id, `빌드 돌려놔줘 [[bg:task77]] [[wake:${TAIL_MS + 1200}]]`);
    await settle(room.id);
    const launched = room.messages.find((m) => m.role === "user")!;

    // ★ 도중에 딴 말 — 옛 방식이 여기에 걸렸다
    await mgr.send(room.id, "잠깐, 2 더하기 2는?");
    await settle(room.id);
    const distraction = room.messages.find((m) => m.text.includes("2 더하기"))!;

    await nap(TAIL_MS + 2200);
    await settle(room.id);

    const woke = room.messages.filter((m) => m.role === "agent").at(-1)!;
    console.log(`   깨어난 말 : «${woke.text}»`);
    console.log(`   afterIds  : ${JSON.stringify(woke.afterIds)}`);
    console.log(`   afterTool : ${woke.afterToolId}`);

    ok(woke.text.includes(LATE), "★ 깨어난 말이 맞다");
    ok(woke.afterToolId === "bg-task77",
       `★ **깨운 활동을 짚는다** (${woke.afterToolId}) — 출력 파일 이름이 양쪽에 있다`);
    ok(woke.afterIds?.[0] === launched.id,
       "★ **그 일을 시킨 요청**을 가리킨다");
    ok(woke.afterIds?.[0] !== distraction.id,
       "★ **도중에 들어온 딴 말에 안 걸린다** — 대화 순서가 아니라 일을 따라간다");
  }

  mgr.dispose();
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
