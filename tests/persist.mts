/**
 * **저장돼야 할 것이 실제로 저장되는가.**
 *
 * `saveProps(room, patch)`는 **patch에 적힌 것만** 쓴다. 그래서 필드를 새로
 * 추가할 때 «어느 patch에 넣어야 하나»를 빠뜨리기 쉽고, 빠뜨리면 **화면에서는
 * 멀쩡히 보이다가 껐다 켜면 사라진다** — 디스크를 거치지 않는 테스트로는 절대
 * 안 잡힌다.
 *
 * 그래서 여기서는 **공개 API로 바꾸고 → 디스크에서 새로 읽어** 비교한다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { Message, Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-persist-"));
  const store = new RoomStore(dir); await store.init();
  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")], env: {},
  };
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
  mgr.on("roomError", () => {});

  /** 디스크에서 **새로** 읽는다 — 메모리 캐시를 절대 안 거친다 */
  const fromDisk = async (id: string): Promise<Room> => {
    const fresh = new RoomStore(dir); await fresh.init();
    const r = await fresh.loadRoom(id);
    if (!r) throw new Error("방이 디스크에 없다");
    return r;
  };

  const room = await mgr.createRoom({
    agentId: "fake", title: "점검", rolePrompt: "너는 리뷰어다",
  });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  console.log("\n[방 만들 때 정한 것]");
  {
    const d = await fromDisk(room.id);
    ok(d.title === "점검", "제목");
    ok(d.cwd === dir, "작업 디렉터리");
    ok(d.participants[0]!.rolePrompt === "너는 리뷰어다", "역할 (B3)");
    ok(d.participants[0]!.sessionId !== null, "**세션 id** — 이게 없으면 복구가 안 된다 (F7)");
    ok(d.participants[0]!.sessionPrompted !== true,
       "아직 안 써본 세션이라고 적힌다 — 유령이 진짜를 밀어내지 않게");
    ok(d.participants[0]!.modelLabel === "Opus 5", "모델 표시 이름 (B5)");
    ok(d.createdAt > 0 && d.lastActivityAt > 0, "만든 때 · 마지막 활동");
  }

  console.log("\n[대화 중에 바꾸는 것]");
  {
    await mgr.renameRoom(room.id, "이름 바꿈");
    await mgr.setRole(room.id, "이번엔 구현자다");
    await mgr.setConfig(room.id, "mode", "plan");
    await mgr.setConfig(room.id, "model", "sonnet");
    await mgr.setPolicy(room.id, { answerPolicy: "auto", approver: { kind: "bot", botId: "b2" } });
    await settle();

    const d = await fromDisk(room.id);
    ok(d.title === "이름 바꿈", "바꾼 제목 (B4)");
    ok(d.participants[0]!.rolePrompt === "이번엔 구현자다", "바꾼 역할");
    ok(d.participants[0]!.agentMode === "plan", "**권한 모드** (D2)");
    ok(d.participants[0]!.modelLabel === "Sonnet 5", "바꾼 모델 이름");
    ok(d.participants[0]!.model === "sonnet", "**모델 id도** — 되살리려면 이게 필요하다");
    ok(d.participants[0]!.configValues?.["mode"] === "plan",
       "**설정값 전부** — 개별 필드를 안 만든 것도 담긴다 (사고 강도·Fast mode…)");
    ok(d.participants[0]!.answerPolicy === "auto", "질문 정책 (D5)");
    ok(d.participants[0]!.approver.kind === "bot", "승인 주체 (D2)");
  }

  console.log("\n[쓰다 만 것 · 읽은 지점]");
  {
    mgr.setDraft(room.id, "쓰다 말았다");
    await mgr.flushDraft();
    ok((await fromDisk(room.id)).draft === "쓰다 말았다",
       "**초안** — 활성 방이 아니어도 쓴 방에 저장된다 (B7)");

    const inner = mgr as unknown as { open: Map<string, Room>; markRead(r: Room): void };
    const live = inner.open.get(room.id)!;
    live.messages.push(
      { id: "m1", role: "user", text: "하나", deliveredTo: [], createdAt: 1 },
      { id: "m2", role: "agent", text: "둘", deliveredTo: [], createdAt: 2 },
    );
    await store.appendMessage(live, live.messages[live.messages.length - 2]!);
    await store.appendMessage(live, live.messages[live.messages.length - 1]!);
    live.unread = 2;
    inner.markRead(live);
    await settle();

    const d = await fromDisk(room.id);
    ok(d.unread === 0, "미읽음 수 (B8)");
    ok(d.lastReadMessageId === "m2", "**어디까지 읽었나** — 구분선 자리 (B8)");
  }

  console.log("\n[메시지에 딸린 것들]");
  {
    const inner = mgr as unknown as { open: Map<string, Room> };
    const live = inner.open.get(room.id)!;
    const rich: Message = {
      id: "m3", role: "agent", text: "했습니다", deliveredTo: ["b1"], createdAt: 3,
      replyToIds: ["m1"],
      tools: [{ id: "t1", title: "Bash(npm test)", kind: "execute", status: "completed" }],
      files: [{ path: "/ws/a.ts", kind: "edit", added: 2, removed: 1 }],
      attachments: [{ sha256: "a".repeat(64), mimeType: "image/png", name: "s.png", byteSize: 9 }],
      thought: "생각했다",
      plan: { entries: [{ text: "하나", status: "pending" }] },
    };
    live.messages.push(rich);
    await store.appendMessage(live, rich);

    const cut: Message = {
      id: "m4", role: "system", text: "여기까지 압축됨", deliveredTo: [], createdAt: 4,
      mark: "compaction", summary: "앞을 요약했다",
    };
    live.messages.push(cut);
    await store.appendMessage(live, cut);
    await settle();

    const d = await fromDisk(room.id);
    const m3 = d.messages.find((m) => m.id === "m3")!;
    ok(m3.tools?.[0]?.title === "Bash(npm test)", "활동 기록 (C3)");
    ok(m3.files?.[0]?.path === "/ws/a.ts", "파일 변경 카드 (E2)");
    ok(m3.attachments?.[0]?.sha256.startsWith("aaaa") === true, "첨부 참조 (I1)");
    ok(m3.thought === "생각했다", "사고 과정");
    ok(m3.plan?.entries?.[0]?.text === "하나", "**계획** — 계획 모드의 알맹이");
    ok(m3.replyToIds?.[0] === "m1", "무엇에 답했나");

    const m4 = d.messages.find((m) => m.id === "m4")!;
    ok(m4.mark === "compaction", "압축 경계 표시 (C11)");
    ok(m4.summary === "앞을 요약했다", "**에이전트가 준 요약** — 되먹임의 재료다 (F7)");
  }

  console.log("\n[끊긴 맥락 — 고르기 전에 창을 닫아도 약속이 남아야 한다]");
  {
    const inner = mgr as unknown as { open: Map<string, Room> };
    inner.open.get(room.id)!.contextLost = true;
    await mgr.decideRefeed(room.id, true);
    await settle();
    const d = await fromDisk(room.id);
    // 이제 방 값은 봇들에서 **굴려 올린 요약**이라 «없음»으로 꺼진다
    ok(!d.contextLost, "물어봤다는 사실이 꺼진다");
    ok(d.refeedPending === true, "**되먹이기로 한 약속** (F7)");
  }

  console.log("\n[사용량 — 컨텍스트가 얼마나 찼었나]");
  {
    const inner = mgr as unknown as {
      open: Map<string, Room>;
      applyUsage(r: Room, u: unknown): void;
      saveProps(r: Room, p: unknown): Promise<void>;
    };
    const live = inner.open.get(room.id)!;
    live.usage = { contextUsed: 70, contextSize: 100, totalTokens: 1234 };
    await inner.saveProps(live, { usage: live.usage });
    ok((await fromDisk(room.id)).usage?.contextUsed === 70,
       "**되먹임 경고의 근거** — 측정값이라 지어낼 수 없다 (F7)");
  }

  console.log("\n[에이전트별 마지막 모델 — 다음 방의 기본값 (F6)]");
  {
    const fresh = new RoomStore(dir); await fresh.init();
    ok(fresh.getAppState().lastModelByAgent?.["fake"] === "sonnet",
       "앱 상태로 따로 남는다");
  }

  console.log("\n[방을 나가면 흔적이 없다 (B6)]");
  {
    const gone = await mgr.createRoom({ agentId: "fake", title: "버릴 방" });
    await mgr.leaveRoom(gone.id);
    const fresh = new RoomStore(dir); await fresh.init();
    ok((await fresh.loadRoom(gone.id)) === null, "방 파일이 없다");
    ok(!fresh.listMetas().some((m) => m.id === gone.id), "목록에도 없다");
  }

  mgr.dispose();
  await settle();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log("\n전부 통과\n");
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
