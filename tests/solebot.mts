/**
 * **봇을 안 짚은 부름은 단체방에서 아무에게도 안 건다** (리팩토링 ⑥, 2026-10-20).
 *
 * 🔴 예전엔 `soleBot()` 이 `participants[0]` 이라, 단체방에서 `botId` 를 빠뜨리면
 * 역할·소개·압축이 **첫 번째 봇에 조용히** 걸렸다. 주석은 «지목해야 한다» 고
 * 말했는데 코드가 막지 않았다. 1:1 에서는 지금처럼 그 하나에게 건다.
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

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-solebot-"));
  const store = new RoomStore(dir); await store.init();
  const logs: string[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: (m) => logs.push(m), defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [{ ...base, id: "alpha", label: "알파" }, { ...base, id: "beta", label: "베타" }],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  return { dir, mgr, logs };
}

async function main(): Promise<void> {
  console.log(`${NL}[★ 1:1 — 봇을 안 짚어도 그 하나에게 건다 (예전 그대로)]`);
  {
    const t = await make();
    const room = await t.mgr.createRoom({ title: "하나", bots: [{ agentId: "alpha" }] });
    await t.mgr.setBlurb(room.id, "코드를 쓴다");
    ok(room.participants[0]!.blurb === "코드를 쓴다", "★ 소개가 그 하나에게 붙는다");
    ok(t.logs.every((l) => !l.includes("지목하지 않은")), "★ 1:1 에서는 로그도 안 남긴다");
    t.mgr.dispose(); await fs.rm(t.dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`${NL}[★ 단체방 — 봇을 안 짚으면 **첫 봇으로 새지 않는다**]`);
  {
    const t = await make();
    const room = await t.mgr.createRoom({
      title: "둘", bots: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    await t.mgr.setBlurb(room.id, "엉뚱한 소개");
    await t.mgr.setRole(room.id, "엉뚱한 역할");
    /*
     * 🔴 **여기가 고친 자리다.** 예전엔 둘 다 첫 봇(알파)에 붙었다 — 화면은
     * 아무 봇도 고른 적이 없는데.
     */
    ok(room.participants.every((b) => b.blurb === undefined),
       `★ **소개가 아무에게도 안 붙는다** (${room.participants.map((b) => b.blurb ?? "-").join(" · ")})`);
    ok(room.participants.every((b) => (b.rolePrompt ?? "") === ""),
       "★ **역할도 아무에게도 안 붙는다**");
    ok(t.logs.some((l) => l.includes("지목하지 않은")),
       "★ **로그에 남긴다** — 찍히면 부르는 쪽의 버그다");

    // 짚으면 그 봇에게만 간다
    const beta = room.participants[1]!;
    await t.mgr.setBlurb(room.id, "리뷰한다", beta.id);
    ok(beta.blurb === "리뷰한다" && room.participants[0]!.blurb === undefined,
       "★ 짚은 봇에게만 붙는다");
    t.mgr.dispose(); await fs.rm(t.dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
