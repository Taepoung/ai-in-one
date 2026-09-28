/**
 * **같은 에이전트로 봇을 둘** — v2.2(§6)의 심장.
 *
 * 화면은 이름으로 갈라 보여준다. 그런데 **진짜 문제는 그 아래**다: 두 봇이
 * 같은 CLI를 쓰는데 **세션까지 같으면 맥락이 통째로 섞인다** — «구현»에게 한
 * 말을 «리뷰어»가 읽고, 모델을 하나 바꾸면 둘 다 바뀐다.
 *
 * v2.2 를 따로 착수한 적이 없어서 **화면만 보고 «된다»고 하지 않으려고** 잰다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-scope-"));
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
      { ...base, id: "gamma", label: "감마" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const prompts = async () => {
    try {
      const raw = await fs.readFile(state, "utf8");
      return raw.split(NL).filter(Boolean).map((l) => JSON.parse(l))
        .filter((e: { t: string }) => e.t === "prompt") as Array<{ sessionId: string; text: string }>;
    } catch { return []; }
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { dir, mgr, prompts, settle };
}


async function main(): Promise<void> {
  const dirs: string[] = [];
  console.log(`${NL}[★ 같은 에이전트로 봇 둘 — 세션이 갈라지나 (v2.2의 심장)]`);
  {
    const { dir, mgr, prompts, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "쌍둥이",
      bots: [{ agentId: "alpha", name: "구현" }, { agentId: "alpha", name: "리뷰어" }],
    });
    const [a, b] = room.participants;
    ok(a!.name === "구현" && b!.name === "리뷰어", "이름이 갈라졌다");
    ok(a!.agentId === b!.agentId, "에이전트는 같다 — 이게 v2.2다");

    await mgr.send(room.id, "구현아", undefined, a!.id);
    await mgr.send(room.id, "리뷰어야", undefined, b!.id);
    await settle(room.id);

    ok(a!.sessionId !== null && b!.sessionId !== null, "둘 다 세션을 열었다");
    ok(a!.sessionId !== b!.sessionId,
       `★ **세션이 다르다** (${a!.sessionId?.slice(0, 8)} vs ${b!.sessionId?.slice(0, 8)}) — 같으면 맥락이 섞인다`);

    const ps = await prompts();
    const toA = ps.filter((p) => p.sessionId === a!.sessionId);
    const toB = ps.filter((p) => p.sessionId === b!.sessionId);
    ok(toA.some((p) => p.text.includes("구현아")) && !toA.some((p) => p.text.includes("리뷰어야")),
       "★ **구현에게는 구현 말만** 간다");
    ok(toB.some((p) => p.text.includes("리뷰어야")) && !toB.some((p) => p.text.includes("구현아")),
       "★ **리뷰어에게는 리뷰어 말만**");

    // 답도 제 이름으로 갈라져야 한다
    const said = room.messages.filter((m) => m.role === "agent");
    ok(said.some((m) => m.authorBotId === a!.id) && said.some((m) => m.authorBotId === b!.id),
       "★ 답이 봇마다 따로 달린다");
    mgr.dispose();
  }

  console.log(`${NL}[★ 모델도 따로 고를 수 있다 — 봇 단위다 (B1)]`);
  {
    const { dir, mgr, settle } = await make(); dirs.push(dir);
    const room = await mgr.createRoom({
      title: "모델", bots: [{ agentId: "alpha", name: "구현" }, { agentId: "alpha", name: "리뷰어" }],
    });
    const [a, b] = room.participants;
    await mgr.send(room.id, "안녕", undefined, a!.id);
    await mgr.send(room.id, "안녕", undefined, b!.id);
    await settle(room.id);

    await mgr.setConfig(room.id, "model", "sonnet", b!.id);
    ok(b!.model === "sonnet", "★ 리뷰어만 바뀐다");
    ok(a!.model !== "sonnet",
       `★ **구현은 그대로** (${String(a!.model)}) — 같은 에이전트라도 세션이 다르다`);
    mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
