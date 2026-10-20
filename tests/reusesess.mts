/**
 * **메시지마다 세션이 새로 생기나 — 우리 쪽** (2026-09-28).
 *
 * 같은 날 잰 이웃 사실이 불안하게 만든다: CLI `--print` 와 Agent SDK 는
 * **메시지마다 새 세션**을 만든다(2026-09-23). ACP 는 세션을 들고 있으니
 * 다를 «것 같지만», 재본 적이 없다.
 *
 * 새로 생기면 두 가지가 동시에 깨진다:
 *   ⓐ **맥락이 매 턴 끊긴다** — 어제 말한 걸 오늘 모른다
 *   ⓑ 사용자의 `claude` 폴더에 세션이 **무한히 쌓인다**
 *
 * 여기서는 **우리 코드**만 본다 — `runQueue` 가 `bt.sessionId` 를 재사용하는가.
 * 진짜 CLI 쪽은 `newsess.cjs` 가 따로 잰다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

type Ev = { t: string; sessionId?: string; text?: string };

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-reuse-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파" },
      { ...base, id: "beta", label: "베타" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const events = async (): Promise<Ev[]> => {
    try {
      const raw = await fs.readFile(state, "utf8");
      return raw.split(NL).filter(Boolean).map((l) => JSON.parse(l) as Ev);
    } catch { return []; }
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { mgr, events, settle };
}

async function main(): Promise<void> {
  const { mgr, events, settle } = await make();

  console.log("\n[★ 1:1 — 세 번 말해도 세션은 하나]");
  {
    const room = await mgr.createRoom({ agentId: "alpha", title: "혼잣말" });
    for (const t of ["하나", "둘", "셋"]) {
      await mgr.send(room.id, t);
      await settle(room.id);
    }
    const ev = await events();
    const news = ev.filter((e) => e.t === "new");
    const prompts = ev.filter((e) => e.t === "prompt");
    console.log(`   session/new ${news.length}번 · prompt ${prompts.length}번`);
    console.log(`   쓴 세션: ${[...new Set(prompts.map((p) => p.sessionId))].join(", ")}`);

    ok(prompts.length === 3, `★ 세 번 다 갔다 (${prompts.length})`);
    ok(news.length === 1,
       news.length === 1
         ? "★ **세션은 한 번만 연다** — 메시지마다 새로 만들지 않는다"
         : `🔴 **메시지마다 새 세션** (${news.length}번) — 맥락이 매 턴 끊기고 디스크에 쌓인다`);
    ok(new Set(prompts.map((p) => p.sessionId)).size === 1,
       "★ 세 프롬프트가 **같은 세션**으로 간다");
  }

  console.log("\n[★ 단체방 — 봇마다 하나씩, 그 이상은 아니다]");
  {
    /*
     * 🔴 기준선을 `createRoom` **뒤**에서 잡았다가 한 번 속았다.
     *
     * 방을 만드는 순간 세션 둘이 열리므로, 뒤에서 재면 «새 세션 0개»가
     * 나온다 — 좋아 보이지만 **정작 세려던 것을 안 센** 것이다. 재는 것은
     * «여섯 번 말했을 때 세션이 **모두 몇 개** 열렸나»이므로 방 여는 것까지
     * 포함해야 한다.
     */
    const before = (await events()).filter((e) => e.t === "new").length;
    const room = await mgr.createRoom({
      title: "둘이 있는 방",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "beta", name: "리뷰어" }],
    });
    for (let i = 0; i < 3; i++) {
      for (const b of room.participants) {
        await mgr.send(room.id, `${b.name}아 ${i}번째`, undefined, b.id);
        await settle(room.id);
      }
    }
    const ev = await events();
    const news = ev.filter((e) => e.t === "new").length - before;
    const mine = new Set(
      ev.filter((e) => e.t === "prompt" && String(e.text ?? "").includes("번째"))
        .map((e) => e.sessionId),
    );
    console.log(`   session/new ${news}번 · 쓴 세션 ${mine.size}개`);
    ok(news === 2,
       news === 2
         ? "★ **봇 수만큼만** 연다 — 여섯 번 말했어도 둘이다"
         : `🔴 여섯 번 말했더니 세션이 ${news}개 열렸다`);
    ok(mine.size === 2, "★ 그리고 그 둘로만 간다");
  }

  /*
   * ★ **끝내면 연결을 놓는다.**
   *
   * 🔴 안 놓았더니 «전부 통과»를 찍고도 **프로세스가 안 끝났다** — 가짜 에이전트
   * 자식이 이벤트 루프를 붙잡고 있어서다. 5분을 기다리다 «멈췄나» 하고 한참
   * 헤맸다. 다른 `.mts` 들은 `leaveRoom`(→ `disposeUnusedConnections`)을 부르는
   * 김에 우연히 정리되고 있었고, 이 검사는 **방을 안 나가므로** 드러났다.
   *
   * 스위트에서는 더 나쁘다 — `all.mjs` 의 5분 타임아웃을 통째로 먹고 실패로
   * 찍힌다. 재는 것은 다 맞았는데 «실패»로 보이는 셈이다.
   */
  mgr.dispose();
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
