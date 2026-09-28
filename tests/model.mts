/**
 * **방을 만들며 고른 모델이 끝까지 가는가.**
 *
 * 진짜 CLI 없이 ACP를 말하는 가짜 에이전트(`fakeagent.cjs`)를 띄워 세션까지
 * 실제로 돌린다 — 여태 이 경로에는 테스트가 없었다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { Room, Message } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));

/** 창을 껐다 켠 것처럼 **그 방 봇들의 세션 연결만** 떼어낸다 (B1) */
type Inner = {
  runtimes: Map<string, { bots: Map<string, { sessionId?: string }> }>;
  roomConfigs: Map<string, unknown>;
};
function unbind(inner: Inner, room: Room): void {
  for (const b of room.participants) {
    const bt = inner.runtimes.get(room.id)?.bots.get(b.id);
    if (bt) delete bt.sessionId;
    inner.roomConfigs.delete(`${room.id}:${b.id}`);
  }
}

const current = (opts: Array<{ id: string; category?: string; currentValue?: unknown }>, cat: string) =>
  opts.find((o) => o.category === cat)?.currentValue;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-model-"));
  const state = path.join(dir, "fake.jsonl");
  const store = new RoomStore(dir); await store.init();

  const agent = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
  };
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    askUser: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir,
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
  mgr.on("roomError", () => {});

  console.log("\n[만들 때 고른 모델이 세션에 적용된다]");
  const room = await mgr.createRoom({
    agentId: "fake", title: "소넷 방",
    configValues: { model: "sonnet" },
  });
  const sent = (await fs.readFile(state, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  ok(sent.some((e) => e.t === "set" && e.configId === "model" && e.value === "sonnet"),
     "**에이전트에게 실제로 보냈다**");

  console.log("\n[«⋮»가 읽는 값이 그 방의 값이다]");
  {
    const opts = await mgr.roomConfigOptions(room.id);
    ok(current(opts, "model") === "sonnet",
       `**고른 모델이 잡혀 있다** (${String(current(opts, "model"))})`);
  }

  console.log("\n[목록에도 보이는 이름으로]");
  {
    const meta = mgr.listMetas().find((m) => m.id === room.id)!;
    ok(meta.models?.[0] === "Sonnet 5", `id가 아니라 이름 (${String(meta.models?.[0])})`);
  }

  console.log("\n[다른 방을 만들어도 서로 안 섞인다]");
  {
    const other = await mgr.createRoom({ agentId: "fake", title: "기본 방" });
    ok(current(await mgr.roomConfigOptions(other.id), "model") === "opus", "새 방은 기본값");
    ok(current(await mgr.roomConfigOptions(room.id), "model") === "sonnet",
       "**앞 방은 그대로** — 캐시가 하나였을 때는 여기서 섞였다");

    await mgr.setConfig(other.id, "mode", "plan");
    ok(current(await mgr.roomConfigOptions(other.id), "mode") === "plan", "바꾼 방은 계획 모드");
    ok(current(await mgr.roomConfigOptions(room.id), "mode") === "default",
       "**다른 방 권한 모드가 흘러들지 않는다**");
  }

  console.log("\n[다시 붙을 때도 세션이 들고 있는 값을 쓴다]");
  {
    // 방을 떠났다 돌아오면 런타임에는 세션이 없다. 복구하면서
    // `session/resume` 응답의 configOptions를 써야 모델이 그대로 남는다.
    // 세션은 **봇 런타임**에 있다 (B1)
    const inner = mgr as unknown as {
      runtimes: Map<string, { bots: Map<string, { sessionId?: string }> }>;
      roomConfigs: Map<string, unknown>;
    };
    const botId = room.participants[0]!.id;
    delete inner.runtimes.get(room.id)!.bots.get(botId)!.sessionId;
    inner.roomConfigs.delete(`${room.id}:${botId}`);

    const opts = await mgr.roomConfigOptions(room.id);
    ok(current(opts, "model") === "sonnet",
       `**복구 응답에서 모델을 되찾는다** (${String(current(opts, "model"))})`);
    const log = (await fs.readFile(state, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    /*
     * 🔴 **여기서 «resume 했나»를 물으면 안 된다.**
     *
     * 이 방은 아직 **아무 말도 안 걸었다.** 에이전트는 성공한 첫 프롬프트를
     * 받아야 세션을 디스크에 남기므로(§13.1), 말 안 건 세션은 되살릴 것이
     * 처음부터 없다 — 새로 여는 게 **맞는 동작**이다.
     *
     * 예전엔 가짜 에이전트가 그걸 흉내내지 않아 resume이 그냥 됐고, 그래서
     * 이 줄이 통과했다. **현실에서는 절대 안 통과할 기대였다.**
     *
     * 지켜야 할 것은 «같은 세션»이 아니라 **«고른 모델이 살아남는가»** 다.
     */
    ok(log.some((e) => e.t === "set" && e.configId === "model" && e.value === "sonnet"),
       "★ 새 세션이어도 **고른 모델을 다시 넣어준다**");
  }

  console.log("\n[창을 껐다 켜도 이 방의 값을 되찾는다]");
  {
    // **`mgr`를 여기서 닫지 않는다.** 아래 블록들이 계속 쓰기 때문에, 닫으면
    // 그 뒤로 쓸 때마다 연결이 새로 생기고 **아무도 안 닫는다**.
    const revived = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    revived.on("roomError", () => {});
    // 가짜 에이전트는 새 프로세스라 예전 세션을 모른다 → 새 세션이 열린다.
    // 되찾는 건 «이 방의 세션이 지금 뭘 들고 있나»이고, 그건 언제나 세션에서 온다.
    const opts = await revived.roomConfigOptions(room.id);
    ok(Array.isArray(opts) && opts.length > 0, "다시 붙어서 값을 가져온다");
    revived.dispose();
  }

  console.log("\n[고른 권한 모드는 세션이 바뀌어도 되살아난다 (D2)]");
  {
    const r9 = await mgr.createRoom({ agentId: "fake", title: "모드 유지" });
    await mgr.setConfig(r9.id, "mode", "plan");
    ok(current(await mgr.roomConfigOptions(r9.id), "mode") === "plan", "바꿨다");

    await mgr.setActiveRoom(null);
    await mgr.setActiveRoom(r9.id);
    ok(current(await mgr.roomConfigOptions(r9.id), "mode") === "plan", "나갔다 와도 그대로");

    // 창을 껐다 켜기 — 새 프로세스라 예전 세션을 모른다
    const revived2 = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    revived2.on("roomError", () => {});
    await revived2.setActiveRoom(r9.id);
    ok(current(await revived2.roomConfigOptions(r9.id), "mode") === "plan",
       "**세션이 새로 열려도 고른 모드를 다시 넣는다**");
    ok((await revived2.openRoom(r9.id)).participants[0]!.agentMode === "plan",
       "**우리 기록을 기본값으로 덮어쓰지 않는다**");
    revived2.dispose();
  }

  console.log("\n[고른 모델도 마찬가지 — Sonnet이 Opus로 돌아오면 안 된다 (B15)]");
  {
    const r10 = await mgr.createRoom({
      agentId: "fake", title: "소넷 유지", configValues: { model: "sonnet" },
    });
    ok((await mgr.openRoom(r10.id)).participants[0]!.model === "sonnet",
       "**id도 남긴다** — 이름만으로는 다시 적용할 수 없다");

    const again = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    again.on("roomError", () => {});
    await again.setActiveRoom(r10.id);
    ok(current(await again.roomConfigOptions(r10.id), "model") === "sonnet",
       "**껐다 켜도 Sonnet 그대로**");

    const back = (await again.openRoom(r10.id)).participants[0]!;
    ok(back.modelLabel === "Sonnet 5", `목록에도 (${String(back.modelLabel)})`);
    again.dispose();
  }

  console.log("\n[우리가 뜻을 모르는 설정도 그대로 돌아온다 (B15)]");
  {
    // 사고 강도·Fast mode처럼 **개별 필드를 안 만든 것들**. 하나씩 고치다
    // 빠뜨리는 걸 막으려고 범주를 가리지 않고 담는다.
    const r11 = await mgr.createRoom({ agentId: "fake", title: "강도" });
    await mgr.setConfig(r11.id, "effort", "high");
    ok(current(await mgr.roomConfigOptions(r11.id), "thought_level") === "high", "바꿨다");

    const revived3 = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    revived3.on("roomError", () => {});
    await revived3.setActiveRoom(r11.id);
    ok(current(await revived3.roomConfigOptions(r11.id), "thought_level") === "high",
       "**껐다 켜도 그대로** — 우리가 뜻을 몰라도 값은 지킨다");
    revived3.dispose();
  }

  console.log("\n[복구 실패 — 잃을 게 있을 때만 말한다]");
  {
    // 에이전트는 첫 프롬프트를 받아야 세션을 디스크에 남긴다(§13.1). 그래서
    // «만들고 말은 안 건» 방은 복구가 **반드시** 실패한다. 방을 열 때마다
    // 세션을 붙이므로(B1) 여기서 경고를 띄우면 빈 방마다 쌓인다.
    const noResume = { ...agent, env: { AIO_FAKE_STATE: state, AIO_FAKE_NO_RESUME: "1" } };
    const m2 = new RoomManager({ host, store, agents: [noResume], configProbeMs: 20000 });
    m2.on("roomError", () => {});

    const empty = await m2.createRoom({ agentId: "fake", title: "말 안 건 방" });
    const inner = m2 as unknown as {
      runtimes: Map<string, { bots: Map<string, { sessionId?: string }> }>;
      roomConfigs: Map<string, unknown>;
    };

    // 창을 껐다 켠 것과 같은 상태 — 저장된 id는 있고 런타임에는 없다
    unbind(inner, empty);
    await m2.roomConfigOptions(empty.id);
    const back = (await m2.openRoom(empty.id)).messages.filter((x) => x.role === "system");
    ok(!back.some((x) => x.text.includes("새 세션입니다")),
       "**빈 방에는 «맥락이 빠질 수 있습니다»를 안 띄운다** — 빠질 맥락이 없다");

    // 대화가 있으면 말해줘야 한다
    const used = await m2.createRoom({ agentId: "fake", title: "대화한 방" });
    const room2 = await m2.openRoom(used.id);
    room2.messages.push({
      id: "u1", role: "user", text: "고쳐줘", deliveredTo: [], createdAt: Date.now(),
    });
    unbind(inner, room2);
    await m2.roomConfigOptions(used.id);
    ok(room2.messages.some((x) => x.role === "system" && x.text.includes("새 세션입니다")),
       "**대화가 있으면 반드시 말한다** — 조용히 잃으면 안 된다");

    m2.dispose();
  }

  console.log("\n[아무것도 안 쓰고 나가면 방이 안 남는다 (B6)]");
  {
    const m3 = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    m3.on("roomError", () => {});

    const blank = await m3.createRoom({ agentId: "fake", title: "열었다 나간 방" });
    ok(await m3.discardIfUntouched(blank.id), "**지워진다**");
    ok(!m3.listMetas().some((x) => x.id === blank.id), "목록에서도 사라진다");

    console.log("\n[쓴 게 있으면 남는다]");
    const talked = await m3.createRoom({ agentId: "fake", title: "대화" });
    const r = await m3.openRoom(talked.id);
    r.messages.push({ id: "u1", role: "user", text: "안녕", deliveredTo: [], createdAt: 1 });
    ok(!(await m3.discardIfUntouched(talked.id)), "대화가 있으면 안 지운다");

    const drafted = await m3.createRoom({ agentId: "fake", title: "초안" });
    (await m3.openRoom(drafted.id)).draft = "쓰다 말았다";
    ok(!(await m3.discardIfUntouched(drafted.id)), "**초안도 쓴 것이다**");

    const roled = await m3.createRoom({
      agentId: "fake", title: "역할", rolePrompt: "너는 리뷰어다",
    });
    ok(!(await m3.discardIfUntouched(roled.id)), "**역할도 쓴 것이다**");

    // 제목은 우리가 지어줄 수도 있으므로 «쓴 것»으로 치지 않는다
    const titled = await m3.createRoom({ agentId: "fake", title: "제목만 지음" });
    ok(await m3.discardIfUntouched(titled.id), "제목만으로는 안 남긴다");

    m3.dispose();
  }

  console.log("\n[세션이 끊기면 되먹일지 묻는다 (F7)]");
  {
    const noResume = { ...agent, env: { AIO_FAKE_STATE: state, AIO_FAKE_NO_RESUME: "1" } };
    const m4 = new RoomManager({ host, store, agents: [noResume], configProbeMs: 20000 });
    m4.on("roomError", () => {});
    const inner = m4 as unknown as {
      runtimes: Map<string, { bots: Map<string, { sessionId?: string }> }>;
      roomConfigs: Map<string, unknown>;
      buildPrompt(r: Room, b: unknown, rt: unknown, batch: Message[]): Promise<Array<{ text?: string }>>;
    };

    const r0 = await m4.createRoom({ agentId: "fake", title: "끊긴 방" });
    const room = await m4.openRoom(r0.id);
    room.messages.push(
      { id: "u1", role: "user", text: "A를 고쳐줘", deliveredTo: [], createdAt: 1 },
      { id: "a1", role: "agent", text: "고쳤습니다", deliveredTo: [], createdAt: 2 },
    );

    unbind(inner, room);
    await m4.roomConfigOptions(room.id);

    ok(room.contextLost === true, "**어긋났다는 걸 들고 있는다** — 물어봐야 한다");
    ok(room.messages.some((m) => m.role === "system" && m.text.includes("사라졌")),
       "목록에 없으면 «사라졌다»고 말한다 (session/list)");
    ok(room.messages.some((m) => m.role === "system" && m.text.includes("—")),
       "**왜인지도 같이 적는다** — 이유가 로그에만 있으면 «우리가 끊었나»로 남는다");

    console.log("\n[«새로 시작»을 고르면 다시 안 묻고, 안 보낸다]");
    await m4.decideRefeed(room.id, false);
    // 굴려 올린 요약이라 꺼지면 «없음»이다 (봇에 아무도 안 남았으므로)
    ok(!room.contextLost, "배너가 사라진다");
    ok(!room.refeedPending, "되먹이지 않는다");

    console.log("\n[«이어가기»를 고르면 다음 프롬프트에 실린다 — 턴을 따로 쓰지 않는다]");
    await m4.decideRefeed(room.id, true);
    ok(room.refeedPending === true, "약속이 남는다");

    // 첨부가 있었던 메시지 — 되먹일 때 자리가 남아야 한다
    room.messages.push({
      id: "u9", role: "user", text: "이 스크린샷 봐줘", deliveredTo: [], createdAt: 2.5,
      attachments: [{ sha256: "x".repeat(64), mimeType: "image/png", name: "shot.png", byteSize: 10 }],
    });

    const next: Message = {
      id: "u2", role: "user", text: "이번엔 B", deliveredTo: [], createdAt: 3,
    };
    room.messages.push(next);
    const blocks = await inner.buildPrompt(room, room.participants[0], { roleInjected: true }, [next]);
    const text = blocks.map((b) => b.text ?? "").join("\n");

    ok(text.includes("A를 고쳐줘") && text.includes("고쳤습니다"), "**이전 대화가 들어간다**");
    ok(text.includes("이번엔 B"), "지금 요청도 함께");
    ok(!text.includes("사라졌"), "**우리 안내는 안 보낸다** — 에이전트에겐 잡음이다");
    ok(text.indexOf("A를 고쳐줘") < text.indexOf("이번엔 B"), "기록이 먼저, 요청이 나중");
    ok(text.includes("[첨부: shot.png]"),
       "**첨부는 자리를 남긴다** — 안 그러면 없는 걸 가리키는 문장만 남는다");
    ok(!text.includes("data:image"), "이미지를 통째로 다시 보내지는 않는다");
    /*
     * 약속은 이제 **봇에** 걸린다(B1) — 방 값은 «하나라도 남았나» 요약이다.
     * 여기서는 봇이 하나뿐이라 쓰고 나면 둘 다 꺼진다.
     */
    ok(!room.participants[0]!.refeedPending,
       "**한 번만 보낸다** — 매번 붙으면 돈이 계속 든다");
    ok(!room.refeedPending, "방 요약도 같이 꺼진다");

    console.log("[압축된 구간은 원문 대신 요약으로 간다]");
    // 에이전트가 기억하던 것도 그 요약이었다 — 원문을 다시 넣으면 압축 전보다 많아진다
    room.messages.splice(1, 0, {
      id: "cut1", role: "system", mark: "compaction", createdAt: 1.5, deliveredTo: [],
      text: "여기까지 압축됨", summary: "A를 고쳤다",
    });
    await m4.decideRefeed(room.id, true);
    const next2: Message = {
      id: "u3", role: "user", text: "그다음", deliveredTo: [], createdAt: 9,
    };
    room.messages.push(next2);
    const b2 = await inner.buildPrompt(room, room.participants[0], { roleInjected: true }, [next2]);
    const t2 = b2.map((b) => b.text ?? "").join("\n");

    ok(t2.includes("[이전 요약] A를 고쳤다"), "**요약이 앞머리로 들어간다**");
    ok(!t2.includes("A를 고쳐줘"), "**압축 이전 원문은 안 보낸다** — 그건 이미 요약된 것이다");
    ok(t2.includes("고쳤습니다"), "압축 뒤 원문은 그대로 간다");

    console.log("[압축이 여러 번이면 요약도 전부 넣는다]");
    // 나중 요약이 앞을 품는지는 스펙이 안 정한다. 하나만 쓰면 앞 구간이 말없이 사라진다.
    room.messages.splice(3, 0, {
      id: "cut2", role: "system", mark: "compaction", createdAt: 2.7, deliveredTo: [],
      text: "여기까지 압축됨", summary: "B도 손봤다",
    });
    await m4.decideRefeed(room.id, true);
    const next3: Message = { id: "u4", role: "user", text: "C", deliveredTo: [], createdAt: 10 };
    room.messages.push(next3);
    const t3 = (await inner.buildPrompt(room, room.participants[0], { roleInjected: true }, [next3]))
      .map((b) => b.text ?? "").join(" ");
    ok(t3.includes("A를 고쳤다") && t3.includes("B도 손봤다"),
       "**둘 다 들어간다** — 겹침은 토큰 몇, 누락은 맥락이다");
    ok(t3.indexOf("A를 고쳤다") < t3.indexOf("B도 손봤다"), "순서도 지킨다");

    console.log("[요약이 조각으로 와도 모은다]");
    const m6 = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    m6.on("roomError", () => {});
    const r6 = await m6.createRoom({ agentId: "fake", title: "조각" });
    const room6 = await m6.openRoom(r6.id);
    const rep6: Message = { id: "x", role: "agent", text: "", deliveredTo: [], createdAt: 1 };
    const in6 = m6 as unknown as { applyEvent(r: Room, m: Message, ev: unknown): void };

    in6.applyEvent(room6, rep6, { type: "compaction", id: "s1", status: "in_progress", summaryDelta: "앞부분" });
    in6.applyEvent(room6, rep6, { type: "compaction", id: "s1", status: "in_progress", summaryDelta: " 뒷부분" });
    in6.applyEvent(room6, rep6, { type: "compaction", id: "s1", status: "completed" });
    const got = room6.messages.find((m) => m.mark === "compaction");
    ok(got?.summary === "앞부분 뒷부분",
       `**조각을 모아 쓴다** — 마지막 알림엔 summary가 없다 (${String(got?.summary)})`);
    m6.dispose();

    console.log("[적게, 최대한 보존 — 무손실부터 쓰고 손해는 눈에 보이게]");
    {
      const r7 = await m4.createRoom({ agentId: "fake", title: "줄이기" });
      const room7 = await m4.openRoom(r7.id);
      const long = "가".repeat(5000);

      room7.messages.push(
        { id: "old", role: "user", text: long, deliveredTo: [], createdAt: 1 },
        { id: "nope", role: "user", text: "이건 못 보냈다", deliveredTo: [],
          createdAt: 2, sendFailed: "연결 실패" },
      );
      // 최근 12개를 채워 «old»가 접히는 자리로 밀려나게 한다
      for (let k = 0; k < 13; k++) {
        room7.messages.push({
          id: `f${k}`, role: "agent", text: `짧은 답 ${k}`, deliveredTo: [], createdAt: 10 + k,
        });
      }
      const last: Message = {
        id: "u", role: "user", text: long, deliveredTo: [], createdAt: 99,
      };
      room7.messages.push(last);

      await m4.decideRefeed(room7.id, true);
      const out = (await inner.buildPrompt(room7, room7.participants[0], { roleInjected: true }, []))
        .map((b) => b.text ?? "").join(" ");

      ok(!out.includes("이건 못 보냈다"),
         "**전달 안 된 메시지는 안 넣는다** — 이전 세션도 본 적 없다");
      ok(out.includes("[중략"), "**오래된 긴 메시지는 가운데를 접는다**");
      ok(out.includes("자]…"), "얼마나 접었는지 적는다 — 조용히 사라지지 않는다");
      ok(out.includes("넘겨짚지 말고"), "에이전트에게도 줄였다고 말한다");
      ok(out.includes(long), "**최근 것은 통째로 간다** — 이어서 할 지점이 거기다");
      const 가 = (out.match(/가/g) ?? []).length;
      ok(가 < 5000 + 1500, `오래된 쪽은 줄었다 («가» ${가}개 / 원래 10,000개)`);
    }

    m4.dispose();
  }
  console.log("\n[에이전트가 스스로 압축하면 알려준다 (C11)]");
  {
    const m5 = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    m5.on("roomError", () => {});
    const inner = m5 as unknown as {
      applyEvent(room: Room, reply: Message, ev: unknown): void;
    };

    const r0 = await m5.createRoom({ agentId: "fake", title: "압축" });
    const room = await m5.openRoom(r0.id);
    const reply: Message = {
      id: "a1", role: "agent", text: "", deliveredTo: [], createdAt: 1,
    };

    const fire = (status: string) =>
      inner.applyEvent(room, reply, { type: "compaction", id: "c1", status });

    fire("in_progress");
    ok(!room.messages.some((m) => m.mark === "compaction"), "도는 중에는 안 긋는다");

    fire("completed");
    const cut = room.messages.filter((m) => m.mark === "compaction");
    ok(cut.length === 1, "**끝나면 자국이 남는다**");
    ok(cut[0]!.role === "system", "시스템 메시지로");
    ok(!cut[0]!.text.includes("요약:"), "**요약 내용은 안 보여준다** — 읽을 건 자기 대화다");

    fire("completed");
    ok(room.messages.filter((m) => m.mark === "compaction").length === 1,
       "**같은 id로 여러 번 와도 하나** — 패치 의미론이다");

    console.log("\n[에이전트가 준 요약은 들고 있는다 — 되먹일 때 쓴다 (F7)]");
    const withSummary = m5 as unknown as {
      applyEvent(room: Room, reply: Message, ev: unknown): void;
    };
    withSummary.applyEvent(room, reply, {
      type: "compaction", id: "c2", status: "completed",
      summary: "A 파일을 리팩터링했고 테스트를 통과시켰다.",
    });
    const kept = room.messages.filter((m) => m.mark === "compaction").at(-1)!;
    ok(kept.summary === "A 파일을 리팩터링했고 테스트를 통과시켰다.",
       "**버리지 않는다** — 우리는 요약을 만들 수 없다");
    ok(!kept.text.includes("리팩터링"), "화면 문구에는 안 섞는다 — 보여줄 건 아니다");

    m5.dispose();
  }

  /*
   * ★ **여기 있던 «질문에 답한 기록» 테스트를 걷어냈다** (2026-09-21).
   *
   * 구조화된 질문(`elicitation`, D4) 채널 자체를 없앴기 때문이다 —
   * 광고하지 않으면 에이전트는 **그냥 글로 묻고**, 그건 대화에 말풍선으로
   * 남으므로 따로 기록할 «무엇을 골랐나»가 없다. 근거와 실측은 ROADMAP §D4.
   *
   * **권한 기록(D3)은 그대로 살아 있다** — `policy.mts` 와 `judgeflow.mts`.
   */

  console.log("\n[턴 밖에서 오는 것도 받는다 (A6)]");
  {
    // 명령 목록은 **세션을 여는 순간** 온다 — 프롬프트를 보내기도 전에.
    // 예전에는 그때 듣는 사람이 없어서 압축 버튼이 첫 턴 전엔 안 보였다.
    const r12 = await mgr.createRoom({ agentId: "fake", title: "명령" });
    ok(mgr.compactCommand(r12.id) === "compact",
       "**첫 메시지 전에 이미 압축 버튼을 안다**");

    // 에이전트가 스스로 압축하는 시점도 우리 턴과 무관하다
    const inner12 = mgr as unknown as {
      open: Map<string, Room>;
      onIdleEvent(r: Room, b: unknown, ev: unknown): void;
    };
    const room12 = inner12.open.get(r12.id)!;
    inner12.onIdleEvent(room12, room12.participants[0], {
      type: "compaction", id: "idle1", status: "completed", summary: "혼자 줄였다",
    });
    const cut = room12.messages.find((m) => m.mark === "compaction");
    ok(cut?.summary === "혼자 줄였다",
       "**턴 밖 압축도 기록된다** — 안 그러면 기록과 에이전트가 말없이 갈린다");
  }

  console.log("\n[CLI가 준 것을 숨기지 않는다 (§0 P5)]");
  {
    const r13 = await mgr.createRoom({ agentId: "fake", title: "전부 보여준다" });
    const room13 = (mgr as unknown as { open: Map<string, Room> }).open.get(r13.id)!;
    const bot13 = room13.participants[0]!;
    const fire = (ev: unknown) =>
      (mgr as unknown as { onIdleEvent(r: Room, b: unknown, e: unknown): void })
        .onIdleEvent(room13, bot13, ev);

    console.log("\n[턴 밖에서 말해도 방에 남는다]");
    fire({ type: "text", delta: "먼저 말을 겁니다" });
    const said = room13.messages.filter((m) => m.role === "agent" && m.text.includes("먼저"));
    ok(said.length === 1, "**새 말풍선이 생긴다** — 짝지을 응답이 없다고 버리지 않는다");
    ok(said[0]!.authorBotId === bot13.id, "누가 한 말인지도");

    fire({ type: "text", delta: " 이어서요" });
    ok(said[0]!.text === "먼저 말을 겁니다 이어서요", "이어지는 말은 같은 말풍선에");

    console.log("\n[계획도 버리지 않는다]");
    fire({ type: "plan", planId: "p1", entries: [{ text: "하나", status: "pending" }] });
    const withPlan = room13.messages.find((m) => m.plan);
    ok(withPlan?.plan?.entries?.[0]?.text === "하나", "**계획이 메시지에 담긴다**");

    console.log("\n[에이전트가 스스로 바꾼 모드도 따라간다]");
    fire({ type: "mode", modeId: "plan" });
    ok(bot13.agentMode === "plan", "**우리가 안 시킨 변경도 기록이 따라간다**");

    console.log("\n[모르는 종류는 삼키지 않고 로그로]");
    const seen: string[] = [];
    const loud = new RoomManager({
      host: { ...host, log: (m: string) => seen.push(m) },
      store, agents: [agent], configProbeMs: 20000,
    });
    loud.on("roomError", () => {});
    const r14 = await loud.createRoom({ agentId: "fake", title: "모르는 것" });
    const room14 = (loud as unknown as { open: Map<string, Room> }).open.get(r14.id)!;
    (loud as unknown as { onIdleEvent(r: Room, b: unknown, e: unknown): void })
      .onIdleEvent(room14, room14.participants[0], { type: "unknown", kind: "future_thing" });
    ok(seen.some((m) => m.includes("future_thing")),
       "**스펙이 늘어나도 «안 보이는 게 아니라 아직 안 만든 것»임을 알 수 있다**");
    loud.dispose();
  }

  console.log("\n[켜자마자 동시에 붙어도 capability를 놓치지 않는다 (A4)]");
  {
    // 🔴 `this.conn`은 `initialize`를 보내기 **전에** 채워진다. 그 사이에 다른
    // 호출이 «이미 떠 있네» 하고 빠져나가면 **init이 빈 채로** capability를 읽고,
    // `resume`을 지원하는데도 «지원 안 함»으로 판단해 멀쩡한 세션을 버린다.
    const slow = { ...agent, id: "slow", env: { AIO_FAKE_SLOW_INIT: "300" } };
    const m8 = new RoomManager({ host, store, agents: [slow], configProbeMs: 20000 });
    m8.on("roomError", () => {});
    const conn = (m8 as unknown as { connection(id: string): {
      ensureStarted(): Promise<void>;
      resumeSession(id: string, cwd: string): Promise<{ ok: boolean; reason?: string }>;
    } }).connection("slow");

    // 설정 미리 받기와 방 열기가 동시에 도는 상황
    const racing = conn.ensureStarted();
    await new Promise((r) => setTimeout(r, 50)); // conn은 찼고 init은 아직
    await conn.ensureStarted();                   // ← 여기서 일찍 빠져나가면 안 된다

    const got = await conn.resumeSession("없는-세션", dir);
    ok(!got.ok, "없는 세션이니 실패는 맞다");
    ok(!(got.reason ?? "").includes("지원하지"),
       `**capability를 제대로 읽는다** (${got.reason})`);
    await racing;
    m8.dispose();
  }

  console.log("\n[유령 세션이 진짜를 밀어내지 않는다 (F7)]");
  {
    const m9 = new RoomManager({ host, store, agents: [agent], configProbeMs: 20000 });
    m9.on("roomError", () => {});
    const r15 = await m9.createRoom({ agentId: "fake", title: "포인터" });
    const room15 = await m9.openRoom(r15.id);
    const bot15 = room15.participants[0]!;

    const born = bot15.sessionId!;
    ok(bot15.sessionPrompted !== true, "만들자마자는 **아직 써본 적 없는** 세션이다");

    // 말을 건다 → 이때부터 디스크에 남는다
    await m9.send(r15.id, "안녕");
    ok(bot15.sessionPrompted === true, "**쓰고 나면 되살릴 값이 된다**");
    ok(bot15.sessionId === born, "그 세션을 가리킨다");

    // 복구가 실패해 새 세션이 열리는 상황 — **기록은 안 밀려야 한다**
    const inner9 = m9 as unknown as {
      pointAt(b: unknown, id: string): void;
    };
    inner9.pointAt(bot15, "유령-세션");
    ok(bot15.sessionId === born,
       "**써본 세션은 유령에 안 밀린다** — 한 번의 복구 실패가 영구 손실이 되면 안 된다");

    // 새 세션이 실제로 쓰이면 그때 옮긴다
    (m9 as unknown as { notePrompted(r: Room, b: unknown, id: string): void })
      .notePrompted(room15, bot15, "새-세션");
    ok(bot15.sessionId === "새-세션", "쓴 세션으로는 밀린다");
    m9.dispose();
  }

  console.log("\n[복구 실패는 갈아타기가 아니다 — 옛 세션을 들고 있는다 (F7)]");
  {
    const noResume = { ...agent, id: "fake", env: { AIO_FAKE_STATE: state, AIO_FAKE_NO_RESUME: "1" } };
    const m10 = new RoomManager({ host, store, agents: [noResume], configProbeMs: 20000 });
    m10.on("roomError", () => {});
    const r16 = await m10.createRoom({ agentId: "fake", title: "다시 붙기" });
    const room16 = await m10.openRoom(r16.id);
    await m10.send(r16.id, "하던 얘기");
    const real = room16.participants[0]!.sessionId!;

    // 창을 껐다 켠 것처럼 런타임만 떼고, 복구는 실패하게 해둔다
    const inner10 = m10 as unknown as {
      runtimes: Map<string, { bots: Map<string, { sessionId?: string }> }>;
      roomConfigs: Map<string, unknown>;
    };
    delete inner10.runtimes.get(r16.id)!.bots.get(room16.participants[0]!.id)!.sessionId;
    inner10.roomConfigs.delete(`${r16.id}:${room16.participants[0]!.id}`);
    await m10.roomConfigOptions(r16.id);

    ok(room16.contextLost === true, "어긋났다고 알린다");
    ok(room16.lostSessionId === real,
       "**못 이어받은 세션을 들고 있는다** — 갈아타면 다시 시도할 대상이 사라진다");
    ok(room16.participants[0]!.sessionId === real,
       "**기록은 여전히 진짜를 가리킨다** — 유령이 밀어내지 않는다");

    console.log("[아직 안 되면 그렇다고 말하고, 기록은 그대로 둔다]");
    const notices: string[] = [];
    m10.on("notice", (_i, msg) => notices.push(msg));
    ok((await m10.retryResume(r16.id)) === false, "실패는 실패라고");
    void notices;
    // 이제 이런 알림은 **방의 기록**으로 남는다(§0 P5) — 이벤트로만 보내면
    // 화면을 다시 그릴 때 사라졌다.
    ok(r16.messages.some((m) => m.role === "system" && m.text.includes("아직 이어받을 수 없습니다")),
       "이유와 함께 알리고 **기록으로 남긴다**");
    ok(room16.lostSessionId === real, "**여전히 들고 있다** — 다음에 또 해볼 수 있다");

    console.log("[사용자가 «새로 시작»을 고르면 그때 놓는다]");
    await m10.decideRefeed(r16.id, false);
    ok(room16.lostSessionId === undefined, "고르고 나서야 놓는다");
    m10.dispose();
  }

  mgr.dispose();
  await new Promise((r) => setTimeout(r, 150));
  // 가짜 에이전트가 완전히 죽기 전이면 Windows가 폴더를 붙잡고 있다 — 청소 실패는 실패가 아니다
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log("\n전부 통과\n");
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
