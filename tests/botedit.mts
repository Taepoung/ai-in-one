/**
 * **봇 이름 바꾸기 · 에이전트 바꾸기** — 구조만 (화면은 아직 없다).
 *
 * 이름은 우리 쪽 이름표라 세션과 무관하다. 에이전트는 반대다 — **세션이 그
 * CLI의 것**이라 갈면 새 에이전트는 지금까지의 대화를 하나도 모른다. 그 상태를
 * 표현할 자리는 이미 있다(`contextLost`, F7): 화면에 보이는 것과 에이전트가
 * 아는 것이 어긋났다는 점이 똑같다.
 *
 * 🔴 여기서 재는 것은 **잃는 것을 제대로 잃고, 남길 것을 남기는가**다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { BotInstance } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-be-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    askUser: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: path.join(dir, "s.jsonl"), AIO_FAKE_USAGE: "1" },
  };
  const agents = [
    { ...base, id: "alpha", label: "알파" },
    { ...base, id: "beta", label: "베타" },
  ];
  const mgr = new RoomManager({ host, store, agents, configProbeMs: 20000 });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  return { dir, store, mgr };
}

const settle = async (m: RoomManager, id: string) => {
  for (let i = 0; i < 800; i++) {
    const s = m.statusOf(id);
    if (s === "idle" || s === "error") return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function main(): Promise<void> {
  console.log(`${NL}[봇 이름 — 세션은 안 건드린다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "이름" });
    const bot = room.participants[0]!;
    await mgr.send(room.id, "안녕");
    await settle(mgr, room.id);
    const before = bot.sessionId;

    await mgr.renameBot(room.id, bot.id, "  리뷰어  ");
    ok(bot.name === "리뷰어", `★ 앞뒤 공백을 턴다 (${JSON.stringify(bot.name)})`);
    ok(bot.sessionId === before && bot.sessionPrompted === true,
       "★ 세션은 그대로 — 이름은 **우리 쪽 이름표**고 에이전트는 모르는 값이다");

    await mgr.renameBot(room.id, bot.id, "   ");
    ok(bot.name === "리뷰어", "빈 이름은 무시한다 — 부를 수 없는 이름은 이름이 아니다");

    /*
     * ★ **바꿨다고 적는다.**
     *
     * 멘션 칩은 `botId` 를 들고 있어서 **지난 메시지도 새 이름으로 다시
     * 그려진다.** 위로 올려보면 «@구현» 이라 보냈던 것이 «@리뷰어» 로 보이니,
     * 공지가 없으면 **기억이 틀린 것처럼 느껴진다.**
     */
    const said = room.messages.filter((m) => m.role === "system" && m.text.includes("이름을"));
    ok(said.length === 1, `★ **이름 바꾼 것도 공지한다** (${said.length}개)`);
    ok(said[0]!.text.includes("알파") && said[0]!.text.includes("리뷰어"),
       `★ 전과 후를 **둘 다** 적는다 (${said[0]!.text})`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 방 만들 때 이름을 정할 수 있다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({
      title: "이름 짓기",
      bots: [
        { agentId: "alpha", name: "  구현  " },
        { agentId: "alpha", name: "리뷰어" },
        { agentId: "alpha" },
      ],
    });
    const [a, b, c] = room.participants;
    ok(a!.name === "구현", `★ 정한 이름이 붙는다 (${a!.name}) — 앞뒤 공백은 턴다`);
    ok(b!.name === "리뷰어", "★ 봇마다 따로");
    ok(c!.name === "알파",
       `★ **비우면 에이전트 이름** (${c!.name}) — 빈 칸이 «이름 없음»이 아니다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 만들 때 겹쳐도 갈라진다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({
      title: "겹침",
      bots: [
        { agentId: "alpha", name: "리뷰어" },
        { agentId: "beta", name: "리뷰어" },
        { agentId: "beta", name: "리뷰어" },
      ],
    });
    const names = room.participants.map((p) => p.name);
    ok(names.join() === "리뷰어,리뷰어 2,리뷰어 3",
       `★ 뒤에 수를 붙인다 (${names.join(" · ")}) — @리뷰어가 셋을 가리키면 안 된다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 부를 때도 이름을 정한다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "부르기" });
    const added = await mgr.addBot(room.id, { agentId: "beta", name: "리뷰어" });
    ok(added.name === "리뷰어", `★ 부르면서 이름을 준다 (${added.name})`);

    const dup = await mgr.addBot(room.id, { agentId: "beta", name: "리뷰어" });
    ok(dup.name === "리뷰어 2",
       `★ 이미 있으면 갈라진다 (${dup.name}) — 여기가 이름이 제일 필요한 순간이다`);
    mgr.dispose();
  }

  console.log(`${NL}[★ 목록에도 봇 이름이 실린다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({
      title: "목록",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const meta = mgr.listMetas().find((m) => m.id === room.id)!;
    ok(meta.names?.join() === "구현,리뷰어",
       `★ **부를 이름이 목록까지 간다** (${meta.names?.join(" · ")}) — 목록은 방을 안 읽는다`);
    ok(meta.agentIds.join() === "alpha,beta", "★ 에이전트도 그대로 — 버리지 않는다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 이름은 방 안에서 유일하다 — 멘션이 갈라져야 하므로]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "겹침" });
    const a = room.participants[0]!;
    const b: BotInstance = {
      id: "b2", agentId: "alpha", name: "둘째", sessionId: null,
      approver: { kind: "user" }, answerPolicy: "ask",
    };
    room.participants.push(b);

    await mgr.renameBot(room.id, a.id, "리뷰어");
    await mgr.renameBot(room.id, b.id, "리뷰어");
    ok(a.name === "리뷰어" && b.name === "리뷰어 2",
       `★ 겹치면 뒤에 수를 붙인다 (${a.name} · ${b.name}) — @리뷰어가 둘을 가리키면 안 된다`);

    const c: BotInstance = { ...b, id: "b3", name: "셋째" };
    room.participants.push(c);
    await mgr.renameBot(room.id, c.id, "리뷰어");
    ok(c.name === "리뷰어 3", `★ 계속 비켜간다 (${c.name})`);

    // ★ **우리가 고쳤으면 «고쳤다»가 남아야 한다** (§0 뺄셈 규칙)
    const bent = room.messages.filter((m) => m.role === "system" && m.text.includes("이미 있어서"));
    ok(bent.length === 2,
       `★ **사용자가 친 것과 다른 값이 됐다고 말한다** (${bent.length}개) — 조용히 바꾸면 «왜 2가 붙었지»가 된다`);
    ok(bent[0]!.text.includes("«리뷰어»"), `★ 무엇을 치려 했는지도 (${bent[0]!.text})`);
    mgr.dispose();
  }

  console.log(`${NL}[에이전트 바꾸기 — 세션을 버리는 일이다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "교체" });
    const bot = room.participants[0]!;
    await mgr.send(room.id, "기억해둬");
    await settle(mgr, room.id);

    const old = bot.sessionId;
    ok(old !== null && bot.sessionPrompted === true, "바꾸기 전: 말을 건 세션이 있다");
    ok(bot.usage?.contextUsed !== undefined, "바꾸기 전: 사용량도 있다");

    await mgr.setAgent(room.id, bot.id, "beta");

    ok(bot.agentId === "beta", "★ 에이전트가 바뀐다");
    ok(bot.sessionId === null && bot.sessionPrompted === false,
       "★ **세션을 놓는다** — 알파의 세션을 베타가 이어받을 방법이 없다");
    ok(bot.usage === undefined && bot.model === undefined && bot.agentMode === undefined,
       "★ 모델·권한·사용량도 버린다 — 새 에이전트에 없는 id를 들고 있으면 복구 때 엉뚱한 값을 민다");
    ok(bot.name === "베타", "★ 이름을 손대지 않았던 사람에게는 에이전트 이름이 곧 봇 이름이었다");

    ok(room.contextLost === true,
       "★ **화면과 에이전트가 어긋났다** — F7과 같은 자리이므로 되먹임 제안이 그대로 뜬다");
    ok(room.lostSessionId === old,
       `★ 이전 세션 id를 **남긴다** — 우리는 기록자다 (${room.lostSessionId})`);

    const note = room.messages.filter((m) => m.role === "system").at(-1)!;
    ok(note.text.includes("알파") && note.text.includes("베타"),
       `★ 어디서 어디로 갔는지 (${note.text.slice(0, 40)}…)`);
    ok(note.text.includes("위 대화를 모릅니다"), "★ **무엇을 잃었는지 먼저 말한다**");
    ok(note.text.includes(old!), "★ 이전 세션 id도 적는다 — 그 CLI에서 열어볼 수 있게");
    mgr.dispose();
  }

  console.log(`${NL}[바꾼 뒤에도 대화 기록은 우리 것이다]`);
  {
    const { mgr, store } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "기록" });
    const bot = room.participants[0]!;
    await mgr.send(room.id, "남아라");
    await settle(mgr, room.id);
    const said = room.messages.filter((m) => m.role !== "system").length;

    await mgr.setAgent(room.id, bot.id, "beta");
    ok(room.messages.filter((m) => m.role !== "system").length === said,
       "★ 말풍선은 하나도 안 지운다 — 세션은 그쪽 것이고 기록은 우리 것이다");

    const saved = await store.loadRoom(room.id);
    ok(saved!.participants[0]!.agentId === "beta", "디스크에도 새 에이전트");
    ok(saved!.contextLost === true, "★ 껐다 켜도 **어긋났다**는 사실이 남는다");
    mgr.dispose();
  }

  console.log(`${NL}[돌고 있으면 안 바꾼다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "바쁨" });
    const bot = room.participants[0]!;
    const turn = mgr.send(room.id, "천천히");
    await new Promise((r) => setTimeout(r, 30));

    let why = "";
    try { await mgr.setAgent(room.id, bot.id, "beta"); } catch (e) { why = (e as Error).message; }
    await turn; await settle(mgr, room.id);

    if (why) {
      ok(why.includes("답하는 중"), `★ 답이 오는 중에 갈면 그 답은 갈 곳이 없다 (${why})`);
    } else {
      ok(bot.agentId === "beta", "턴이 이미 끝났으면 그냥 바뀐다 (경합이라 둘 다 정상)");
    }
    mgr.dispose();
  }

  console.log(`${NL}[같은 에이전트로 바꾸면 아무 일도 없다]`);
  {
    const { mgr } = await make();
    const room = await mgr.createRoom({ agentId: "alpha", title: "그대로" });
    const bot = room.participants[0]!;
    await mgr.send(room.id, "안녕");
    await settle(mgr, room.id);
    const old = bot.sessionId;

    await mgr.setAgent(room.id, bot.id, "alpha");
    ok(bot.sessionId === old && !room.contextLost,
       "★ 안 바뀐 것을 바꿨다고 치고 세션을 버리지 않는다");
    mgr.dispose();
  }

  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
