/**
 * **에이전트를 우리 자리에 받아두는 일** (2026-10-01).
 *
 * `npx -y <꾸러미>` 를 그만 쓰고 우리가 받아두기로 했다 — 왜인지는
 * `docs/INSTALL.md`. 여기서는 그 배선을 잰다.
 *
 * ⚠️ **망을 안 탄다.** 진짜 `npm install` 은 꾸러미 하나가 445MB 라 검사가
 * 밟을 일이 아니다. `npm` 을 부르는 자리를 주입식으로 빼뒀으므로 **가짜를
 * 물려** 나머지를 전부 잰다. 진짜로 받아지는지는 사람이 한 번 보면 된다.
 *
 * 재는 것:
 *
 * ```
 * ① `package.json` 에 overrides 가 들어간다   ← 엔진을 한 판으로 누르는 자리
 * ② 상태가 사용자가 정한 표대로 나온다
 * ③ **Codex 는 CODEX_PATH 가 박힌다**         ← 빠지면 조용히 딴 판이 돈다
 * ④ 받다 말면 «받았다» 고 안 한다
 * ⑤ 지우면 자리가 비고, pkg 없는 에이전트는 안 건드린다
 * ```
 *
 * ③이 제일 중요하다. 어댑터 안이 `process.env["CODEX_PATH"] ?? "codex"` 라
 * **안 박으면 사용자 기계의 codex 가 걸린다** — 오류도 안 나고 그냥 다른
 * 판이 돈다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import { spawnSync } from "node:child_process";
import {
  dirFor, splitSpec, manifestFor, statusOf, stateOf, spawnSpecFor,
  install, remove, findOne, withInstalled, pickBinary, hostKey, fetchExtra, straysIn,
  haveNode, nodeBinDir, nodeEnv, nodeHome, authStatus, type Run,
} from "../src/core/agentInstaller.js";
import { DEFAULT_AGENTS, NODE_PIN } from "../src/core/agentCatalog.js";
import type { AgentDef } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const WIN = process.platform === "win32";
const NL = String.fromCharCode(10);
const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
const codex = DEFAULT_AGENTS.find((a) => a.id === "codex")!;

/** 받아진 척 — 진짜 npm 대신 나무만 만든다 */
function fakeTree(dir: string, agent: AgentDef, version: string): void {
  const { name } = splitSpec(agent.pkg!.spec);
  const home = path.join(dir, "node_modules", ...name.split("/"));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "package.json"),
    JSON.stringify({ name, version }), "utf8");
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const b of [agent.pkg!.bin, agent.pkg!.exeEnv?.bin].filter(Boolean) as string[]) {
    fs.writeFileSync(path.join(bin, WIN ? b + ".cmd" : b), "", "utf8");
  }
}

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-inst-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-home-"));

  console.log("\n[★ package.json 에 엔진이 한 판으로 눌린다]");
  {
    const m = JSON.parse(manifestFor(codex.pkg!)) as Record<string, unknown>;
    console.log(`   ${JSON.stringify(m["dependencies"])} · overrides ${JSON.stringify(m["overrides"])}`);
    ok(JSON.stringify(m["dependencies"]).includes("codex-acp"), "★ 어댑터가 의존으로 들어간다");
    ok(JSON.stringify(m["overrides"]).includes("@openai/codex"),
       "★ **overrides 로 엔진이 눌린다** — 범위로 두면 받을 때마다 판이 달라진다");
    ok(!JSON.stringify(m["dependencies"]).includes("^"),
       "★ 어댑터 판에 범위 기호가 없다");

    const c = JSON.parse(manifestFor(claude.pkg!)) as Record<string, unknown>;
    ok(c["overrides"] === undefined, "★ 엔진이 못인 쪽은 overrides 를 안 넣는다");
  }

  console.log("\n[★ 상태가 표대로 나온다]");
  {
    const s0 = stateOf(codex, root, home);
    console.log(`   받기 전 · ${s0.state}`);
    ok(s0.state === "none", "★ 안 받았다 → `none` (설치하기)");

    fakeTree(dirFor(root, codex.id), codex, "2.1.0");
    const s1 = stateOf(codex, root, home);
    console.log(`   받은 뒤 · ${s1.state} (로그인 ${s1.loggedIn ? "됨" : "안됨"})`);
    ok(s1.state === "needLogin", "★ 받았는데 로그인 안 됨 → `needLogin` (로그인)");

    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}", "utf8");
    const s2 = stateOf(codex, root, home);
    console.log(`   로그인 뒤 · ${s2.state}`);
    ok(s2.state === "ready", "★ 받았고 로그인됨 → `ready` (로그아웃·사용량)");

    /* 핀을 올린 꼴 — 받아둔 것은 2.1.0 인데 원하는 것이 달라진다 */
    const bumped: AgentDef = { ...codex, pkg: { ...codex.pkg!, spec: "@agentclientprotocol/codex-acp@2.2.0" } };
    const s3 = stateOf(bumped, root, home);
    console.log(`   핀 올린 뒤 · ${s3.state} (있는 것 ${s3.version} · 원하는 것 ${s3.wanted})`);
    ok(s3.state === "stale", "★ 핀이 올라갔다 → `stale` (업데이트)");
    ok(s3.version === "2.1.0" && s3.wanted === "2.2.0", "★ 두 판을 같이 보여준다");

    const s4 = stateOf(codex, root, home);
    ok(s4.state === "ready", "★ **핀이 안 올라갔으면 그대로 둔다** — 괜히 다시 받지 않는다");
    ok(s4.size > 0, `★ 자리가 얼마나 먹는지 센다 (${s4.size}B)`);
  }

  console.log("\n[★ Codex 는 CODEX_PATH 가 박힌다]");
  {
    const dir = dirFor(root, codex.id);
    const sp = spawnSpecFor(dir, codex.pkg!);
    console.log(`   command = …${sp.command.slice(-28)}`);
    console.log(`   env     = ${JSON.stringify(Object.keys(sp.env))}`);
    ok(sp.command.includes("codex-acp"), "★ 어댑터 bin 을 띄운다");
    ok(sp.env["CODEX_PATH"] !== undefined,
       "★ **CODEX_PATH 가 박힌다** — 안 박으면 사용자 기계의 codex 가 걸린다");
    ok(sp.env["CODEX_PATH"]!.startsWith(dir),
       "★ 그게 **우리 자리**를 가리킨다");
    ok(!sp.env["CODEX_PATH"]!.includes("codex-acp"),
       "★ 어댑터가 아니라 엔진 쪽이다 — 둘을 바꿔 넣으면 제가 저를 부른다");

    const cl = spawnSpecFor(dirFor(root, claude.id), claude.pkg!);
    ok(Object.keys(cl.env).length === 0,
       "★ Claude 는 안 박는다 — 내버려두면 **제가 품은 exe** 를 쓴다");
  }

  console.log("\n[★ 받다 말면 «받았다» 고 안 한다]");
  {
    const dir = dirFor(root, "half");
    const half: AgentDef = { ...codex, id: "half" };

    /** 0 으로 끝나는데 아무것도 안 만드는 npm */
    const liar: Run = async () => ({ code: 0, say: "added 0 packages" });
    const r1 = await install(dir, half.pkg!, liar);
    console.log(`   거짓말하는 npm → ${r1.ok ? "통과" : "막힘"} «${r1.say}»`);
    ok(!r1.ok, "★ **종료코드만 믿지 않는다** — bin 이 생겼는지 본다");

    const real: Run = async (args, at) => { fakeTree(at, half, "2.1.0"); return { code: 0, say: "ok" }; };
    const r2 = await install(dir, half.pkg!, real);
    ok(r2.ok, "★ 제대로 받으면 통과한다");
    ok(fs.existsSync(path.join(dir, "package.json")), "★ 우리 package.json 이 남는다");

    let called = 0;
    const count: Run = async (a, at) => { called++; fakeTree(at, half, "2.1.0"); return { code: 0, say: "" }; };
    await install(dir, half.pkg!, count);
    ok(called === 0, "★ **이미 맞는 판이 있으면 npm 을 안 부른다**");
  }

  console.log("\n[★ 지우기 · 안 건드리기]");
  {
    const dir = dirFor(root, codex.id);
    ok(fs.existsSync(dir), "★ 있다가");
    await remove(dir);
    ok(!fs.existsSync(dir), "★ **지우면 비는 자리다** — 우리 것이라 마음대로 지운다");

    const mine = withInstalled(codex, root);
    ok(mine.command === codex.command,
       "★ 안 받아져 있으면 예전 길 그대로 — npx 로 뜬다");

    const user: AgentDef = { ...codex, id: "user", pkg: undefined };
    ok(withInstalled(user, root) === user,
       "★ **`pkg` 없는 에이전트는 손도 안 댄다** — 사용자가 제 손으로 적은 것이다");
    ok(stateOf(user, root, home).state === "ready",
       "★ 그런 건 «안 받았다» 고 말하지 않는다 — 거짓말이 된다");
  }

  console.log("\n[★ 플랫폼마다 다른 꾸러미 이름을 찾는다]");
  {
    const dir = dirFor(root, "glob");
    const deep = path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "claude.exe"), "", "utf8");
    const hit = findOne(dir, "node_modules/@anthropic-ai/claude-agent-sdk-*/claude*");
    console.log(`   찾은 것: …${(hit ?? "(없음)").slice(-34)}`);
    ok(hit !== undefined && hit.endsWith("claude.exe"),
       "★ **`*` 로 찾는다** — `-win32-x64` 와 `-darwin-arm64` 가 같은 자리를 쓴다");
    ok(findOne(dir, "node_modules/@anthropic-ai/nope-*/x") === undefined,
       "★ 없으면 없다고 한다");
  }

  console.log("\n[★ zip 꼴 — OS 따라 고르고, 핀이 올라가면 낡았다고 한다]");
  {
    /*
     * ★ **여기는 망을 안 탄다** (2026-10-06).
     *
     * 진짜로 받아보는 것은 `probes/antigravity.mts`(398MB)가 한다. 여기서
     * 재는 것은 **고르고 · 가리고 · 띄우는** 규칙이다 — 그쪽은 이 기계
     * 하나만 밟지만 이쪽은 **여섯 플랫폼을 다 밟을 수 있다.**
     */
    const agy = DEFAULT_AGENTS.find((x) => x.id === "antigravity")!;
    const pkg = agy.pkg!;

    const keys = Object.keys(pkg.binary ?? {});
    console.log(`   플랫폼 ${keys.length}개: ${keys.join(", ")}`);
    ok(keys.length === 6, "★ 여섯 플랫폼이 적혀 있다");
    ok(keys.includes(hostKey()), `★ 이 기계(${hostKey()}) 몫이 있다`);
    ok(pickBinary(pkg) !== undefined, "★ **OS 따라 알아서 고른다**");

    /* 모르는 플랫폼이면 «여기선 못 쓰는 에이전트» 다 — 받아놓고 실패하는 것보다 낫다 */
    ok(pickBinary({ binary: { "solaris-sparc": { archive: "x", cmd: "y" } } }) === undefined,
       "★ **이 기계 몫이 없으면 안 고른다**");

    /* 핀이 주소에 들어 있다 — 그래서 주소가 곧 판이다 */
    for (const k of keys) {
      const at = pkg.binary![k]!;
      ok(at.archive.includes("1.3.0"), `★ ${k} 주소에 판이 박혀 있다`);
    }
    /*
     * ★ **더 이상 `agy` 를 같이 받지 않는다** (2026-10-07).
     *
     * 로그인은 CLI 가 한다고 보고 190MB 를 같이 받았는데, 재보니 `agy` 와
     * ACP 서버가 **서로 다른 집을 본다.** 치워놓고 돌려도 세션이 붙고
     * 모델도 그대로 온다 — 써보고 뻐었다.
     *
     * ⚠️ `extras` 배선 자체는 남겨둔다. 다음에 묶음 밖에 무언가를 더 주는
     * 에이전트가 오면 그대로 쓴다 — 아래에서 따로 재는 이유다.
     */
    ok(pkg.extras === undefined, "★ **받는 것은 zip 하나다** — `agy` 190MB 는 안 받는다");

    /* ── 받기 전 · 받은 뒤 · 핀이 올라간 뒤 */
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-zip-"));
    const dir = dirFor(root, agy.id);
    ok(stateOf(agy, root, home).state === "none", "★ 받기 전엔 `none`");

    const at = pickBinary(pkg)!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, at.cmd), "", "utf8");
    fs.writeFileSync(path.join(dir, "aio-installed.json"),
      JSON.stringify({ archive: at.archive }), "utf8");
    const now = statusOf(dir, pkg);
    ok(now.installed && !now.stale, "★ 표를 쓰면 받아진 것으로 본다");

    /*
     * ★ **핀을 올린 꼴** — 주소가 달라지면 낡았다고 해야 한다. 그래야 화면에
     * «업데이트» 가 뜨고, 누르면 옛 자리를 지우고 새로 받는다.
     */
    const bumped = {
      ...pkg,
      binary: { ...pkg.binary, [hostKey()]: { ...at, archive: at.archive.replace("1.3.0", "1.4.0") } },
    };
    const next = statusOf(dir, bumped);
    console.log(`   핀 올린 뒤: ${next.stale ? "낡았다" : "그대로"}`);
    ok(next.stale, "★ **핀이 올라가면 낡았다고 한다** — 안 그러면 옛 판에 묶인다");
    ok(stateOf({ ...agy, pkg: bumped }, root, home).state === "stale", "★ 화면도 `stale` 로 본다");

    /* 띄울 것은 푼 자리의 실행파일이다 */
    const sp = spawnSpecFor(dir, pkg);
    ok(sp.command === path.join(dir, at.cmd), "★ 푼 자리의 실행파일을 띄운다");
    ok(sp.args.length === (at.args?.length ?? 0), "★ 플랫폼이 요구하는 인자도 그대로 (리눅스는 --uid=)");

    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  /*
   * ① **묶음 속 이름이 달라도 우리 이름으로 내려놓는다** (2026-10-06).
   *
   * 윈도우에서는 맨 exe 를 받아 **우리가 이름을 정한다.** 그래서 안 들키었다.
   * mac·리눅스는 `.tar.gz` 안에 **`antigravity`** 라는 딱 하나가 들어 있어,
   * 그대로 풀면 `find: agy` 가 **아무것도 못 찾는다** — 로그인이 죽는다.
   * 사람 눈에는 «받아졌다» 고 나오고, 누르면 아무 일도 안 일어난다.
   *
   * 망은 안 탄다 — 제자리에 서버를 띄우고 진짜 `.tar.gz` 를 만들어 먹인다.
   */
  {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-tar-"));
    const src = path.join(work, "src");
    await fsp.mkdir(src, { recursive: true });
    /* 구글이 하는 대로 — 묶음 속 이름은 `antigravity` 다 */
    await fsp.writeFile(path.join(src, "antigravity"), "#!/bin/sh");
    const tgz = path.join(src, "agy.tar.gz");
    /* 절대경로를 넘기면 GNU tar 가 `C:` 를 원격 호스트로 읽는다 */
    const made = spawnSync("tar", ["-czf", "agy.tar.gz", "antigravity"], { cwd: src, encoding: "utf8" });
    ok(made.status === 0, "묶음을 만들었다 (tar)");

    const body = await fsp.readFile(tgz);
    const server = http.createServer((_q, res) => { res.writeHead(200); res.end(body); });
    await new Promise<void>((done) => { server.listen(0, "127.0.0.1", () => { done(); }); });
    const port = (server.address() as { port: number }).port;

    const into = path.join(work, "into");
    await fsp.mkdir(into, { recursive: true });
    const got = await fetchExtra(into, { url: `http://127.0.0.1:${port}/agy.tar.gz` }, "agy");
    await new Promise<void>((done) => { server.close(() => { done(); }); });

    ok(got.ok, "받아서 푸는 데까지 된다");
    ok(fs.existsSync(path.join(into, "agy")), "★ **속 이름이 `antigravity` 여도 `agy` 로 내려간다**");
    ok(!fs.existsSync(path.join(into, "antigravity")), "★ 예전 이름은 안 남는다");
    ok(!fs.existsSync(path.join(into, "_x")), "푸는 데 쓴 임시 자리도 치운다");
    ok(findOne(into, "agy") !== null, "★ **로그인이 찾는 그 이름으로 있다** — 어느 판에서든 똑같다");

    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }

  await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
  /*
   * 🔴 **버려진 것과 쓰고 있는 것을 가른다** (2026-10-07).
   *
   * 사용자가 짚었다 — *"이거 쌓이면 안되지"*. 세어보니 Antigravity 가
   * **27개·581MB** 였다. F5 로 확장 호스트가 죽을 때마다 그 밑에 있던
   * 서버가 살아남았다. Claude·Codex 는 stdin 이 닫히면 끝나는데
   * 파이썬 서버는 안 끝난다.
   *
   * ⚠️ **전부 죽이면 안 된다.** globalStorage 는 창끼리 나눠 쓰므로 옆 창이
   * 쓰는 것까지 죽인다. 그래서 기준은 **«부모가 살아 있느냐»** 다.
   */
  {
    const WIN_ROOT = "c:" + path.sep + "x" + path.sep + "agents";
    const rows = [
      /* 옆 창의 확장 호스트 — 살아 있다 */
      { pid: 100, ppid: 1, path: path.join("c:" + path.sep, "Code.exe") },
      /* 그 창이 띄운 에이전트 — 써야 하므로 안 된다 */
      { pid: 101, ppid: 100, path: path.join(WIN_ROOT, "antigravity", "agy_acp_server.exe") },
      /* 버려진 나무의 뿌리 — 부모 999 가 표에 없다 */
      { pid: 200, ppid: 999, path: path.join(WIN_ROOT, "antigravity", "agy_acp_server.exe") },
      /* 그 자식 — 부모가 살아 있으니 따로 안 골라낸다 (나무째 죽는다) */
      { pid: 201, ppid: 200, path: path.join(WIN_ROOT, "antigravity", "localharness_external.exe") },
      /* 남의 집 — 우리 자리가 아니다 */
      { pid: 300, ppid: 999, path: path.join("c:" + path.sep, "Program Files", "git", "bash.exe") },
    ];
    const got = straysIn(rows, WIN_ROOT);
    console.log(`   버려진 것: ${JSON.stringify(got)}`);
    ok(got.includes(200), "★ **부모가 죽은 것은 버려진 것이다**");
    ok(!got.includes(101), "★ **옆 창이 쓰는 것은 안 건드린다** — 부모가 살아 있다");
    ok(!got.includes(201), "자식은 따로 안 골라낸다 — 뿌리를 나무째 죽인다");
    ok(!got.includes(300), "★ **남의 프로세스는 안 건드린다** — 우리 자리 밖이다");

    /* 대소문자가 달라도 같은 자리다 — 윈도우는 `c:` 와 `C:` 가 섮여 나온다 */
    const upper = straysIn(
      [{ pid: 400, ppid: 999, path: path.join(WIN_ROOT.toUpperCase(), "codex", "codex.exe") }],
      WIN_ROOT,
    );
    ok(upper.includes(400), "★ 대소문자가 달라도 우리 자리로 본다");
  }

  /*
   * ★ **Node 도 우리가 받아둔다** (2026-10-07).
   *
   * 사용자: *"노드 20은 이거 깔릴때 같이 깔리게는 못해?"*. CLI 를 안 깔아도
   * 된다고 해놓고 Node 는 깔라고 하는 것은 앞뒤가 안 맞는다.
   *
   * 망은 안 탄다 — 받은 척한 나무를 두고 **가리는 쪽만** 잰다. 진짜로
   * 받아지는지는 사람이 한 번 보면 된다 (34MB · 7.6초).
   */
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-nd-"));
    const base = path.join(root, "node");

    ok(!haveNode(root), "받기 전엔 없다고 한다");
    ok(Object.keys(nodeEnv(root)).length === 0,
       "★ **없으면 환경을 안 건드린다** — 그때는 사용자 것이 쓰여야 한다");

    /* 받은 척 — 판과 실행파일 둘 다 있어야 된다 */
    const exe = process.platform === "win32" ? "node.exe" : "node";
    fs.mkdirSync(nodeBinDir(root), { recursive: true });
    fs.writeFileSync(path.join(nodeBinDir(root), exe), "", "utf8");
    fs.writeFileSync(path.join(base, "aio-node.json"),
      JSON.stringify({ version: NODE_PIN.version }), "utf8");
    ok(haveNode(root), "★ 판과 실행파일이 다 있으면 받은 것으로 본다");

    /*
     * 🔴 **판이 다르면 안 받은 것으로 본다.** 안 그러면 핀을 올려도 옛 Node 가
     * 그대로 돌고, 어댑터가 요구하는 판과 어긋나면 «받았는데 안 돈다» 가 된다.
     */
    fs.writeFileSync(path.join(base, "aio-node.json"),
      JSON.stringify({ version: "0.0.0" }), "utf8");
    ok(!haveNode(root), "★ **판이 다르면 다시 받는다**");

    fs.writeFileSync(path.join(base, "aio-node.json"),
      JSON.stringify({ version: NODE_PIN.version }), "utf8");
    const env = nodeEnv(root);
    const key = Object.keys(env)[0]!;
    console.log(`   앞세운 칸: ${key} → …${(env[key] ?? "").split(path.delimiter)[0]!.slice(-28)}`);
    ok(/^path$/i.test(key), "★ PATH 를 건드린다 (윈도우는 `Path` 로 들어 있기도 하다)");
    ok((env[key] ?? "").startsWith(nodeBinDir(root) + path.delimiter),
       "★ **맨 앞에 세운다** — 뒤에 붙이면 사용자 Node 가 먼저 걸린다");

    /* 윈도우는 푸는 자리 바로 밑, 그 밖은 bin/ — 한쪽만 보고 짜면 반대쪽이 죽는다 */
    ok(nodeBinDir(root) === (process.platform === "win32"
        ? nodeHome(root) : path.join(nodeHome(root), "bin")),
       "★ **판마다 bin 자리가 다르다**");

    /* 에이전트 옆이 아니라 따로 있어야 한다 — 버려진 것 쓸어담기가 agents/ 만 본다 */
    ok(!nodeHome(root).includes(`${path.sep}agents${path.sep}`),
       "★ **`agents/` 안에 안 둔다** — 에이전트가 아니고 여럿이 같이 쓴다");

    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("\n[★ 로그인 묻기가 **가닥을 안 막는다**]");
  {
    /*
     * 🔴 여기가 `spawnSync` 였다. 부르는 쪽은 `setTimeout(…, 0)` 으로 감싸두고
     * *"뒤에서 갱신한다"* 라고 적어뒀는데, 그건 **이 스택에서 비키는 것뿐**이다 —
     * 콜백이 돌 때 확장 호스트의 **한 가닥이 통째로 멈춘다.** 평소 0.5초라 티가
     * 안 나고, **안 될 때만** 타임아웃 20초씩 두 번이 된다.
     *
     * 그래서 재는 것은 속도가 아니라 **가닥이 도는가**다 — 묻는 동안 타이머가
     * 몇 번 도는지. `spawnSync` 면 **한 번도 안 돈다.**
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-auth-"));
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });

    /** 느릿한 가짜 CLI — 300ms 뒤에 대답한다 */
    const slow = (name: string, where: "out" | "err") => {
      const js = `setTimeout(function(){process.std${where}.write('Logged in')},300)`;
      if (WIN) {
        fs.writeFileSync(path.join(bin, name + ".cmd"), `@echo off${NL}node -e "${js}"${NL}`);
      } else {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh${NL}exec node -e "${js}"${NL}`, { mode: 0o755 });
      }
    };
    slow("slowout", "out");
    slow("slowerr", "err");

    let beats = 0;
    const heart = setInterval(() => { beats++; }, 20);
    const began = Date.now();
    const got = await authStatus(dir, { bin: "slowout", args: [], yes: "Logged in" });
    const took = Date.now() - began;
    clearInterval(heart);

    if (took < 250) throw new Error(`FAIL: 전제가 안 선다 — 가짜가 안 느리다 (${took}ms)`);
    ok(got?.loggedIn === true, `★ 답을 읽는다 (${JSON.stringify(got)})`);
    ok(beats >= 5,
       `★ **묻는 동안 가닥이 돌았다** (${took}ms 에 ${beats}번) — spawnSync 면 0 이다`);

    const viaErr = await authStatus(dir, { bin: "slowerr", args: [], yes: "Logged in" });
    ok(viaErr?.loggedIn === true,
       "★ **stderr 로 써도 읽는다** — codex 가 그쪽으로 쓴다");

    const none = await authStatus(dir, { bin: "없는것", args: [], yes: "Logged in" });
    ok(none === undefined, "★ 없는 것을 물으면 undefined — 단추를 안 보여준다");

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
