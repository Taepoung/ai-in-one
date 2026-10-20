/**
 * **두 봇이 같은 파일을 만졌다** (v2.0 · §4.3) — 2026-09-22 실측으로 전면 개정.
 *
 * 🔴 **예전에는 «덮어쓴다»고 적었다. 사실이 아니다.** 진짜 Claude Code로 재보니:
 *
 * ```
 * Edit  · 고치는 자리가 안 겹침  →  통과.  둘 다 살아남는다
 * Edit  · 고치는 자리가 겹침    →  거부.  "File has been modified since read"
 * Write                         →  거부.  항상
 * bash (`> file`, `sed -i`)     →  덮어쓴다. 가드도 경고도 없다
 * ```
 *
 * 그래서 두 가지가 바뀌었다:
 *
 * 1. **정황에는 대화를 적지 않는다.** 둘이 같은 파일을 만졌다는 것만으로는
 *    아무 일도 안 일어난다. 그런데 예전 문구를 믿은 사용자는 **멀쩡히 살아 있는
 *    작업을 다시 시킬 수 있었다.** 정황은 이제 **띠로만** 보인다.
 * 2. **막혔을 때만 적는다.** `tool_call` 이 `failed` 로 오는 것이 사실이다.
 *    ★ 그리고 **막힌 수정은 diff가 안 오므로**(아무것도 안 썼다) 예전 방식으로는
 *    **이 경우를 아예 못 봤다** — 정작 알아야 할 쪽이 안 보였다.
 *
 * ★ 에이전트가 주는 사유는 *"by the user or by a linter"* 다 — **누가 바꿨는지
 * 모른다.** 그 자리를 채우는 것이 우리 몫이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { ComposeToken } from "../src/core/mentions.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));

async function make(hold = 600) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-clash-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_HOLD: String(hold) },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{ ...base, id: "alpha", label: "알파" }, { ...base, id: "beta", label: "베타" }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await nap(25);
    }
  };
  /** 띠는 **살아 있을 때만** 보이므로 도는 동안 잡아야 한다 */
  const untilBand = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const live = mgr.clashesIn(id);
      if (live.length > 0) return live;
      await nap(20);
    }
    return mgr.clashesIn(id);
  };
  return { dir, mgr, settle, untilBand };
}
const at = (botId: string): ComposeToken => ({ kind: "mention", botId });
const txt = (text: string): ComposeToken => ({ kind: "text", text });
/** 대화에 남은 부딪힘 기록 */
const noted = (room: { messages: Array<{ role: string; text: string }> }) =>
  room.messages.filter((m) => m.role === "system" && m.text.includes("거부됐습니다"));

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 정황은 띠에만 — 대화에는 안 적는다]`);
  {
    const { dir, mgr, settle, untilBand } = await make(1200); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "정황", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;

    // 한 그룹으로 둘을 지목 → **병렬로** 돈다 (§4.3)
    void mgr.sendCompose(room.id, [
      at(a!.id), txt(" "), at(b!.id), txt(`${NL}[[diff:src/core/foo.ts]] 고쳐줘`),
    ]);

    const band = await untilBand(room.id);
    ok(band.length === 1, `★ **띠에 뜬다** (${band.length}개) — «지금» 부딪히는 중임을 보여준다`);
    ok(band[0]!.path === "src/core/foo.ts", `★ 어느 파일인지 (${band[0]!.path})`);
    ok(band[0]!.botIds.length === 2, "★ 누구와 누구인지 — 그래야 어느 쪽을 볼지 정한다");
    ok(band[0]!.blocked !== true,
       "★ **아직 사실이 아니다** — 자리가 안 겹치면 둘 다 살아남는다");

    await settle(room.id);
    ok(noted(room).length === 0,
       "★ **대화에는 안 적는다** — 예전엔 «덮어쓸 수 있습니다»라고 적었고 그건 거짓이었다");
    ok(mgr.clashesIn(room.id).length === 0,
       "★ **둘 다 멈추면 띠가 걷힌다** — 부딪힐 상대가 없으면 끝난 것이다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 막히면 그때 적는다 — 그리고 diff로는 못 보던 경우다]`);
  {
    const { dir, mgr, settle, untilBand } = await make(2500); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "막힘", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;

    // 알파가 먼저 그 파일을 고치고 **아직 도는 중**일 때
    void mgr.send(room.id, "[[diff:same.ts]] 고쳐줘", undefined, a!.id);
    await nap(500);
    // 베타가 같은 파일을 고치려다 **거부당한다** — 쓴 게 없으니 diff는 안 온다
    void mgr.send(room.id, "[[fail:same.ts]] 고쳐줘", undefined, b!.id);

    const band = await untilBand(room.id);
    const hit = band.find((c) => c.path === "same.ts");
    ok(hit !== undefined, "띠에 잡혔다");
    ok(hit!.blocked === true, "★ **사실로 올라간다** — 에이전트가 실패로 신고했다");
    ok(hit!.blockedBotId === b!.id, "★ **누가 막혔는지** — 에이전트는 이걸 모른다");
    ok((hit!.reason ?? "").includes("modified since read"),
       "★ **CLI가 준 말 그대로** 싣는다 (§0) — 우리 말로 바꾸면 원인을 못 짚는다");

    await settle(room.id);
    const said = noted(room);
    ok(said.length === 1, `★ **막혔을 때만** 대화에 남는다 (${said.length}개)`);
    ok(said[0]!.text.includes("베타") && said[0]!.text.includes("알파"),
       `★ 막힌 쪽과 먼저 바꾼 쪽을 **둘 다** 적는다 — «누가»는 우리만 안다`);
    ok(said[0]!.text.includes("same.ts"), "★ 어느 파일인지");
    ok(!said[0]!.text.includes("덮어"),
       "★ **«덮어쓴다»고 말하지 않는다** — 실측으로 거짓임이 확인된 말이다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 기록은 디스크에 남는다]`);
  {
    const { dir, mgr, settle } = await make(2500); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "기록", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    void mgr.send(room.id, "[[diff:a.ts]] 고쳐줘", undefined, a!.id);
    await nap(500);
    void mgr.send(room.id, "[[fail:a.ts]] 고쳐줘", undefined, b!.id);
    await settle(room.id);
    mgr.dispose();

    const store2 = new RoomStore(dir); await store2.init();
    const again = await store2.loadRoom(room.id);
    ok(noted(again!).length === 1,
       "★ **띠는 사라져도 기록은 남는다** (§0 P5) — 띠는 «지금»이고 기록은 «그때»다");
  }

  console.log(`${NL}[★ 같은 봇이 두 번 막혀도 한 번만 적는다]`);
  {
    const { dir, mgr, settle } = await make(2500); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "반복", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    void mgr.send(room.id, "[[diff:dup.ts]] 고쳐줘", undefined, a!.id);
    await nap(500);
    void mgr.send(room.id, `[[fail:dup.ts]] [[fail:dup.ts]] 고쳐줘`, undefined, b!.id);
    await settle(room.id);
    ok(noted(room).length === 1,
       "★ 한 파일로 여러 번 막혀도 **한 줄** — 줄마다 떠들면 대화가 경고로 덮인다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 다른 파일이면 아무 일도 없다]`);
  {
    const { dir, mgr, settle } = await make(1200); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "따로", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    void mgr.sendCompose(room.id, [
      at(a!.id), txt(`${NL}[[diff:a.ts]] 고쳐줘${NL}${NL}`),
      at(b!.id), txt(`${NL}[[diff:b.ts]] 고쳐줘`),
    ]);
    await nap(400);
    ok(mgr.clashesIn(room.id).length === 0, "★ 띠도 안 뜬다");
    await settle(room.id);
    ok(noted(room).length === 0, "★ 병렬 자체는 이 기능의 요점이다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 순서대로 시킨 것은 부딪힘이 아니다]`);
  {
    const { dir, mgr, settle } = await make(0); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "차례로", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;

    await mgr.send(room.id, "[[diff:same.ts]] 먼저", undefined, a!.id);
    await settle(room.id);
    await mgr.send(room.id, "[[fail:same.ts]] 그다음", undefined, b!.id);
    await settle(room.id);

    ok(noted(room).length === 0,
       "★ **앞 봇이 이미 끝났으면** 실패는 다른 이유다 — 부딪힘이라고 단정하면 안 된다");
    ok(mgr.clashesIn(room.id).length === 0, "★ 띠도 없다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 1:1에서는 겹칠 상대가 없다]`);
  {
    const { dir, mgr, settle } = await make(0); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "혼자" });
    await mgr.send(room.id, "[[diff:x.ts]] 고쳐줘");
    await settle(room.id);
    await mgr.send(room.id, "[[fail:x.ts]] 또 고쳐줘");
    await settle(room.id);
    ok(noted(room).length === 0, "★ 혼자면 막혀도 부딪힘이 아니다 — 자기가 바꾼 것이다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 누가 고쳤는지 파일에 적힌다]`);
  {
    const { dir, mgr, settle } = await make(0); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "누가", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.send(room.id, "[[diff:who.ts]] 고쳐줘", undefined, b!.id);
    await settle(room.id);

    const changed = room.messages.flatMap((m) => m.files ?? []);
    ok(changed.length === 1, "파일 하나");
    ok(changed[0]!.byBotId === b!.id,
       "★ **고친 봇이 파일에 적힌다** — 카드가 메시지 밖으로 새어 나가도(diff·검색) 따라간다");
    ok(changed[0]!.byBotId !== a!.id, "알파 것이 아니다");
    mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await nap(200); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
