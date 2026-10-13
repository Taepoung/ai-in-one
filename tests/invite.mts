/**
 * **봇 초대 · 내보내기 · 전원 분기** (v2.0).
 *
 * 초대는 «1:1 방을 단체방으로 올리는» 길이기도 하다. 그래서 제일 조심할 것은
 * 하나다 — **새 봇은 위 대화를 모른다**(§4.1.1). 화면에는 지난 대화가 그대로
 * 보이니 말해주지 않으면 *"보이니까 알겠지"* 로 믿고 말을 건다.
 *
 * 분기는 반대다. 한 봇만 갈라내면 새 방이 **나머지 봇을 잃은 채** 시작하는데,
 * 그건 분기가 아니라 이사다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { ComposeToken } from "../src/core/mentions.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make(env: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-inv-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    askUser: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: path.join(dir, "s.jsonl"), ...env },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{ ...base, id: "alpha", label: "알파" }, { ...base, id: "beta", label: "베타" }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 600; i++) {
      const s = mgr.statusOf(id);
      if (s === "idle" || s === "error") return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { dir, store, mgr, settle };
}
const at = (botId: string): ComposeToken => ({ kind: "mention", botId });
const txt = (text: string): ComposeToken => ({ kind: "text", text });
const notes = (r: { messages: Array<{ role: string; text: string }> }) =>
  r.messages.filter((m) => m.role === "system").map((m) => m.text);

async function sweep(dir: string) {
  for (let n = 0; n < 5; n++) {
    try { await fs.rm(dir, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 1:1 방에 봇을 초대하면 단체방이 된다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "승격" });
    await mgr.send(room.id, "우리끼리 한 얘기");
    await settle(room.id);

    const added = await mgr.addBot(room.id, { agentId: "beta" });
    ok(room.participants.length === 2, "★ 봇이 둘이 됐다 — 방을 새로 만들지 않고");
    ok(added.sessionId !== null, "★ 초대하는 자리에서 세션도 연다 — 첫 멘션까지 미루지 않는다");
    ok(room.participants[0]!.sessionId !== added.sessionId, "세션은 서로 다르다");

    const said = notes(room);
    ok(said.some((t) => t.includes("위 대화를 모릅니다")),
       `★ **새 봇은 지난 대화를 모른다고 적는다** — 화면에는 다 보이니까 (${said.find((t) => t.includes("모릅니다"))?.slice(0, 40)}…)`);
    ok(said.some((t) => t.includes("기억은 나뉘지 않습니다")),
       "★ 봇이 둘이 되는 **그 순간** 기억 공유도 함께 말한다 (§4.2.3)");
    mgr.dispose();
  }

  console.log(`${NL}[초대된 봇은 지목해야 받는다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "지목" });
    const a = room.participants[0]!;
    const b = await mgr.addBot(room.id, { agentId: "beta", rolePrompt: "너는 리뷰어" });

    ok(b.rolePrompt === "너는 리뷰어", "역할도 초대할 때 준다");
    await mgr.sendCompose(room.id, [at(b.id), txt(`${NL}너만 해줘`)]);
    await settle(room.id);

    const mine = room.messages.filter((m) => m.role === "user");
    ok(mine.length === 1 && mine[0]!.deliveredTo.join() === b.id,
       "★ 지목한 봇에게만 — 초대했다고 전부에게 가지 않는다");
    ok(a.sessionPrompted !== true, "알파에게는 아무것도 안 갔다");
    mgr.dispose();
  }

  console.log(`${NL}[이름은 초대할 때도 비켜간다]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "이름" });
    const b = await mgr.addBot(room.id, { agentId: "alpha" });
    const c = await mgr.addBot(room.id, { agentId: "alpha" });
    ok(b.name === "알파 2" && c.name === "알파 3",
       `★ 멘션 이름이 겹치면 누구에게 가는지 우리가 정할 수 없다 (${b.name} · ${c.name})`);
    ok(new Set(room.participants.map((x) => x.id)).size === 3, "id도 안 겹친다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 내보내도 대화는 남는다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "내보내기", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.sendCompose(room.id, [at(b!.id), txt(`${NL}뭔가 해줘`)]);
    await settle(room.id);
    const before = room.messages.filter((m) => m.role !== "system").length;

    await mgr.removeBot(room.id, b!.id);
    ok(room.participants.length === 1 && room.participants[0]!.id === a!.id, "★ 그 봇만 빠진다");
    ok(room.messages.filter((m) => m.role !== "system").length === before,
       "★ **말풍선은 하나도 안 지운다** — 세션은 그쪽 것이고 기록은 우리 것이다");
    ok(notes(room).some((t) => t.includes("내보냈습니다")), "무슨 일이 있었는지 남는다");
    mgr.dispose();
  }

  console.log(`${NL}[마지막 한 명은 못 내보낸다]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({ agentId: "alpha", title: "마지막" });
    let why = "";
    try { await mgr.removeBot(room.id, room.participants[0]!.id); }
    catch (e) { why = (e as Error).message; }
    ok(why.includes("마지막 봇"), `★ 봇이 없는 방은 말을 걸 수가 없다 (${why})`);
    ok(room.participants.length === 1, "그대로 있다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 단체방을 분기하면 전원이 갈라진다]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "전원 분기", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    const [a, b] = room.participants;
    await mgr.sendCompose(room.id, [at(a!.id), txt(" "), at(b!.id), txt(`${NL}둘 다 기억해`)]);
    await settle(room.id);

    const child = await mgr.forkRoom(room.id, { title: "갈래" });
    ok(child.participants.length === 2, "★ 봇 둘이 그대로 따라왔다 — 하나만 가면 분기가 아니라 이사다");
    ok(child.participants.every((p) => p.sessionId !== null), "둘 다 세션이 붙었다");

    const parentIds = new Set([a!.sessionId, b!.sessionId]);
    ok(child.participants.every((p) => !parentIds.has(p.sessionId)),
       "★ **원본과 다른 세션**이다 — 같은 세션을 가리키면 한쪽 말이 다른 쪽에 샌다");
    ok(new Set(child.participants.map((p) => p.id)).size === 2, "봇 id도 새것이고 안 겹친다");
    ok(child.participants.map((p) => p.name).join() === [a!.name, b!.name].join(),
       "이름은 그대로 물려받는다 — 멘션이 그대로 통해야 한다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 섞여도 잔치를 이름으로 짚는다]`);
  {
    // 베타만 분기를 못 하는 에이전트로 만든다
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-inv-"));
    dirs.push(dir);
    const store = new RoomStore(dir); await store.init();
    const host: WorkspaceHost = {
      readTextFile: async () => "", writeTextFile: async () => {},
      requestPermission: async () => ({ outcome: "cancelled" }),
      askUser: async () => ({ outcome: "cancelled" }),
      log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
    };
    const base = {
      ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    };
    const mgr = new RoomManager({
      host, store, configProbeMs: 20000,
      agents: [
        { ...base, id: "alpha", label: "알파", env: { AIO_FAKE_STATE: path.join(dir, "a.jsonl") } },
        { ...base, id: "beta", label: "베타",
          env: { AIO_FAKE_STATE: path.join(dir, "b.jsonl"), AIO_FAKE_NO_FORK: "1" } },
      ],
    });
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});
    const room = await mgr.createRoom({
      title: "섞임", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    await mgr.sendCompose(room.id, [{ kind: "mention", botId: room.participants[0]!.id },
                                    txt(`${NL}한 마디`)]);
    for (let i = 0; i < 600; i++) {
      if (["idle", "error"].includes(mgr.statusOf(room.id))) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const child = await mgr.forkRoom(room.id, { title: "섞인 갈래" });
    const note = child.messages.find((m) => m.role === "system" && m.mark === "error")!;
    ok(note !== undefined, "잃은 것이 있으면 붉게 남는다");
    ok(note.text.includes("베타"),
       `★ **누가 잃었는지 이름으로** — «일부는 잃었습니다»만으로는 누구에게 다시 설명할지 모른다 (${note.text.slice(0, 50)}…)`);
    ok(!note.text.includes("알파"), "★ 멀쩡한 봇은 안 적는다");
    ok(child.refeedPending === true, "한 봇이라도 잃었으면 되먹임을 예약한다");
    mgr.dispose();
  }

  for (const d of dirs) await sweep(d);
  console.log(`${NL}[★ 내보내도 **이름은 남는다**]`);
  {
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "이름", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const [, b] = room.participants;
    await mgr.removeBot(room.id, b!.id);

    ok(room.participants.length === 1, "참여자에서는 빠진다");
    ok(room.left?.length === 1 && room.left[0]!.name === "리뷰어",
       `★ **이름은 남는다** (${room.left?.[0]?.name}) — 지난 말풍선이 익명이 되면 «누구한테 시킨 거였지»에 답할 수 없다`);
    ok(room.left?.[0]!.id === b!.id, "★ id 도 남는다 — 멘션 칩이 그걸로 찾는다");
    mgr.dispose();

    // 껐다 켜도 남아야 한다 — 기록은 우리 것이다 (§0)
    const s2 = new RoomStore(dir); await s2.init();
    const again = await s2.loadRoom(room.id);
    ok(again?.left?.[0]?.name === "리뷰어",
       "★ **디스크에도 남는다** — 다시 열었을 때 익명이 되면 뜻이 없다");
  }

  console.log(`${NL}[★ 분기하면 **심사자 지목도 새 id 로** 옮겨간다]`);
  {
    /*
     * 🔴 봇은 전부 **새 것**인데 `structuredClone` 은 `approver.botId` 까지
     * 그대로 베낀다 — 가리키는 곳이 **부모 방의 봇**이라 분기한 방에서는
     * 심사가 통째로 안 듣는다. 그리고 조용히 사용자에게 되돌아온다.
     */
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "분기 심사", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const [a, b] = room.participants;
    await mgr.setPolicy(room.id, { approver: { kind: "bot", botId: b!.id } }, a!.id);
    await mgr.sendCompose(room.id, [at(a!.id), txt(" "), at(b!.id), txt(`${NL}둘 다 기억해`)]);
    await settle(room.id);

    const child = await mgr.forkRoom(room.id, { title: "갈래" });
    const kid = child.participants.find((p) => p.name === "구현")!;
    const judge = child.participants.find((p) => p.name === "리뷰어")!;
    ok(kid.approver.kind === "bot" && kid.approver.botId === judge.id,
       "★ **새 방의 리뷰어를 가리킨다** — 부모 방 id 를 들고 가면 조용히 안 듣는다");
    ok(kid.approver.kind === "bot" && kid.approver.botId !== b!.id, "★ 베낀 id 가 아니다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 내보내면 그 봇에게 맡긴 **심사도 풀린다**]`);
  {
    /*
     * 🔴 안 풀어도 **안전하기는 하다** — `askBotApprover` 가 «심사를 맡긴 봇이
     * 방에 없어» 로 사용자에게 되돌린다. 그런데 설정 화면은 여전히 **나간
     * 봇을 가리키고**, 매 요청마다 같은 알림이 한 줄씩 쌓인다. 고칠 데를
     * 아는 쪽이 고친다 — 사용자가 짐작할 일이 아니다.
     */
    const { dir, mgr } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "심사", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    const [a, b] = room.participants;
    await mgr.setPolicy(room.id, { approver: { kind: "bot", botId: b!.id } }, a!.id);
    if (a!.approver.kind !== "bot") throw new Error("FAIL: 전제가 안 섰다 — 심사를 못 맡겼다");

    await mgr.removeBot(room.id, b!.id);
    ok(a!.approver.kind === "user",
       `★ **사용자로 되돌아온다** (${a!.approver.kind}) — 안 그러면 고친 적 없는 설정이 조용히 안 듣는다`);
    ok(notes(room).some((t) => t.includes("승인 주체")),
       "★ 그리고 **우리가 고쳤다고 말한다** — 사용자가 안 건드린 칸이 바뀌었다");
    mgr.dispose();
  }

  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
