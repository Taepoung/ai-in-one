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
import {
  dirFor, install, remove, sizeOf, statusOf, spawnSpecFor, findOne, realNpm,
} from "../../src/core/agentInstaller.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
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
  out.push(mark(said.includes(agent.pkg!.spec.split("@").slice(0, -1).join("@").slice(1)) || said.includes("@"),
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

async function main(): Promise<void> {
  const out: boolean[] = [];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-real-"));
  console.log(`자리: ${root}`);

  for (const id of ["codex", "claude"]) {
    const a = DEFAULT_AGENTS.find((x) => x.id === id)!;
    if (!a.pkg) { console.log(`\n[${a.label}] pkg 가 없다 — 건너뛴다`); continue; }
    await one(a, root, out);
  }

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
