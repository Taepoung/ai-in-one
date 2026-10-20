/**
 * **진짜로 받아지나** (2026-10-01).
 *
 * `tests/installer.mts` 는 `npm` 자리에 가짜를 물려 배선만 잰다 — 꾸러미
 * 하나가 445MB 라 검사가 밟을 일이 아니기 때문이다. 그래서 **정말 받아지는지,
 * `overrides` 가 엔진을 정말 누르는지는 아무도 안 본 채**로 남는다.
 *
 * 여기서 사람 손으로 한 번 본다:
 *
 * ```
 * ① npm 이 우리 자리에 받아준다          `.bin` 이 생기나
 * ② **overrides 가 엔진을 누른다**        0.159.3 인가, 범위가 고른 딴 판인가
 * ③ 받은 것으로 어댑터가 뜬다             initialize 가 돌아오나
 * ④ **CODEX_PATH 가 실제로 먹는다**       사용자 codex(0.155.0)가 아니라 우리 것
 * ⑤ Claude 는 품은 exe 를 찾을 수 있다    `.bin` 에 안 나오는 그 exe
 * ```
 *
 * ④가 이 전환의 전부다. 어댑터 안이 `process.env["CODEX_PATH"] ?? "codex"`
 * 라, 안 박으면 **오류도 없이 사용자 기계의 판이 돈다.**
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  dirFor, install, remove, sizeOf, statusOf, spawnSpecFor, findOne, realNpm, withInstalled,
} from "../../src/core/install/agentInstaller.js";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import type { AgentDef } from "../../src/core/types.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const MB = (n: number) => (n / 1048576).toFixed(0) + "MB";

/** 받은 어댑터를 띄워 initialize 를 받아본다 */
function initialize(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const p = spawn(cmd, args, {
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      cwd: os.tmpdir(),
    });
    let buf = "", err = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => {
      buf += c;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line) as { id?: number; result?: unknown }; } catch { continue; }
        if (m.id === 1 && m.result) {
          const r = m.result as { agentInfo?: { name?: string; version?: string } };
          p.kill();
          done(`${r.agentInfo?.name ?? "?"}@${r.agentInfo?.version ?? "?"}`);
          return;
        }
      }
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", (e) => done("터졌다: " + e.message));
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n");
    setTimeout(() => { p.kill(); done("응답 없음 · " + err.slice(-160)); }, 180000);
  });
}

function versionIn(dir: string, pkg: string): string {
  try {
    const raw = fs.readFileSync(
      path.join(dir, "node_modules", ...pkg.split("/"), "package.json"), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch { return "(없음)"; }
}

async function one(agent: AgentDef, root: string, out: boolean[]): Promise<void> {
  console.log(`\n[${agent.label}] ${agent.pkg!.spec}`);
  const dir = dirFor(root, agent.id);
  const began = Date.now();
  let last = "";
  const r = await install(dir, agent.pkg!, realNpm, (l) => { last = l; });
  console.log(`   ${((Date.now() - began) / 1000).toFixed(0)}초 · ${r.ok ? "받았다" : "실패"} ${last.slice(0, 80)}`);
  if (!r.ok) { console.log("   " + r.say.slice(-400)); out.push(mark(false, "★ 받기")); return; }

  const st = statusOf(dir, agent.pkg!);
  console.log(`   판 ${st.version} · 자리 ${MB(sizeOf(dir))}`);
  out.push(mark(st.installed && !st.stale, `★ 우리 자리에 받아졌다 (${MB(sizeOf(dir))})`));

  if (agent.pkg!.overrides) {
    for (const [name, want] of Object.entries(agent.pkg!.overrides)) {
      const have = versionIn(dir, name);
      console.log(`   엔진 ${name} = ${have} (원한 것 ${want})`);
      out.push(mark(have === want,
        "★ **overrides 가 엔진을 눌렀다** — 범위로 두면 받을 때마다 달라진다"));
    }
  }

  const sp = spawnSpecFor(dir, agent.pkg!);
  if (agent.pkg!.exeEnv) {
    const mine = sp.env[agent.pkg!.exeEnv.name]!;
    const ours = execFileSync(mine, ["--version"],
      { encoding: "utf8", shell: true, timeout: 120000 }).trim();
    let theirs = "(안 깔림)";
    try { theirs = execFileSync("codex", ["--version"], { encoding: "utf8", shell: true, timeout: 120000 }).trim(); }
    catch { /* 없으면 없는 것 */ }
    console.log(`   우리 것 ${ours}  ·  PATH 것 ${theirs}`);
    out.push(mark(ours !== theirs || theirs === "(안 깔림)",
      "★ **우리 것과 사용자 것이 다르다** — 그러니 안 박으면 딴 판이 돈다"));
  }

  const said = await initialize(sp.command, sp.args, sp.env);
  console.log(`   initialize → ${said}`);
  out.push(mark(said.includes(agent.pkg!.spec!.split("@").slice(0, -1).join("@").slice(1)) || said.includes("@"),
    `★ 받은 것으로 어댑터가 뜬다 (${said})`));

  if (agent.pkg!.auth?.login?.find) {
    const exe = findOne(dir, agent.pkg!.auth.login.find);
    console.log(`   로그인용 exe: ${exe ? "…" + exe.slice(-44) : "(못 찾음)"}`);
    out.push(mark(exe !== undefined,
      "★ **품은 exe 를 찾는다** — `.bin` 에 안 나오므로 이 길뿐이다"));
    if (exe) {
      const v = execFileSync(exe, ["--version"], { encoding: "utf8", shell: true, timeout: 120000 }).trim();
      console.log(`   그 exe: ${v}`);
      out.push(mark(v.length > 0, `★ 그게 진짜 CLI 다 (${v})`));
    }
  }
}

/**
 * ★ **받은 것으로 끝까지 도나** (2026-10-01).
 *
 * 🔴 fallback 을 빼면서 **이 길이 유일한 길**이 됐다. 그전까지는 안 받았으면
 * `npx -y …` 로 조용히 돌았고, 실측도 전부 그쪽으로 했다(`codexdelete.mts`
 * 9/9, `smokereal` · `leavereal`). 즉 **여태껏 잰 것은 사라진 길이다.**
 *
 * 위에서는 `initialize` 까지만 봤다. 열리는 것과 **쓰이는 것은 다르다**:
 *
 * ```
 * 방 만들기  →  한 마디  →  나가기  →  세션이 정리되나
 * ```
 *
 * `CODEX_PATH` 가 제대로 박혔는지도 여기서 드러난다 — 안 박혔으면 사용자
 * 기계의 판이 돌아서 **뒷정리가 엉뚱한 자리를 보게** 된다.
 */
async function roundTrip(root: string, out: boolean[]): Promise<void> {
  console.log("\n[★ 받은 것으로 방을 열고 나가기까지]");
  const raw = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
  const agent = withInstalled(raw, root);
  console.log(`   띄우는 것: …${agent.command.slice(-34)}`);
  out.push(mark(agent.unavailable === undefined, "★ 받았으니 막히지 않는다"));
  out.push(mark(!agent.command.includes("npx"),
    "★ **npx 가 아니라 우리 자리를 띄운다** — fallback 을 뺀 뒤라 이게 유일한 길이다"));
  out.push(mark(agent.env?.["CODEX_PATH"] !== undefined, "★ CODEX_PATH 가 박혀 있다"));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-rt-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 120000 });
  mgr.on("roomError", (_r, e) => console.log("   roomError:", e));

  try {
    const room = await mgr.createRoom({ agentId: "codex", title: "끝까지" });
    await mgr.send(room.id, "«봤다» 라고만 답해. 도구 쓰지 마.");
    for (let i = 0; i < 2400 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const sid = room.participants[0]?.sessionId ?? "";
    const saved = await store.loadRoom(room.id);
    const said = (saved?.messages ?? [])
      .filter((m) => m.role === "agent").map((m) => m.text).join(" ");
    console.log(`   세션 ${sid.slice(0, 18)}… · 답 ${JSON.stringify(said.trim().slice(0, 40))}`);
    out.push(mark(sid.length > 0, "★ **세션이 붙는다**"));
    out.push(mark(said.trim().length > 0, "★ **답이 온다** — 열리는 것과 쓰이는 것은 다르다"));

    await mgr.leaveRoom(room.id);
    for (let i = 0; i < 60; i++) {
      if (!leftOver(sid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`   나간 뒤 · 세션 ${leftOver(sid) ? "남았다" : "없다"}`);
    out.push(mark(!leftOver(sid),
      "★ **나가면 정리된다** — 뒷정리도 우리 자리의 codex 가 한다"));
    out.push(mark((await store.loadRoom(room.id)) == null, "★ 방도 지워졌다"));
  } catch (e) {
    console.log("   터졌다:", e instanceof Error ? e.message.slice(0, 200) : String(e));
    out.push(mark(false, "★ 끝까지 도는가"));
  }
  mgr.dispose();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 잠겼으면 다음에 */ }
}

/** 그 세션이 파일이나 인덱스에 남아 있나 */
function leftOver(id: string): boolean {
  if (!id) return false;
  const CX = path.join(os.homedir(), ".codex");
  let file = false;
  const walk = (at: string): void => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory()) { walk(path.join(at, e.name)); continue; }
      if (e.name.includes(id)) file = true;
    }
  };
  walk(path.join(CX, "sessions"));
  let row = false;
  try {
    const db = new DatabaseSync(path.join(CX, "state_5.sqlite"), { readOnly: true });
    row = (db.prepare("select count(*) c from threads where id = ?").get(id) as { c: number }).c > 0;
    db.close();
  } catch { /* 없으면 없는 것 */ }
  return file || row;
}

async function main(): Promise<void> {
  const out: boolean[] = [];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-real-"));
  console.log(`자리: ${root}`);

  for (const id of ["codex", "claude"]) {
    const a = DEFAULT_AGENTS.find((x) => x.id === id)!;
    if (!a.pkg) { console.log(`\n[${a.label}] pkg 가 없다 — 건너뛴다`); continue; }
    await one(a, root, out);
  }

  await roundTrip(root, out);

  console.log("\n[★ 치운다 — 우리 자리라 마음대로]");
  const before = sizeOf(root);
  await remove(root);
  console.log(`   ${MB(before)} → ${fs.existsSync(root) ? "남았다" : "없다"}`);
  out.push(mark(!fs.existsSync(root), `★ 지워진다 (${MB(before)} 되찾음)`));

  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
