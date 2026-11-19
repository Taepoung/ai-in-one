/**
 * **봇에게 브라우저(Claude in Chrome)를 준다** (사용자, 2026-11-19).
 *
 * 사용자: *"Claude in Chrome 은 지원하게 할 수 있어?"* — 품은 claude.exe 에 이미 있고,
 * 세션을 열 때 `_meta.claudeCode.options.extraArgs.chrome` 을 실으면 켜진다(실측
 * `chromeprobe`). 열린 세션을 다른 `_meta` 로 다시 붙이면 켜고 꺼진다(실측
 * `chromeresume`). 여기서는 **우리가 무엇을 실어 보내는지**를 잰다:
 *
 * ```
 * ① 끈 봇은 아무것도 안 싣는다
 * ② 켜면 다음 말 전에 **같은 세션에** 켠 채로 다시 붙는다 — 새 세션이 아니다
 * ③ 끄면 안 싣고 다시 붙는다 — 안 싣는 것이 끄는 것이다
 * ④ 껐다 켜고 다시 붙을 때도 실린다 — 이어받기 길
 * ⑤ 켤 줄 모르는 에이전트는 켜도 아무것도 안 싣는다
 * ⑥ 도구가 돌려준 그림(스크린샷)은 blob 으로 남고, 그림이 아닌 것은 버린다
 * ⑦ 알약에 «Chrome» 이 붙는다
 * ```
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { imagesOf } from "../src/core/acpConnection.js";
import type { AgentDef } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

type Ev = { t: string; sessionId?: string; meta?: unknown };

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-browser-"));
  const state = path.join(dir, "s.jsonl");
  const disk = path.join(dir, "disk.json");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
  ok(claude.browser !== undefined, "Claude 는 브라우저를 켤 줄 안다");
  const fake = (id: string, over: Partial<AgentDef> = {}): AgentDef => ({
    ...claude, id, label: id,
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state, AIO_FAKE_DISK: disk },
    ...over,
  });
  const chromeAgent = fake("chromey");
  const { browser: _drop, ...plain } = fake("plain");
  void _drop;

  const events = async (): Promise<Ev[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean).map((l) => JSON.parse(l) as Ev);
    } catch { return []; }
  };
  const open = () => {
    const mgr = new RoomManager({ host, store, configProbeMs: 20000, agents: [chromeAgent, plain as AgentDef] });
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});
    return mgr;
  };
  const settle = async (mgr: RoomManager, roomId: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(roomId)); i++) await nap(25);
  };
  const hasChrome = (meta: unknown) => JSON.stringify(meta ?? null).includes("\"chrome\"");

  let roomId = "";
  let first = "";

  console.log(`${NL}[★ ① 끈 봇은 아무것도 안 싣는다]`);
  const mgr = open();
  {
    const room = await mgr.createRoom({ agentId: "chromey", title: "브라우저" });
    roomId = room.id;
    await mgr.send(roomId, "안녕");
    await settle(mgr, roomId);
    const made = (await events()).filter((e) => e.t === "new");
    first = made.at(-1)?.sessionId ?? "";
    ok(made.length === 1 && made[0]!.meta === null, "★ 끈 채로 열면 `_meta` 가 없다");
  }

  console.log(`${NL}[★ ② 켜면 다음 말 전에 같은 세션에 다시 붙는다]`);
  {
    const room = await mgr.openRoom(roomId);
    const bot = room.participants[0]!;
    await mgr.setPolicy(roomId, { browser: true }, bot.id);
    ok((await mgr.openRoom(roomId)).participants[0]!.browser === true, "켠 것이 봇에 적혔다");
    const before = (await events()).length;
    ok((await events()).length === before, "★ **켜는 순간에는 안 붙인다** — 답하는 중이면 그 턴이 끊긴다");
    await mgr.send(roomId, "열어봐");
    await settle(mgr, roomId);
    const now = (await events()).slice(before);
    const back = now.filter((e) => e.t === "resume-try");
    console.log(`   그 뒤: ${now.map((e) => e.t).join(" → ")}`);
    ok(back.length === 1 && hasChrome(back[0]!.meta), "★ 켠 채로 **다시 붙었다** (`chrome` 이 실렸다)");
    ok(back[0]!.sessionId === first, "★ **같은 세션**이다 — 대화가 안 끊긴다");
    ok(!now.some((e) => e.t === "new"), "★ 새 세션을 열지 않는다");

    const again = (await events()).length;
    await mgr.send(roomId, "또");
    await settle(mgr, roomId);
    ok(!(await events()).slice(again).some((e) => e.t === "resume-try"), "★ 한 번 붙었으면 다음 말에는 안 붙인다");
  }

  console.log(`${NL}[★ ③ 끄면 안 싣고 다시 붙는다]`);
  {
    const bot = (await mgr.openRoom(roomId)).participants[0]!;
    await mgr.setPolicy(roomId, { browser: false }, bot.id);
    ok((await mgr.openRoom(roomId)).participants[0]!.browser === undefined, "끈 것은 자국도 안 남는다");
    const before = (await events()).length;
    await mgr.send(roomId, "닫아");
    await settle(mgr, roomId);
    const back = (await events()).slice(before).filter((e) => e.t === "resume-try");
    ok(back.length === 1 && back[0]!.meta === null, "★ **안 싣고** 다시 붙었다 — 안 싣는 것이 끄는 것이다");
  }

  console.log(`${NL}[★ ④ 껐다 켜고 다시 붙을 때도 — 이어받기 길]`);
  {
    const bot = (await mgr.openRoom(roomId)).participants[0]!;
    await mgr.setPolicy(roomId, { browser: true }, bot.id);
    mgr.dispose();
    await nap(400);
    const mgr2 = open();
    const before = (await events()).length;
    await mgr2.openRoom(roomId);
    await mgr2.send(roomId, "다시 왔어");
    await settle(mgr2, roomId);
    const back = (await events()).slice(before).filter((e) => e.t === "resume-try");
    console.log(`   resume-try ${back.length}번`);
    ok(back.length >= 1 && back.every((e) => hasChrome(e.meta)), "★ 이어받을 때도 켠 채로 붙는다");
    ok(back.length === 1, "★ 이어받으며 이미 켰으니 **또 붙이지 않는다**");

    console.log(`${NL}[★ ⑥ 스크린샷은 blob 으로 남는다]`);
    await mgr2.send(roomId, "찍어 [[shot]]");
    await settle(mgr2, roomId);
    const room = await mgr2.openRoom(roomId);
    const reply = [...room.messages].reverse().find((m) => m.role === "agent" && m.tools?.length);
    const shot = reply?.tools?.find((t) => t.id.startsWith("shot"));
    console.log(`   알약: ${shot?.name} · 그림 ${shot?.images?.length ?? 0}장`);
    ok(shot?.images?.length === 1, "★ 그림이 하나 남았다 — 그림이 아닌 종류(text/html)는 버린다");
    ok(shot?.images?.[0]?.mimeType === "image/png", "종류도 같이 적는다");
    await nap(200);
    const blob = await store.getBlob(shot!.images![0]!.sha256);
    ok(blob !== null && blob.length > 60 && blob[1] === 0x50, "★ 원본이 blob 에 있다 (PNG)");
    await store.sweepBlobs();
    ok(await store.getBlob(shot!.images![0]!.sha256) !== null,
       "★ **blob 쓸기가 산 것으로 센다** — 안 세면 방 하나 지울 때 같이 사라진다");

    console.log(`${NL}[★ ⑦ 알약에 «Chrome» 이 붙는다]`);
    ok(shot?.name === "Chrome computer", `★ 사용자의 브라우저를 만졌다는 것이 보인다 («${shot?.name}»)`);
    mgr2.dispose();
  }

  await nap(400);

  console.log(`${NL}[★ ⑤ 켤 줄 모르는 에이전트는 켜도 아무것도 안 싣는다]`);
  {
    const mgr3 = open();
    // 방을 만들 때 세션이 이미 열린다 — 그 앞에서 센다
    const before = (await events()).length;
    const room = await mgr3.createRoom({ agentId: "plain", title: "모름" });
    await mgr3.setPolicy(room.id, { browser: true }, room.participants[0]!.id);
    await mgr3.send(room.id, "안녕");
    await settle(mgr3, room.id);
    const now = (await events()).slice(before);
    ok(now.some((e) => e.t === "new") && now.every((e) => !hasChrome(e.meta)),
       "★ 켠 표시가 있어도 그 에이전트에 길이 없으면 안 싣는다");
    ok(!now.some((e) => e.t === "resume-try"), "★ 그래서 다시 붙지도 않는다");
    mgr3.dispose();
  }

  await nap(400);

  console.log(`${NL}[★ ⑧ 말을 걸기 전에 켜면 — 다시 붙이지 않고 새로 연다]`);
  {
    /*
     * 🔴 실측(`chromereal` · 2026-11-19): 방을 만들고 바로 켜면 그 세션은 저쪽 디스크에
     * 아직 없어서(§13.1) 다시 붙기가 `Resource not found` 로 떨어졌고, 그 세션으로
     * 보낸 말은 답 없이 멈췄다. 잃을 것이 없으니 새로 연다.
     */
    const mgr4 = open();
    const room = await mgr4.createRoom({ agentId: "chromey", title: "바로 켬" });
    await mgr4.setPolicy(room.id, { browser: true }, room.participants[0]!.id);
    const before = (await events()).length;
    await mgr4.send(room.id, "열어봐");
    await settle(mgr4, room.id);
    const now = (await events()).slice(before);
    console.log(`   그 뒤: ${now.map((e) => e.t).join(" → ")}`);
    ok(mgr4.statusOf(room.id) === "idle", "★ 턴이 끝났다 — 멈추지 않는다");
    ok(!now.some((e) => e.t === "resume-try"), "★ 말 건 적 없는 세션에는 다시 붙지 않는다");
    const made = now.filter((e) => e.t === "new");
    ok(made.length === 1 && hasChrome(made[0]!.meta), "★ 켠 채로 **새로** 열었다");
    const after = await mgr4.openRoom(room.id);
    ok(!after.messages.some((m) => m.role === "system" && m.text.includes("새 세션")),
       "★ «새 세션입니다» 를 안 남긴다 — 잃은 맥락이 없다");
    mgr4.dispose();
  }

  console.log(`${NL}[★ 그림 꺼내기 — 종류와 크기를 묶는다]`);
  {
    const png = { type: "content" as const, content: { type: "image" as const, data: "AAAA", mimeType: "image/png" } };
    const html = { type: "content" as const, content: { type: "image" as const, data: "AAAA", mimeType: "image/svg+xml" } };
    const big = { type: "content" as const, content: { type: "image" as const, data: "A".repeat(8 * 1024 * 1024), mimeType: "image/jpeg" } };
    const text = { type: "content" as const, content: { type: "text" as const, text: "hi" } };
    ok(imagesOf([text, png]).length === 1, "글은 그림이 아니다");
    ok(imagesOf([html]).length === 0, "★ svg 는 안 받는다 — 스크립트가 든 그림이다");
    ok(imagesOf([big]).length === 0, "★ 너무 큰 것은 안 받는다");
    ok(imagesOf([png, png, png, png, png, png]).length === 4, "★ 한 활동에 넷까지");
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`${NL}브라우저 — 다 통과`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
