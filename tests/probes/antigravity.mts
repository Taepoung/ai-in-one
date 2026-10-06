/**
 * **Antigravity 가 진짜로 받아지고 뜨나** (2026-10-06).
 *
 * 우리가 처음 들이는 **zip 꼴** 에이전트다(ACP 레지스트리의
 * `distribution.binary`). npm 쪽은 `realinstall.mts` 가 재는데, 이쪽은
 * 받는 길부터 다르다:
 *
 * ```
 * ① 124MB zip 을 내려받는다
 * ② **Node 안에서 푼다** — tar/unzip 에 안 기댄다
 * ③ 푼 자리의 exe 가 ACP 를 말하나
 * ④ 무엇을 광고하나 (로그인 방법 · 모델)
 * ⑤ 지우면 비는가
 * ```
 *
 * ④가 중요하다. 로그인·모델·뒷정리 명령을 **아직 안 적었다** — 지어내면
 * 엉뚱한 걸 부르게 되므로(`codex-code-mode-host` 전적) 여기서 보고 적는다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  cmdPath, dirFor, install, remove, sizeOf, statusOf, spawnSpecFor, pickBinary, hostKey, realNpm, withInstalled,
} from "../../src/core/agentInstaller.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const MB = (n: number) => (n / 1048576).toFixed(0) + "MB";

/**
 * 🔴 **나무를 통째로 죽인다** (2026-10-06).
 *
 * `p.kill()` 은 윈도우에서 **부모만** 끝낸다. Antigravity 는 자식을
 * 띄우므로 그들이 실행파일을 물고 있어 **지우기가 EPERM 으로 막혔고**,
 * probe 를 돌릴 때마다 고아가 네 개까지 쌓였다.
 *
 * 제품은 이미 `killTree` 를 쓴다(`acpConnection.dispose`) — 못 따라가고
 * 있던 것은 **재는 쪽**이었다.
 */
function bye(p: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }): void {
  if (process.platform === "win32" && p.pid) {
    try {
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch { /* 안 되면 아래로 */ }
  }
  p.kill();
}

/** 띄워서 initialize 를 받아본다 */
function hello(cmd: string, args: string[]): Promise<Record<string, unknown> | string> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
    let buf = "", err = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => {
      buf += c;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line) as { id?: number; result?: Record<string, unknown> }; } catch { continue; }
        if (m.id === 1 && m.result) { bye(p); done(m.result); return; }
      }
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", (e) => done("터졌다: " + e.message));
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
    }) + "\n");
    setTimeout(() => { bye(p); done("응답 없음 · " + err.slice(-300)); }, 180000);
  });
}

async function main(): Promise<void> {
  const out: boolean[] = [];
  const a = DEFAULT_AGENTS.find((x) => x.id === "antigravity")!;
  const at = pickBinary(a.pkg!);
  console.log(`\n이 기계: ${hostKey()}`);
  if (!at) {
    console.log("  이 플랫폼 몫이 없다 — 여기선 못 쓴다");
    return;
  }
  console.log(`  받을 것: ${at.archive.split("/").pop()}`);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-agy-"));
  const dir = dirFor(root, a.id);

  console.log("\n[★ 받아서 푼다]");
  const began = Date.now();
  let last = "";
  const r = await install(dir, a.pkg!, realNpm, (l) => { last = l; });
  console.log(`   ${((Date.now() - began) / 1000).toFixed(0)}초 · ${r.ok ? "됐다" : "실패"} ${last} ${r.ok ? "" : r.say.slice(0, 200)}`);
  out.push(mark(r.ok, `★ **zip 을 받아 푼다** (${MB(sizeOf(dir))})`));
  if (!r.ok) { await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined); console.log(`\n  ${out.filter(Boolean).length}/${out.length}`); return; }

  const st = statusOf(dir, a.pkg!);
  out.push(mark(st.installed && !st.stale, "★ 받아졌다고 본다 — 표를 맨 마지막에 쓴다"));
  out.push(mark(fs.existsSync(path.join(dir, at.cmd)), `★ ${at.cmd} 가 있다`));

  /*
   * ★ **로그인할 것도 같이 받허나** (2026-10-06).
   *
   * ACP zip 에는 서버뿐이라 `agy` 를 따로 받는다. 이게 없으면 방은
   * 돌아가는데 **로그인할 길이 없는** 막다른 길이 된다.
   */
  const login = a.pkg!.auth?.login;
  const agy = login ? cmdPath(dir, login) : undefined;
  console.log(`   로그인용: ${agy ? "…" + agy.exe.slice(-22) : "(없다)"}`);
  out.push(mark(agy !== undefined, "★ **로그인용 `agy` 도 같이 받아졌다**"));
  if (agy) {
    let v = "";
    try { v = execFileSync(agy.exe, ["--version"], { encoding: "utf8", timeout: 120000 }).trim(); }
    catch (e) { v = String((e as { message?: string }).message).slice(0, 80); }
    console.log(`   agy --version: ${v}`);
    out.push(mark(/^\d/.test(v), `★ 그게 진짜 CLI 다 (${v})`));
  }

  console.log("\n[★ 띄우면 ACP 를 말하나]");
  const sp = spawnSpecFor(dir, a.pkg!);
  console.log(`   띄우는 것: …${sp.command.slice(-36)} ${sp.args.join(" ")}`);
  const said = await hello(sp.command, sp.args);
  if (typeof said === "string") {
    console.log(`   ${said}`);
    out.push(mark(false, "★ initialize 가 돌아온다"));
  } else {
    const info = said["agentInfo"] as { name?: string; version?: string } | undefined;
    console.log(`   agentInfo: ${JSON.stringify(info)}`);
    console.log(`   authMethods: ${JSON.stringify(said["authMethods"])}`);
    console.log(`   capabilities: ${JSON.stringify(said["agentCapabilities"]).slice(0, 300)}`);
    out.push(mark(true, `★ **ACP 를 말한다** (${info?.name ?? "?"})`));

    const w = withInstalled(a, root);
    out.push(mark(w.unavailable === undefined && w.command.length > 0,
      "★ 받은 뒤엔 막히지 않고 띄울 경로가 채워진다"));
  }

  console.log("\n[★ 지우면 빈다]");
  /*
   * 🔴 방금 띄운 것이 아직 붙잡고 있을 수 있다 — 윈도우는 떠 있는 실행파일을
   * 못 지운다. 제품은 지우기 전에 연결을 내리는데(`dropConnection`),
   * 여기선 손으로 띄웠으므로 잠시 기다린다.
   */
  await new Promise((r) => setTimeout(r, 2000));
  const before = sizeOf(dir);
  await remove(dir);
  out.push(mark(!fs.existsSync(dir), `★ 지워진다 (${MB(before)} 되찾음)`));

  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
