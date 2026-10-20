import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { createBotInstance, sendsContent, type Room, type RoomMeta } from "../src/core/types.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { orderRooms } from "../src/protocol.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

let asked: () => { outcome: "cancelled" } = () => ({ outcome: "cancelled" });
const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-policy-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => asked(),
    log: () => {}, defaultCwd: () => "/ws", hasWorkspace: () => true,
  };
  // **전역 권한 설정이 없다.** 권한은 에이전트 모드가 정한다.
  const mgr = new RoomManager({ host, store, agents: DEFAULT_AGENTS });
  const inner = mgr as unknown as {
    askApprover(id: string, req: unknown): Promise<unknown>;
    recordActivity(room: unknown, reply: unknown, ev: unknown): void;
    rooms: { open: Map<string, Room> };
  };

  console.log("\n[권한은 에이전트 모드다 — 우리 사다리가 없다]");
  {
    const plain = createBotInstance(DEFAULT_AGENTS[0]!);
    ok(plain.agentMode === undefined, "안 고르면 비워둔다 — 에이전트 기본값을 쓴다");
    ok(plain.answerPolicy === "ask", "자리 비움은 우리 것이라 기본값이 있다");
    ok(plain.approver.kind === "user", "대상 기본은 사용자");

    const picked = createBotInstance(DEFAULT_AGENTS[0]!, { agentMode: "acceptEdits" });
    ok(picked.agentMode === "acceptEdits", "**에이전트가 준 값 그대로 담는다**");

    const codex = createBotInstance(DEFAULT_AGENTS[1]!, { agentMode: "read-only" });
    ok(codex.agentMode === "read-only", "에이전트마다 값이 달라도 그대로");
  }

  console.log("\n[방을 만들 때 고른 모드가 봇에 박힌다]");
  {
    const fake = { ...DEFAULT_AGENTS[0]!, id: "fake", command: "cmd", args: ["/c", "exit", "1"] };
    const m2 = new RoomManager({ host, store, agents: [fake] });
    m2.on("roomError", () => {});
    const room = await m2.createRoom({ agentId: "fake", title: "엄격한 방", agentMode: "default" });
    ok(room.participants[0]!.agentMode === "default", "고른 값이 담긴다");

    const plain = await m2.createRoom({ agentId: "fake", title: "기본 방" });
    ok(plain.participants[0]!.agentMode === undefined, "안 고르면 비어 있다");
    m2.dispose();
  }

  /*
   * ★ **이제 «질문 정책»이 아니라 «사용자가 자리에 있나»다** (2026-09-21).
   *
   * `elicitation` 채널을 없앴으므로(ROADMAP §D4) 이 값이 읽히는 곳은
   * 한 군데뿐이다 — `buildPrompt` 가 `auto` 면 «묻지 말고 진행하라»를 붙인다.
   * 그래서 세션으로 읽던 `answerPolicyForSession` 도 같이 없앴고,
   * 여기서는 **봇에서 직접** 읽는다.
   */
  console.log("\n[자리 비움 — 1:1은 지목 없이, 단체방은 지목해야]");
  {
    const solo = createBotInstance(DEFAULT_AGENTS[0]!);
    solo.sessionId = "s-solo";
    const room: Room = {
      id: "solo", title: "1대1", participants: [solo],
      cwd: "/ws", messages: [], unread: 0, createdAt: 1, lastActivityAt: 1,
    };
    await store.createRoom(room);
    inner.rooms.open.set(room.id, room);

    ok(solo.answerPolicy === "ask", "기본은 물어봄");
    await mgr.setPolicy(room.id, { answerPolicy: "auto" });
    ok(solo.answerPolicy === "auto", "botId 없이 바로 바뀐다");

    const a = createBotInstance(DEFAULT_AGENTS[0]!);
    const b = createBotInstance(DEFAULT_AGENTS[1]!);
    a.sessionId = "s-a";
    b.sessionId = "s-b";
    const group: Room = {
      id: "group", title: "단체방", participants: [a, b],
      cwd: "/ws", messages: [], unread: 0, createdAt: 1, lastActivityAt: 1,
    };
    await store.createRoom(group);
    inner.rooms.open.set(group.id, group);

    await mgr.setPolicy(group.id, { answerPolicy: "auto" }, b.id);
    ok(b.answerPolicy === "auto", "**지목한 봇만 바뀐다**");
    ok(a.answerPolicy === "ask", "나머지는 그대로");

    await mgr.setPolicy(group.id, { answerPolicy: "auto" });
    ok(a.answerPolicy === "ask", "지목 안 하면 아무도 안 바뀐다");
  }

  console.log("\n[대상 — 봇 : 모드 : 대상]");
  {
    const bot = createBotInstance(DEFAULT_AGENTS[0]!, {
      agentMode: "default",
      approver: { kind: "bot", botId: "b-reviewer" },
    });
    ok(bot.approver.kind === "bot", "다른 봇을 지정할 수 있다");
    ok(bot.agentMode === "default", "모드와 대상은 따로 논다");

    bot.sessionId = "s-deleg";
    const room: Room = {
      id: "deleg", title: "위임", participants: [bot],
      cwd: "/ws", messages: [], unread: 0, createdAt: 1, lastActivityAt: 1,
    };
    await store.createRoom(room);
    inner.rooms.open.set(room.id, room);

    const notices: string[] = [];
    mgr.on("notice", (_id, m) => notices.push(m));
    let askedUser = false;
    asked = () => { askedUser = true; return { outcome: "cancelled" as const }; };

    await inner.askApprover("s-deleg", { title: "파일 수정", readOnly: false, options: [] });
    // 맡긴 봇(`b-reviewer`)이 이 방에 없다 — 내보냈거나 애초에 없던 id다
    ok(askedUser, "★ 맡길 상대가 방에 없으면 **사용자에게** 간다");
    ok(notices.some((n) => n.includes("방에 없어")),
       `**맡긴 줄 알고 자리를 비우지 않도록 알린다** (${notices.join(" | ")})`);
    // 봇이 실제로 심사하는 길은 judgeflow.mts 가 잰다
  }

  console.log("\n[같은 도구 호출은 합친다 — 상태만 바뀌며 여러 번 온다 (C3)]");
  {
    const reply = { id: "a1", role: "agent", text: "", deliveredTo: [], createdAt: 1 } as never;
    // **막힌 수정**을 보려면 방을 알아야 한다 (§4.3) — 여기서는 봇이 없는 빈 방
    const roomStub = { id: "r1", participants: [] } as never;
    const rec = (ev: unknown) => inner.recordActivity(roomStub, reply, ev);

    rec({ type: "tool", toolCallId: "t1", title: "Bash", kind: "execute", status: "pending",
          paths: [], command: "npm test" });
    rec({ type: "tool", toolCallId: "t1", title: "", status: "in_progress", paths: [] });
    rec({ type: "tool", toolCallId: "t1", title: "", status: "completed", paths: [] });

    const tools = (reply as { tools: Array<{ id: string; title: string; kind?: string; status: string }> }).tools;
    ok(tools.length === 1, `세 번 와도 하나 (${tools.length})`);
    ok(tools[0]!.status === "completed", "상태는 마지막 것");
    ok(tools[0]!.title === "Bash", "**제목은 처음 것을 지킨다** — 갱신은 제목을 안 준다");
    ok((tools[0] as { command?: string }).command === "npm test",
       "**명령도 첫 이벤트에만 온다** — 갱신에 없다고 잃으면 안 된다");
    ok(tools[0]!.kind === "execute", "종류도 지킨다");

    rec({ type: "tool", toolCallId: "t2", title: "Read(a.ts)", kind: "read", status: "completed", paths: ["/ws/a.ts"] });
    ok(tools.length === 2 && tools.map((t) => t.id).join() === "t1,t2", "다른 id는 따로, 순서 유지");

    // **글의 어디쯤이었나** — 이게 있어야 말 사이사이에 놓을 수 있다
    const placed = reply as unknown as { text: string; tools: Array<{ textAt?: number }> };
    ok(placed.tools[0]!.textAt === 0, "첫 활동은 글이 없던 시점");
    placed.text = "여기까지 말했다";
    rec({ type: "tool", toolCallId: "t3", title: "Bash", kind: "execute", status: "completed", paths: [] });
    ok(placed.tools[2]!.textAt === "여기까지 말했다".length,
       "**나중 활동은 그 시점의 글 길이를 적는다**");
  }

  console.log("\n[자동 승인돼도 무슨 명령이 돌았는지 남는다]");
  {
    // 에이전트 모드가 알아서 승인하면 권한 요청 자체가 안 온다. 활동은 남아야 한다.
    const reply = { id: "a2", role: "agent", text: "", deliveredTo: [], createdAt: 1 } as never;
    inner.recordActivity({ id: "r1", participants: [] } as never, reply, {
      type: "tool", toolCallId: "x", title: "Bash(rm -rf build)", kind: "execute",
      status: "completed", paths: [],
    });
    const tools = (reply as { tools: Array<{ title: string }> }).tools;
    ok(tools[0]!.title === "Bash(rm -rf build)", "**명령이 트랜스크립트에 남는다**");
  }

  console.log("\n[저장되고, 다시 불러와도 남는다]");
  {
    const revived = new RoomStore(dir); await revived.init();
    const back = (await revived.loadRoom("deleg"))!;
    const bot = back.participants[0]!;
    ok(bot.agentMode === "default", "모드가 디스크에 남는다");
    ok(bot.approver.kind === "bot", "대상도");
  }

  // ── 목록 순서 (B10·B11) ───────────────────────────────────────────────

  const meta = (id: string, cwd: string, at: number): RoomMeta => ({
    id, title: id, kind: "direct", cwd, agentIds: ["claude"],
    unread: 0, createdAt: 1, lastActivityAt: at,
  });

  console.log("\n[blob은 «무엇을 보냈나»의 기록이다 (I4)]");
  {
    const cwd = "/ws";
    const inside = { mimeType: "text/plain", path: "/ws/src/a.ts" };
    const outside = { mimeType: "text/plain", path: "/other/b.log" };
    const pasted = { mimeType: "text/plain" };
    const imgInside = { mimeType: "image/png", path: "/ws/shot.png" };

    ok(!sendsContent(inside, cwd), "**워크스페이스 안 파일은 경로로 간다** — 담아둘 내용이 없다");
    ok(sendsContent(outside, cwd), "밖의 파일은 내용으로");
    ok(sendsContent(pasted, cwd), "붙여넣은 것도 내용으로");
    ok(sendsContent(imgInside, cwd), "**이미지는 안에 있어도 내용으로** — 경로로는 못 본다");
    ok(sendsContent({ mimeType: "audio/mp3", path: "/ws/a.mp3" }, cwd), "오디오도");

    // 경계
    ok(sendsContent({ mimeType: "text/plain", path: "/wsx/a.ts" }, cwd),
       "경로가 비슷해도 다른 폴더면 내용으로");
    ok(sendsContent({ mimeType: "text/plain" }, ""), "cwd를 모르면 내용으로 (안전한 쪽)");
  }

  console.log("\n[목록 순서 — 현재 워크스페이스가 위, 그 안에서 최근순]");
  {
    const rooms = [
      meta("남-오래", "/other", 10),
      meta("여기-오래", "/ws", 20),
      meta("남-최근", "/other", 90),
      meta("여기-최근", "/ws", 80),
    ];
    const got = orderRooms(rooms, "/ws").map((m) => m.id);
    ok(got.join(" ") === "여기-최근 여기-오래 남-최근 남-오래", "순서: " + got.join(" "));
  }

  console.log("\n[입력 순서가 달라도 결과가 같다 — 안정 정렬에 기대지 않는다]");
  {
    const base = [meta("a", "/ws", 5), meta("b", "/ws", 9), meta("c", "/other", 7)];
    const one = orderRooms(base, "/ws").map((m) => m.id).join(" ");
    const two = orderRooms([...base].reverse(), "/ws").map((m) => m.id).join(" ");
    ok(one === two, `뒤집어 넣어도 같다 (${one})`);
    orderRooms(base, "/ws");
    ok(base[0]!.id === "a", "원본을 건드리지 않는다");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true });
  console.log("\n전부 통과\n");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
