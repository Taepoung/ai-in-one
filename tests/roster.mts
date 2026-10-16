/**
 * **명단 프리앰블 — 표에 적히는 것이 바뀌면 다시** (v3.0 4-K).
 *
 * 봇이 다른 봇을 부르려면 **누가 있는지**를 알아야 한다. 규칙은 도구 설명에
 * 굳어 있고(세션이 열릴 때 한 번), 바뀌는 **상태**는 여기로 간다.
 *
 * ```
 * 자기는 뺀다       목록이 곧 답이다 — «그중 당신은 리뷰어» 를 추론 안 해도 된다
 * 자기 이름은 남는다  문장 속 «@리뷰어» 를 알아보려고 (§4.1.2)
 * 비면 안 보낸다     1:1 방은 릴레이를 켜도 **0 토큰**
 * 바뀌면 다시        이름 · 설명 · 구성 · 릴레이 토글 — **전체를 다시**
 * ```
 *
 * 🔴 **차분을 안 보낸다.** «베타가 나갔습니다» 한 줄은 싸 보이지만 모델이
 * 머릿속에서 합쳐야 하고, **틀려도 우리가 못 본다.**
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

/** 명단 줄의 모양 — `relay` 는 **꺼진 방에만** 붙는다 */
interface Roster { you: string; callable: Array<{ name: string; does: string }>; relay?: string }
const names = (r: Roster | null) => (r?.callable ?? []).map((b) => b.name).join(",");
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const busy = (s: string) => !["idle", "error"].includes(s);

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-roster-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: "40", AIO_FAKE_STATE: state },
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

  const prompts = async (): Promise<string[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; text: string })
        .filter((e) => e.t === "prompt").map((e) => e.text);
    } catch { return []; }
  };
  const settle = async (roomId: string) => {
    for (let i = 0; i < 1200; i++) {
      if (!busy(mgr.statusOf(roomId))) return;
      await nap(25);
    }
    throw new Error("FAIL: 전제가 안 섰다 — 방이 안 조용해진다");
  };
  /** 한 마디 보내고 **그때 나간 프롬프트**를 돌려준다 */
  const turn = async (roomId: string, text: string, botId: string): Promise<string> => {
    const before = (await prompts()).length;
    await mgr.send(roomId, text, undefined, botId);
    await settle(roomId);
    const all = await prompts();
    const mine = all.slice(before).find((p) => p.includes(text));
    if (!mine) throw new Error("FAIL: 전제가 안 섰다 — 프롬프트가 안 나갔다: " + text);
    return mine;
  };
  /**
   * 프롬프트에서 **명단 줄**을 꺼내 파싱한다.
   *
   * 🔴 깃발 줄도 `[ai-in-one] {…}` 이라 **생김새가 같다** — 가르는 것은
   * 칸이다(`you` 가 있으면 명단). 글자로 찾으면 둘이 섞인다.
   */
  const roster = (p: string): Roster | null => {
    for (const m of p.matchAll(/\[ai-in-one\] (\{.*\})/g)) {
      try {
        const o = JSON.parse(m[1]!) as Roster;
        if (typeof o.you === "string") return o;
      } catch { /* 깃발 줄이면 넘어간다 */ }
    }
    return null;
  };
  return { dir, mgr, prompts, settle, turn, roster };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 1:1 방 — 아무것도 안 나간다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const room = await t.mgr.createRoom({ agentId: "alpha", title: "둘이서" });
    const sent = await t.turn(room.id, "안녕", room.participants[0]!.id);
    ok(t.roster(sent) === null,
       "★ **목록이 비면 아예 안 보낸다** — 1:1 은 릴레이를 켜도 0 토큰이다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 단체방 — 자기는 빠지고, 자기 이름은 남는다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const room = await t.mgr.createRoom({
      title: "셋이서",
      bots: [
        { agentId: "alpha", name: "구현", blurb: "코드를 쓰고 고친다" },
        { agentId: "beta", name: "리뷰어" },
        { agentId: "gamma", name: "테스터", blurb: "검사를 돌린다" },
      ],
    });
    const me = room.participants[1]!;
    const sent = await t.turn(room.id, "안녕", me.id);
    console.log(`   ${sent.split(NL).slice(0, 8).join(" / ")}`);

    const r = t.roster(sent);
    ok(r?.callable[0]?.name === "구현" && r.callable[0].does === "코드를 쓰고 고친다",
       `★ 이름과 설명이 한 칸에 (${JSON.stringify(r?.callable[0])})`);
    ok(r?.callable[1]?.does === "검사를 돌린다", "★ 셋째도");
    ok(names(r) === "구현,테스터",
       `★ **자기는 목록에서 빠진다** (${names(r)}) — 목록이 곧 답이라 추론이 없다`);
    ok(r?.you === "리뷰어",
       `★ **자기 이름은 남는다** (${r?.you}) — 문장 속 «@리뷰어»를 알아보려면 필요하다`);
    ok(sent.indexOf("[ai-in-one]") < sent.indexOf("안녕"), "★ **실제 요청보다 앞**이다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 설명이 비면 칸이 빈다 — «(설명 없음)» 을 안 쓴다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const room = await t.mgr.createRoom({
      title: "빈 칸", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const sent = await t.turn(room.id, "안녕", room.participants[1]!.id);
    ok(t.roster(sent)?.callable[0]?.does === "",
       "★ 칸은 남고 값이 빈다 — «(설명 없음)» 같은 글자를 안 쓴다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 안 바뀌면 다시 안 나간다]`);
  {
    const t = await make(); dirs.push(t.dir);
    const room = await t.mgr.createRoom({
      title: "두 번", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const me = room.participants[1]!;
    await t.turn(room.id, "첫 마디", me.id);
    const second = await t.turn(room.id, "둘째 마디", me.id);
    ok(t.roster(second) === null,
       "★ **매 턴 토큰이 거의 안 든다** — 바뀔 때만 나간다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 표에 적히는 것이 바뀌면 — 전체를 다시]`);
  {
    const t = await make(); dirs.push(t.dir);
    const room = await t.mgr.createRoom({
      title: "바뀐다", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const me = room.participants[1]!;
    const other = room.participants[0]!;
    await t.turn(room.id, "첫 마디", me.id);

    await t.mgr.setBlurb(room.id, "코드를 쓰고 고친다", other.id);
    const afterBlurb = await t.turn(room.id, "설명 뒤", me.id);
    ok(t.roster(afterBlurb)?.callable[0]?.does === "코드를 쓰고 고친다",
       "★ **설명을 고치면 다시** — 빼두면 낡은 설명만 남는다");

    await t.mgr.addBot(room.id, { agentId: "gamma", name: "테스터" });
    const afterAdd = await t.turn(room.id, "부른 뒤", me.id);
    ok(names(t.roster(afterAdd)).includes("테스터"), "★ **봇이 늘면 다시**");
    ok(t.roster(afterAdd)?.callable.some((b) => b.does === "코드를 쓰고 고친다") === true,
       "★ 🔴 **차분이 아니라 전체다** — 모델이 합치게 하면 틀려도 우리가 못 본다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 릴레이 — 처음부터 꺼졌으면 침묵, 끄면 한 줄]`);
  {
    const t = await make(); dirs.push(t.dir);
    const off = await t.mgr.createRoom({
      title: "꺼둠", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    off.relay = "off";
    const first = await t.turn(off.id, "안녕", off.participants[1]!.id);
    ok(t.roster(first) === null,
       "★ **처음부터 꺼진 방에는 아무것도 안 보낸다** — 봇은 누가 있는지도 모른다");

    const on = await t.mgr.createRoom({
      title: "켰다 끔", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const me = on.participants[1]!;
    await t.turn(on.id, "첫 마디", me.id);
    on.relay = "off";
    const after = await t.turn(on.id, "끈 뒤", me.id);
    ok(t.roster(after)?.relay === "off",
       "★ **켜져 있다가 꺼지면 말해준다** — 명단이 이미 들어가 있어서 안 그러면 왕복이 헛돈다");
    ok(names(t.roster(after)) === "", "★ **목록이 빈다** — 부를 사람이 없다는 뜻이 모양으로 보인다");
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
