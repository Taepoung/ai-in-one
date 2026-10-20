/**
 * **모델 목록은 판을 열쇠로 디스크에 남는다** (2026-10-13).
 *
 * 🔴 목록을 알려면 **세션을 한 번 열어야** 하고, 세션을 열려면 **CLI 를
 * 띄워야** 한다. 실측으로 Antigravity 가 **18.6초**다(띄우기 12.5 + 세션 5).
 * 그런데 캐시가 **메모리에만** 있어서 **창을 열 때마다** 그 값을 다시 냈다.
 *
 * 목록이 바뀌는 때는 **판이 바뀔 때**고, 판은 우리가 박아두고 있다. 그러니
 * 판을 열쇠로 적어두면 다음 창부터는 공짜다.
 *
 * 여기서 재는 것은 **«띄우지 않았나»** 다 — 속도가 아니라. 그래서 둘째
 * 매니저에는 **없는 실행파일**을 물린다. 캐시를 안 쓰면 거기서 터진다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { dirFor, splitSpec } from "../src/core/agentInstaller.js";
import type { AgentDef } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const WIN = process.platform === "win32";
const here = path.dirname(fileURLToPath(import.meta.url));

/** 받아둔 척 — 판만 든 나무를 만든다 (`statusOf` 가 그걸 본다) */
function fakeTree(dir: string, pkg: NonNullable<AgentDef["pkg"]>, version: string): void {
  const { name } = splitSpec(pkg.spec!);
  const home = path.join(dir, "node_modules", ...name.split("/"));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ name, version }), "utf8");
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, WIN ? pkg.bin! + ".cmd" : pkg.bin!), "", "utf8");
}

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-mcache-"));
  const root = path.join(dir, "store");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };

  const pkg = { ...DEFAULT_AGENTS[0]!.pkg!, spec: "@aio/fake@1.0.0", bin: "fake-acp" };
  const agent: AgentDef = {
    ...DEFAULT_AGENTS[0]!, id: "alpha", label: "알파", pkg,
    command: "node", args: [path.join(here, "fakeagent.cjs")], env: {},
  };
  const at = dirFor(root, agent.id);
  fakeTree(at, pkg, "1.0.0");

  const make = (a: AgentDef) =>
    new RoomManager({ host, store, agents: [a], configProbeMs: 20000, agentRoot: root });

  console.log(`${NL}[★ 한 번 받아오면 **판을 열쇠로 디스크에 남는다**]`);
  const first = make(agent);
  first.on("roomError", () => {}); first.on("notice", () => {});
  const got = await first.configOptions(agent.id);
  ok(got.length > 0, `설정을 받아왔다 (${got.length}칸)`);
  first.dispose();

  const file = path.join(at, "aio-models.json");
  await (async () => {
    for (let i = 0; i < 100; i++) {
      // **쓰는 중에는 비어 있다** — 있는 것만 보면 빈 파일을 읽는다
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("FAIL: 전제가 안 섰다 — 파일이 안 생겼다");
  })();
  const kept = JSON.parse(fs.readFileSync(file, "utf8")) as { key?: string; options?: unknown[] };
  ok(kept.key === "1.0.0", `★ **판이 열쇠다** (${kept.key})`);
  ok((kept.options ?? []).length === got.length, "★ 받아온 것이 그대로 들어 있다");

  console.log(`${NL}[★ 다음 창은 **CLI 를 안 띄운다**]`);
  {
    /*
     * 🔴 여기가 핵심이다. **없는 실행파일**을 물려두면, 캐시를 안 쓰고
     * 띄우려 드는 순간 터진다 — 「안 띄웠다」를 그렇게 잰다.
     */
    const broken: AgentDef = { ...agent, command: path.join(dir, "없는것"), args: [] };
    const second = make(broken);
    second.on("roomError", () => {}); second.on("notice", () => {});
    const again = await second.configOptions(agent.id);
    ok(again.length === got.length,
       `★ **적어둔 것으로 바로 답한다** (${again.length}칸) — 띄웠으면 터졌다`);
    second.dispose();
  }

  console.log(`${NL}[★ 판이 올라가면 **버린다**]`);
  {
    // 받아둔 판만 올린다 — 파일은 그대로 1.0.0 을 열쇠로 들고 있다
    fakeTree(at, pkg, "1.0.1");
    const broken: AgentDef = { ...agent, command: path.join(dir, "없는것"), args: [] };
    const third = make(broken);
    third.on("roomError", () => {}); third.on("notice", () => {});
    let why = "";
    try { await third.configOptions(agent.id); } catch (e) { why = (e as Error).message; }
    ok(why !== "",
       `★ **낡은 목록을 안 쓴다** — 띄우려다 터졌다 (${why.slice(0, 40)}…)`);
    third.dispose();
  }

  await new Promise((r) => setTimeout(r, 100));
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
