import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { unzip } from "./unzip.js";
import type { AgentCmd, AgentDef, AgentPackage, AgentState } from "./types.js";

/**
 * **에이전트를 우리 자리에 받아둔다** (2026-10-01).
 *
 * 예전엔 방을 열 때마다 `npx -y <꾸러미>` 를 띄웠다. npx 가 알아서 받아주니
 * 편했는데 **받아둔 자리가 우리 것이 아니었다**(`_npx/<해시>`). 그래서:
 *
 * ```
 * 품은 exe 를 못 부른다      해시 폴더라 경로를 못 박는다
 * 옛 판을 못 지운다          남의 자리다 — Zed 도 같은 폴더를 쓴다
 * 받는 때를 못 고른다        «처음 쓸 때» 받아버린다
 * ```
 *
 * 자세한 사정은 `docs/INSTALL.md`.
 *
 * ⚠️ **`npm` 을 부르는 일은 주입받는다**(`run`). 검사가 망을 타면 안 되기
 * 때문이다 — 꾸러미 하나가 445MB 다. 경로·manifest·env 를 만드는 쪽은 전부
 * 순수 함수라 망 없이 잰다.
 */

/** 그 에이전트의 자리 */
export function dirFor(root: string, agentId: string): string {
  return path.join(root, "agents", agentId);
}

/** 꾸러미 이름과 판을 가른다 — `@scope/name@1.2.3` 의 마지막 `@` */
export function splitSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * 우리가 쓰는 `package.json`.
 *
 * ★ **`overrides` 가 여기 있는 이유** — 어댑터가 엔진을 범위로 물면
 * (`"@openai/codex": "^0.159.1"`) 받을 때마다 판이 달라진다. 실제로 이
 * 기계에 같은 어댑터 판을 받아둔 자리 둘의 엔진이 **0.159.2 와 0.159.3**
 * 이었다. `overrides` 는 그 범위를 한 판으로 눌러버린다 — npx 로는 `-p` 를
 * 둘 주는 꼼수를 썼는데, 우리 `package.json` 이 생기면 **정식 길**이 열린다.
 */
export function manifestFor(pkg: AgentPackage): string {
  const { name, version } = splitSpec(pkg.spec ?? "");
  const body: Record<string, unknown> = {
    name: "aio-agent-host",
    version: "1.0.0",
    private: true,
    dependencies: { [name]: version || "latest" },
  };
  if (pkg.overrides && Object.keys(pkg.overrides).length > 0) {
    body["overrides"] = pkg.overrides;
  }
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * ★ **이 기계의 열쇠** (2026-10-06) — `win32-x64` 꼴.
 *
 * 레지스트리는 `windows-x86_64` 처럼 적지만 우리는 `process.platform` ·
 * `process.arch` 를 그대로 쓴다. 옮겨 적는 표를 하나 더 두면 **둘이 갈릴
 * 자리**가 생긴다 — 카탈로그에 우리 말로 적는 편이 낫다.
 */
export function hostKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** 이 기계에서 받을 수 있는 꾸러미. 없으면 **그 기계에선 못 쓰는 에이전트**다 */
export function pickBinary(
  pkg: AgentPackage,
): { archive: string; cmd: string; args?: string[] } | undefined {
  return pkg.binary?.[hostKey()];
}

/** 받아둔 뒤 남기는 표 — 무엇을 받았는지 적어두고 다음에 맞춰본다 */
const MARK = "aio-installed.json";

function markOf(dir: string): { archive?: string } {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARK), "utf8")) as { archive?: string }; }
  catch { return {}; }
}

/**
 * zip 을 받아 푼다.
 *
 * 🔴 **받는 중에 죽으면 반만 푼 자리가 남는다.** 그러면 다음에 «받아져
 * 있다» 고 잘못 읽는다. 그래서 **다 풀고 맨 마지막에** 표를 쓴다 — 표가
 * 있으면 끝까지 간 것이다.
 */
export async function fetchBinary(
  dir: string,
  at: { archive: string; cmd: string },
  extras: NonNullable<AgentPackage["extras"]> = [],
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; say: string }> {
  await fsp.mkdir(dir, { recursive: true });
  const zipAt = path.join(dir, "_download.zip");
  try {
    onLine?.("받는 중…");
    const res = await fetch(at.archive);
    if (!res.ok) return { ok: false, say: `받지 못했습니다 — HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(zipAt, buf);
    onLine?.(`${(buf.length / 1048576).toFixed(0)}MB 받았습니다 — 푸는 중…`);

    const n = unzip(zipAt, dir);
    await fsp.rm(zipAt, { force: true });

    const exe = path.join(dir, at.cmd);
    if (!fs.existsSync(exe)) return { ok: false, say: `풀었는데 ${at.cmd} 가 없습니다 (${n}개)` };
    /*
     * ⚠️ **끼리(mode)는 zip 이 안 들고 온다.** 우리 풀개는 내용만 쓰므로
     * macOS·리눅스에선 실행 권한이 없다 — 그대로 두면 «권한 없음» 으로
     * 안 뜬다. 윈도우에선 뜻이 없어 건너뛴다.
     */
    if (process.platform !== "win32") await fsp.chmod(exe, 0o755);

    /*
     * ★ **같이 받아야 하는 것들** — Antigravity 는 로그인용 `agy` 가 따로 나온다.
     *
     * 하나라도 못 받으면 **표를 안 쓴다** — 방은 돌아가는데 로그인할 길이
     * 없는 상태를 «받아졌다» 고 하면, 사용자는 막다른 길을 걷게 된다.
     */
    for (const x of extras) {
      const one = x.at[hostKey()];
      if (!one) continue;
      const got = await fetchExtra(dir, one, x.saveAs, onLine);
      if (!got.ok) return got;
    }

    await fsp.writeFile(path.join(dir, MARK),
      JSON.stringify({ archive: at.archive }, null, 2), "utf8");
    return { ok: true, say: `${n}개를 풀었습니다` };
  } catch (err) {
    await fsp.rm(zipAt, { force: true }).catch(() => undefined);
    return { ok: false, say: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * ★ **매니페스트가 주소와 해시를 주는 꼴** (2026-10-06).
 *
 * Antigravity 의 `agy` CLI 가 그렇다. ACP 레지스트리의 `binary` 는 해시를
 * 안 주는데 **이쪽은 준다** — 받은 것이 온전한지 맞춰볼 수 있다.
 *
 * ```
 * GET …/manifests/windows_amd64.json
 * { version: "1.3.0", url: "…/cli_windows_x64.exe", sha512: "00ddc373…" }
 * ```
 *
 * 🔴 **해시가 안 맞으면 멈춘다.** 받다 만 것을 실행파일로 두면 그 다음에
 * 나는 오류가 엉뚱한 곳을 가리킨다.
 *
 * ⚠️ `.tar.gz` 는 `tar` 에 맡긴다. zip 과 달리 **`tar` 는 어디서나 gz 를
 * 푼다**(GNU·bsd 둘 다) — 우리가 직접 읽을 까닭이 없다. zip 을 직접 읽은
 * 것은 GNU tar 가 zip 을 못 풀어서였다.
 */
export async function fetchExtra(
  dir: string,
  m: { url: string; sha512?: string },
  saveAs: string,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; say: string }> {
  try {
    onLine?.(`${saveAs} 를 받는 중…`);
    const res = await fetch(m.url);
    if (!res.ok) return { ok: false, say: `${saveAs} 를 받지 못했습니다 — HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());

    if (m.sha512) {
      const got = createHash("sha512").update(buf).digest("hex");
      if (got !== m.sha512) {
        return { ok: false, say: `${saveAs} 가 온전하지 않습니다 — 해시가 다릅니다` };
      }
    }

    if (m.url.endsWith(".tar.gz") || m.url.endsWith(".tgz")) {
      const tmp = path.join(dir, "_extra.tar.gz");
      await fsp.writeFile(tmp, buf);
      const r = spawnSync("tar", ["-xzf", tmp, "-C", dir], { encoding: "utf8" });
      await fsp.rm(tmp, { force: true });
      if (r.status !== 0) return { ok: false, say: `푸는 데 실패했습니다 — ${r.stderr ?? ""}` };
    } else {
      /*
       * 🔴 **끝의 끜리를 따라간다** (2026-10-06).
       *
       * 처음엔 `saveAs` 그대로 썼다가 윈도우에서 **돌리지를 못했다** —
       * `agy` 는 실행파일이 아니고 `agy.exe` 가 실행파일이다. 받은 주소가
       * `cli_windows_x64.exe` 라고 말해주므로 그 끜리를 붙인다.
       */
      let ext = "";
      try { ext = path.extname(new URL(m.url).pathname); } catch { /* 주소가 이상하면 없는 대로 */ }
      await fsp.writeFile(path.join(dir, saveAs + ext), buf);
    }

    const got = findOne(dir, saveAs);
    if (!got) return { ok: false, say: `받았는데 ${saveAs} 가 없습니다` };
    if (process.platform !== "win32") await fsp.chmod(got, 0o755);
    return { ok: true, say: saveAs };
  } catch (err) {
    return { ok: false, say: err instanceof Error ? err.message : String(err) };
  }
}

/** Windows 의 `.bin` 은 `.cmd` 다 */
function binPath(dir: string, name: string): string {
  const base = path.join(dir, "node_modules", ".bin", name);
  return process.platform === "win32" ? base + ".cmd" : base;
}

/**
 * 그 자리에 실제로 받아져 있나, 받아져 있다면 몇 판인가.
 *
 * **`.bin` 과 `package.json` 을 둘 다 본다.** 받다 만 자리가 있을 수 있어서다 —
 * `node_modules` 는 생겼는데 `.bin` 이 없으면 받아진 게 아니다.
 */
export function statusOf(dir: string, pkg: AgentPackage): {
  installed: boolean;
  version?: string;
  wanted: string;
  stale: boolean;
} {
  /*
   * ★ **zip 꼴은 표를 본다** (2026-10-06).
   *
   * npm 꼴은 `node_modules/…/package.json` 이 판을 들고 있지만, 풀어놓은
   * zip 에는 그런 게 없다. 다 풀고 **맨 마지막에** 우리가 적은 표를
   * 보고, 그 표가 **지금 받으려는 주소와 같은가** 로 낡음을 가른다.
   * 주소에 판이 들어 있으므로(`…-1.3.0-windows-x86_64.zip`) 그걸로 충분하다.
   */
  const at = pickBinary(pkg);
  if (at) {
    const got = markOf(dir).archive;
    const ready = got !== undefined && fs.existsSync(path.join(dir, at.cmd));
    return {
      installed: ready,
      ...(got ? { version: got } : {}),
      wanted: at.archive,
      stale: ready && got !== at.archive,
    };
  }

  const { name, version } = splitSpec(pkg.spec ?? "");
  let have: string | undefined;
  try {
    const raw = fs.readFileSync(
      path.join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8");
    have = (JSON.parse(raw) as { version?: string }).version;
  } catch { /* 없으면 안 받아진 것 */ }

  const ready = have !== undefined && fs.existsSync(binPath(dir, pkg.bin ?? ""));
  return {
    installed: ready,
    ...(have ? { version: have } : {}),
    wanted: version,
    /* 받아는 있는데 판이 다르면 «낡았다» — 핀을 올린 뒤가 이 꼴이다 */
    stale: ready && have !== version,
  };
}

/**
 * 띄울 때 쓸 명령·인자·환경.
 *
 * 🔴 **`exeEnv` 를 빼먹으면 조용히 딴 판이 돈다.**
 *
 * 두 어댑터 다 엔진 바이너리를 PATH 에서 찾는 문을 두는데 기본값이 다르다:
 *
 * ```
 * Claude   CLAUDE_CODE_EXECUTABLE   기본: 품은 exe
 * Codex    CODEX_PATH               기본: **"codex" — PATH 에서 찾는다**
 * ```
 *
 * 지금껏 Codex 가 핀 판으로 돈 것은 **npx 가 제 `.bin` 을 PATH 앞에
 * 끼워줬기 때문**이다. 우리 자리에서 직접 띄우면 그 도움이 없어져
 * **사용자의 `codex` 가 걸린다**(이 기계: 0.155.0 vs 핀 0.159.3). 오류도
 * 안 나고 그냥 다른 판이 돈다 — 그래서 여기서 박는다.
 */
export function spawnSpecFor(
  dir: string,
  pkg: AgentPackage,
): { command: string; args: string[]; env: Record<string, string> } {
  const at = pickBinary(pkg);
  if (at) {
    /* 푸는 자리 기준 경로다 — `./agy_acp_server.exe` 같은 꼴이라 그대로 붙인다 */
    return { command: path.join(dir, at.cmd), args: at.args ?? [], env: {} };
  }
  const env: Record<string, string> = {};
  if (pkg.exeEnv) env[pkg.exeEnv.name] = binPath(dir, pkg.exeEnv.bin);
  return { command: binPath(dir, pkg.bin ?? ""), args: [], env };
}

/**
 * `AgentCmd` 를 실제 경로로.
 *
 * `bin` 은 `.bin` 에서, `find` 는 꾸러미 안에서 찾는다. 둘 다 없거나 못
 * 찾으면 **`undefined` 를 돌려준다** — 없는 걸 불렀다가 «명령을 찾을 수
 * 없습니다» 를 보여주는 것보다 단추를 안 보여주는 편이 낫다.
 */
export function cmdPath(
  dir: string,
  c: AgentCmd,
): { exe: string; args: string[] } | undefined {
  if (c.bin) {
    const p2 = binPath(dir, c.bin);
    return fs.existsSync(p2) ? { exe: p2, args: c.args } : undefined;
  }
  if (c.find) {
    const hit = findOne(dir, c.find);
    return hit ? { exe: hit, args: c.args } : undefined;
  }
  return undefined;
}

/**
 * ★ **로그인됐나를 CLI 에게 묻는다** (2026-10-02).
 *
 * 파일이 있나로 보는 것은 어림짐작이다 — 만료된 자격도 파일은 남고,
 * 자격을 OS 열쇠고리에 두는 플랫폼에선 파일이 아예 없을 수도 있다.
 *
 * 🔴 **두 흘림을 다 받는다.** `codex login status` 는 stderr 로 쓴다 —
 * stdout 만 읽으면 빈 글이 와서 **로그인된 사람을 아니라고** 하게 된다.
 * 한 번 그렇게 잎었다(`probes/logindoor.mts`).
 */
export function authStatus(
  dir: string,
  cmd: AgentCmd & { yes: string },
): { loggedIn: boolean } | undefined {
  const found = cmdPath(dir, cmd);
  if (!found) return undefined;
  const r = spawnSync(found.exe, found.args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 20000,
  });
  const said = `${r.stdout ?? ""}${NEWLINE}${r.stderr ?? ""}`;
  if (!said.trim()) return undefined;
  return { loggedIn: said.includes(cmd.yes) };
}

const NEWLINE = String.fromCharCode(10);

/** `npm` 한 번 — 밖에서 갈아끼울 수 있게 빼둔다 */
export type Run = (
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
) => Promise<{ code: number; say: string }>;

export const realNpm: Run = (args, cwd, onLine) =>
  new Promise((done) => {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const p = spawn(cmd, args, {
      cwd, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let say = "";
    const eat = (c: Buffer | string): void => {
      const t = String(c);
      say = (say + t).slice(-4000);
      if (onLine) for (const l of t.split("\n")) if (l.trim()) onLine(l.trim());
    };
    p.stdout.on("data", eat);
    p.stderr.on("data", eat);
    p.on("error", (e) => done({ code: -1, say: String(e.message) }));
    p.on("exit", (code) => done({ code: code ?? -1, say }));
  });

/**
 * 받는다. 이미 맞는 판이 있으면 아무것도 안 한다.
 *
 * ⚠️ **`--omit=optional` 은 안 쓴다.** 바이너리를 빼고 우리가 대주면
 * 227MB 를 아끼지만 플랫폼별 꾸러미를 손으로 골라야 한다 — npm 이
 * `os`/`cpu` 로 알아서 하는 일이다. 한 벌만 받으니 중복도 없다.
 */
export async function install(
  dir: string,
  pkg: AgentPackage,
  run: Run = realNpm,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; say: string }> {
  const was = statusOf(dir, pkg);
  if (was.installed && !was.stale) return { ok: true, say: "이미 받아져 있습니다" };

  /* zip 꼴은 npm 을 안 부른다 — 받아서 푸는 것이 전부다 */
  const at = pickBinary(pkg);
  if (at) {
    if (was.stale) await fsp.rm(dir, { recursive: true, force: true });
    return fetchBinary(dir, at, pkg.extras ?? [], onLine);
  }

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "package.json"), manifestFor(pkg), "utf8");

  /*
   * `--no-audit --no-fund` 는 말수를 줄이려는 것이고, `--install-strategy=hoisted`
   * 는 `.bin` 이 **우리가 아는 자리**에 생기게 한다. 기본값이 바뀌어도
   * `node_modules/.bin/<이름>` 을 그대로 쓸 수 있어야 한다.
   */
  const r = await run(
    ["install", "--no-audit", "--no-fund", "--install-strategy=hoisted"],
    dir, onLine);

  const now = statusOf(dir, pkg);
  if (r.code === 0 && now.installed && !now.stale) return { ok: true, say: r.say };

  /*
   * 🔴 **실패를 조용히 넘기지 않는다.** `npm` 이 0 으로 끝나고도 못 받는
   * 경우가 있다(망이 끊기거나 레지스트리가 느릴 때). 그래서 종료코드만
   * 믿지 않고 **`.bin` 이 실제로 생겼는지**를 같이 본다.
   */
  return {
    ok: false,
    say: r.code !== 0 ? r.say : `받았다는데 ${pkg.bin} 이 안 보입니다`,
  };
}

/** 지운다 — **우리 자리라서** 마음대로 지울 수 있다 */
export async function remove(dir: string): Promise<void> {
  /*
   * 🔴 **떠 있는 실행파일은 윈도우에서 못 지운다** (2026-10-06).
   *
   * Antigravity 를 받아 띄우고 바로 지우려 했더니 `EPERM: operation not
   * permitted, unlink …agy_acp_server.exe` 가 났다. 연결을 먼저 내려도
   * **자식 프로세스가 잠시 더 물고 있는다.**
   *
   * 바로 다시 해보면 대개 된다. 세 번까지 기다렸다가 그래도 안 되면
   * **조용히 넘어가지 않는다** — 반만 지워진 자리를 «지웠다» 고 하면
   * 다음에 «받아져 있다» 고 잎어 읽는다.
   */
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(
    `지우지 못했습니다 — 아직 돌고 있는 것이 있을 수 있습니다. ` +
    `잠시 뒤에 다시 해보세요. (${last instanceof Error ? last.message : String(last)})`);
}

/** 그 자리가 얼마나 먹고 있나 */
export function sizeOf(dir: string): number {
  let total = 0;
  const walk = (at: string): void => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const full = path.join(at, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try { total += fs.statSync(full).size; } catch { /* 사라졌으면 말고 */ }
    }
  };
  walk(dir);
  return total;
}

/**
 * `*` 한 칸이 들어간 경로를 하나 찾는다.
 *
 * 플랫폼별 꾸러미 이름이 달라서 필요하다 — `claude-agent-sdk-win32-x64` 와
 * `-darwin-arm64` 가 같은 자리를 차지한다. npm 이 `os`/`cpu` 로 골라 하나만
 * 받으므로 **거기 있는 하나**를 찾으면 된다.
 */
export function findOne(dir: string, pattern: string): string | undefined {
  let at = [dir];
  for (const seg of pattern.split("/")) {
    const next: string[] = [];
    for (const base of at) {
      if (!seg.includes("*")) {
        /*
         * 🔴 **별표 대신 이름을 적고 `.exe` 를 알아서 붙인다** (2026-10-06).
         *
         * 예전엔 `codex*` 로 적었는데 같은 폴더에 `codex-code-mode-host.exe`
         * 가 있어서 **그쪽이 먼저 잡혔다**(`-` 가 `.` 보다 앞서서). 로그인을
         * 엉뙡한 프로그램에 시키고 *"unexpected argument 'logout'"* 을 받았다.
         *
         * 플랫폼마다 끼리만 다를 뿐이므로 이름은 박고 끼리만 더한다 —
         * 별표는 **이름이 진짜로 모를 때**만 쓴다(꾸러미 이름의 플랫폼 꼬리).
         */
        for (const cand of [seg, seg + ".exe"]) {
          const full = path.join(base, cand);
          if (fs.existsSync(full)) { next.push(full); break; }
        }
        continue;
      }
      const re = new RegExp("^" + seg.split("*").map(esc).join(".*") + "$");
      let names: string[];
      try { names = fs.readdirSync(base); } catch { continue; }
      for (const n of names) if (re.test(n)) next.push(path.join(base, n));
    }
    at = next;
    if (at.length === 0) return undefined;
  }
  return at[0];
}

function esc(s: string): string {
  /* 정규식 특수문자를 줄로 잠그는데, 줄 자체를 적지 않고 코드로 만든다 */
  const back = String.fromCharCode(92);
  const safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return [...s].map((c) => (safe.includes(c) ? c : back + c)).join("");
}

/**
 * ★ **화면이 보여줄 단추는 여기서 나온다** (2026-10-01).
 *
 * 사용자가 정한 표 그대로다:
 *
 * ```
 * 안 받았다                  →  설치하기
 * 받았는데 핀이 올라갔다     →  업데이트
 * 받았다 + 로그인 안 됨     →  로그인
 * 받았다 + 로그인 됨        →  로그아웃 · 사용량
 * 핀이 안 올라갔다           →  그대로 둔다
 * ```
 *
 * **낡음이 로그인보다 앞선다.** 핀을 올렸는데 낡은 판이 도는 것은
 * «모델이 올라간 줄 알았는데 아니었다» 가 되기 때문이다(`docs/PIN.md` §A).
 * 다만 `loggedIn` 을 같이 돌려주므로 화면은 둘 다 보여줄 수 있다.
 */
export function stateOf(
  agent: AgentDef,
  root: string,
  home: string,
): {
  state: AgentState;
  version?: string;
  wanted?: string;
  size: number;
  loggedIn: boolean;
  dir: string;
} {
  const dir = dirFor(root, agent.id);
  const loggedIn = agent.pkg?.auth
    ? fs.existsSync(path.join(home, agent.pkg.auth.file))
    : true;

  /*
   * `pkg` 가 없는 에이전트는 우리가 받는 게 아니다 — 사용자가
   * `aiInOne.agents` 로 적은 것이다. «안 받았다» 고 말하면 거짓말이 된다.
   */
  if (!agent.pkg) {
    return { state: loggedIn ? "ready" : "needLogin", size: 0, loggedIn, dir };
  }

  const st = statusOf(dir, agent.pkg);
  const common = {
    ...(st.version ? { version: st.version } : {}),
    wanted: st.wanted,
    size: st.installed ? sizeOf(dir) : 0,
    loggedIn,
    dir,
  };
  if (!st.installed) return { state: "none" as const, ...common };
  if (st.stale) return { state: "stale" as const, ...common };
  return { state: (loggedIn ? "ready" : "needLogin") as AgentState, ...common };
}

/**
 * 그 에이전트를 우리 자리에서 띄울 수 있으면 그렇게 고쳐준다.
 *
 * **`pkg` 가 없으면 손대지 않는다.** 사용자가 `aiInOne.agents` 로 제 손으로
 * 적은 것이 그 꼴이다 — 그런 건 적힌 대로 띄우는 게 맞다.
 */
export function withInstalled(agent: AgentDef, root: string): AgentDef {
  if (!agent.pkg) return agent;
  const dir = dirFor(root, agent.id);
  if (!statusOf(dir, agent.pkg).installed) {
    /*
     * 🔴 **안 받았으면 띄우지 않는다** (2026-10-01).
     *
     * 예전엔 여기서 그냥 `agent` 를 돌려줬다 — 즉 적혀 있는 `npx -y …`
     * 로 **조용히 돌았다.** 편해 보였지만 그게 바로 고치려던 것이다:
     * 방을 열었을 뿐인데 **445MB 를 모르고 받게** 된다. 화면은 막아두고
     * 엔진만 관대하면 «목록엔 안 보이는데 어륄70 받고 있다» 가 된다.
     *
     * 돌리는 것은 **고칠 수 있는 말**이다 — 어디서 받는지까지 적는다.
     */
    return {
      ...agent,
      unavailable:
        `${agent.label}을(를) 아직 받지 않았습니다. ` +
        `목록 화면 위의 로봇 아이콘에서 받아주세요.`,
    };
  }
  const s = spawnSpecFor(dir, agent.pkg);
  return { ...agent, command: s.command, args: s.args, env: { ...agent.env, ...s.env } };
}
