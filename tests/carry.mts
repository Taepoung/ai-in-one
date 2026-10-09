/**
 * **지난 대화를 무엇으로 넘기나** (2026-10-02).
 *
 * 에이전트를 갈아타면 **세션이 버려진다** — 그 CLI의 것이라 이어받을 수
 * 없다. 그래서 막음 화면이 셋을 묻는다:
 *
 * ```
 * 기록 넘기기  요약 + 전부 (예전 것은 줄여서)
 * 요약 넘기기  요약 + **최근 것만**
 * 안 넘기기    백지
 * ```
 *
 * ⏪ **처음엔 «요약만» 으로 만들었다가 사용자가 짚었다** —
 * *"최근 채팅내역도 넘기는거 아니었음?"*. 맞다. 요약만 보내면 **방금 하던
 * 이야기가 통째로 사라진다** — 이어서 할 지점이 바로 거기인데.
 *
 * 그래서 둘의 차이는 «요약이냐 원문이냐» 가 아니라 **옛 것을 얼마나 싣는가**
 * 다. 덕분에 압축한 적 없는 방에서도 쓸모가 있다 — 그때는 그냥 «짧게
 * 넘기기» 가 된다. 예전에는 요약이 없으면 이 갈래를 아예 안 띄웠는데,
 * 그건 «요약만» 이었기 때문이고 이젠 아니다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { Message, Room } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-carry-"));
  const store = new RoomStore(dir); await store.init();
  const state = path.join(dir, "s.jsonl");
  const mk = (id: string) => ({
    ...DEFAULT_AGENTS[0]!, id, label: id,
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
  });
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [mk("a1"), mk("a2")], configProbeMs: 20000 });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const inner = mgr as unknown as { open: Map<string, Room> };

  const settle = async (id: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(id)); i++) await nap(25);
  };
  /** 그 세션에 들어간 프롬프트 글 */
  const prompts = (): string[] =>
    (fsSync.existsSync(state) ? fsSync.readFileSync(state, "utf8") : "")
      .split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; text?: string })
      .filter((e) => e.t === "prompt").map((e) => e.text ?? "");

  /** 한 방을 만들고 **옛 이야기 + 압축 요약 + 최근 이야기** 를 쌓는다 */
  async function build(): Promise<Room> {
    const room = await mgr.createRoom({ agentId: "a1", title: "긴 방" });
    const live = inner.open.get(room.id)!;
    const add = (role: "user" | "agent", text: string, extra: Partial<Message> = {}) => {
      live.messages.push({
        id: "m" + live.messages.length, role, text, createdAt: Date.now(),
        /*
         * ★ **양쪽 다 받는 이를 적는다** (2026-10-09).
         *
         * 🔴 예전에는 `user` 에만 적었다. 되먹임이 «그 봇이 실제로 본 것»만
         * 싣게 되면서(§4.1.1) 그 구멍이 드러났다 — 에이전트 줄에 `deliveredTo`
         * 가 아예 없어서 걸러지는 쪽을 **우연히** 타고 있었다.
         */
        deliveredTo: [live.participants[0]!.id],
        ...extra,
      } as Message);
    };
    add("user", "아주 예전 이야기 ZZOLD");
    add("agent", "예전 답");
    /*
     * 에이전트가 압축하면서 남긴 요약 — 우리가 지어낸 게 아니다.
     *
     * ★ **이 위는 두 갈래 모두 요약으로 대신한다.** 압축된 구간의
     * 원문을 다시 넣으면 압축 전보다 더 많이 보내게 된다 — 에이전트가
     * 기억하던 것도 그 요약이었다. 그래서 ZZOLD 는 어느 쪽에도 안 간다.
     */
    add("agent", "", { mark: "compaction", summary: "여태까지 요약 ZZSUM" });
    /*
     * 압축 뒤 구간을 **최근 잡아두는 수(12)보다 길게** 쌓는다 —
     * 그래야 두 갈래가 갈린다. 짧으면 둘이 똑같아서 **아무것도 안 재는
     * 검사가 된다.**
     */
    add("user", "압축 바로 뒤 ZZMID");
    add("agent", "거기 답");
    for (let i = 0; i < 12; i++) {
      add("user", `최근 이야기 ZZNEW${i}`);
      add("agent", `최근 답 ${i}`);
    }
    return live;
  }

  console.log("\n[★ 기록 넘기기 — 요약도 최근도 다 간다]");
  {
    const live = await build();
    const bot = live.participants[0]!;
    await mgr.setAgent(live.id, bot.id, "a2", { refeed: true, refeedKind: "log" });
    fsSync.writeFileSync(state, "", "utf8");
    await mgr.send(live.id, "이어서 해줘");
    await settle(live.id);
    const text = prompts().join("\n");
    console.log(`   실린 것: 요약 ${text.includes("ZZSUM") ? "O" : "X"} · 압축바로뒤 ${text.includes("ZZMID") ? "O" : "X"} · 최근 ${text.includes("ZZNEW11") ? "O" : "X"}`);
    ok(text.includes("ZZSUM"), "★ 요약이 간다");
    ok(text.includes("ZZNEW11"), "★ 최근 이야기가 간다");
    ok(text.includes("ZZMID"), "★ **압축 뒤 오래된 것까지 간다** — 그게 «기록» 이다");
    ok(!text.includes("ZZOLD"),
       "★ 압축 **이전**은 어느 갈래든 요약이 대신한다 — 원문을 다시 넣으면 압축 전보다 살진다");
  }

  console.log("\n[★ 요약 넘기기 — 요약 + **최근 것만**]");
  {
    const live = await build();
    const bot = live.participants[0]!;
    await mgr.setAgent(live.id, bot.id, "a2", { refeed: true, refeedKind: "summary" });
    fsSync.writeFileSync(state, "", "utf8");
    await mgr.send(live.id, "이어서 해줘");
    await settle(live.id);
    const text = prompts().join("\n");
    console.log(`   실린 것: 요약 ${text.includes("ZZSUM") ? "O" : "X"} · 압축바로뒤 ${text.includes("ZZMID") ? "O" : "X"} · 최근 ${text.includes("ZZNEW11") ? "O" : "X"}`);
    ok(text.includes("ZZSUM"), "★ 요약이 간다");
    ok(text.includes("ZZNEW11"),
       "★ **최근 이야기가 같이 간다** — 요약만 보내면 이어서 할 지점이 사라진다");
    ok(!text.includes("ZZMID"),
       "★ **대신 오래된 것은 빠진다** — 그게 «기록» 과의 차이다");
  }

  console.log("\n[★ 안 넘기기 — 백지]");
  {
    const live = await build();
    const bot = live.participants[0]!;
    await mgr.setAgent(live.id, bot.id, "a2", { refeed: false });
    fsSync.writeFileSync(state, "", "utf8");
    await mgr.send(live.id, "이어서 해줘");
    await settle(live.id);
    const text = prompts().join("\n");
    ok(!text.includes("ZZSUM") && !text.includes("ZZNEW11"),
       "★ 아무것도 안 간다 — 대화는 화면에만 남는다");
    ok(text.includes("이어서 해줘"), "★ 지금 보낸 말은 당연히 간다");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
