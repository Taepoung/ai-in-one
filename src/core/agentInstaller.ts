import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
/* 🔴 **`spawnSync` 를 안 들여온다** — 확장 호스트는 한 가닥이고, 여기 있던
 * 동기 호출 넷이 전부 그 가닥을 붙잡고 있었다 (2026-10-13). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { unzip } from "./unzip.js";
import { NODE_PIN } from "./agentCatalog.js";
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

/** 주소 안의 판을 뽑는다 — 못 찾으면 파일 이름으로 */
function versionIn(url: string): string {
  const m = /\d+\.\d+\.\d+/.exec(url);
  return m ? m[0] : (url.split("/").pop() ?? url);
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
  /*
   * ★ **빈 자리에서 시작한다** (2026-10-06).
   *
   * 반만 지워진 자리 위에 풀면 **떠 있는 파일을 덮어쓰려다 EBUSY** 로
   * 죽는다 — 사용자가 밟은 그것이다. `remove` 가 안 되면 옆으로
   * 치워서라도 자리를 비운다.
   */
  await remove(dir).catch(() => undefined);
  await fsp.mkdir(dir, { recursive: true });
  const zipAt = path.join(dir, "_download.zip");
  try {
    onLine?.("받는 중…");
    const res = await fetch(at.archive);
    if (!res.ok) return { ok: false, say: `받지 못했습니다 — HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(zipAt, buf);
    onLine?.(`${(buf.length / 1048576).toFixed(0)}MB 받았습니다 — 푸는 중…`);

    const n = await unzip(zipAt, dir);
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
      /*
       * 🔴 **묶음 속 이름이 우리가 부르는 이름과 다를 수 있다** (2026-10-06).
       *
       * 사용자가 짚었다 — *"exe를 지정해서 cli에 접근하면 os가 달라지면
       * 실행이 안될 수도 있는거 아니야?"*. 맞았다. 윈도우는 맨 exe 라 우리가
       * 이름을 정하지만, mac·리눅스는 `.tar.gz` 안에 **`antigravity`** 라는
       * 이름으로 들어 있다 — `agy` 로 찾으면 **없다.**
       *
       * 그래서 따로 풀고 **우리 이름으로 바꾼다.** 그러면 카탈로그는
       * 플랫폼을 몰라도 된다 — `find: "agy"` 하나로 어디서든 찾는다.
       */
      const into = path.join(dir, "_x");
      await fsp.mkdir(into, { recursive: true });
      const tmp = path.join(into, "_extra.tar.gz");
      await fsp.writeFile(tmp, buf);
      /*
       * 🔴 **tar 에게 절대경로를 넘기지 않는다.**
       *
       * Git for Windows 가 길에 깔아두는 GNU tar 는 `C:\...` 의 콜론을
       * **원격 호스트로 읽는다** — `Cannot connect to C: resolve failed`.
       * 그래서 풀 자리를 cwd 로 주고 이름만 넘긴다. 콜론이 없으면
       * GNU 든 bsdtar 든 똑같이 도는다.
       */
      const why = await untar("_extra.tar.gz", into);
      await fsp.rm(tmp, { force: true });
      if (why !== undefined) {
        await fsp.rm(into, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, say: `푸는 데 실패했습니다 — ${why}` };
      }
      const inside = await fsp.readdir(into, { withFileTypes: true });
      const files = inside.filter((e) => e.isFile());
      if (files.length === 1) {
        await fsp.rename(path.join(into, files[0]!.name), path.join(dir, saveAs));
      } else {
        /* 여럿이면 모양을 안다고 못 하므로 그대로 옮긴다 */
        for (const e of inside) await fsp.rename(path.join(into, e.name), path.join(dir, e.name));
      }
      await fsp.rm(into, { recursive: true, force: true }).catch(() => undefined);
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
      /*
       * 🔴 **주소를 그대로 내보이면 화면에 주소가 뜨다** (2026-10-06).
       *
       * F5 로 보니 에이전트 칸에 `https://dl.google.com/…-1.3.0-windows-x86_64.zip`
       * 이 통째로 떠 있었다. 가리고 싶은 것은 **판**이지 주소가 아니다.
       * 주소 안에 판이 박혀 있으므로 거기서 뽑는다.
       */
      ...(got ? { version: versionIn(got) } : {}),
      wanted: versionIn(at.archive),
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

/** 답이 안 오면 여기서 포기한다 — 그동안 화면은 **알던 값**을 그대로 쓴다 */
const AUTH_MS = 20_000;

/**
 * ★ **켤 때 확인할 줄을 짠다 — 목록에서 저절로** (2026-10-13).
 *
 * 🔴 **손으로 적지 않는다.** 여기에 «claude, codex» 를 박아두면 에이전트를
 * 하나 더할 때마다 **두 군데**를 고쳐야 하고, 한쪽만 고치면 새 에이전트가
 * 조용히 확인에서 빠진다 — 빠진 줄은 **아무도 못 본다.**
 *
 * 그래서 판단은 **에이전트가 들고 있는 것**으로만 한다:
 *
 * ```
 * 안 받았다            줄이 없다. 로그인할 것도 없다
 * auth 가 없다          줄이 없다. 사용자가 직접 적은 에이전트다
 * auth.status 가 있다   **물어본다** — ask
 * auth.file 뿐          **파일만 본다** — 즉시 결판난다 (Antigravity)
 * ```
 *
 * 카탈로그에 `auth.status` 를 단 에이전트를 더하면 **여기도 저절로 는다.**
 */
export interface AuthPlan {
  id: string;
  label: string;
  /** `ask` 는 CLI 에게 묻는다. `file` 은 물어볼 길이 없어 파일만 본다 */
  how: "ask" | "file";
  /** `file` 일 때의 답 — 물어볼 것이 없으니 여기서 이미 끝난다 */
  guess: boolean;
}

export function authPlan(agents: AgentDef[], root: string, home: string): AuthPlan[] {
  const out: AuthPlan[] = [];
  for (const a of agents) {
    const auth = a.pkg?.auth;
    // 사용자가 `aiInOne.agents` 로 적은 것은 우리가 받지도, 로그인시키지도 않는다
    if (!auth) continue;
    // 안 받은 것은 로그인할 것이 없다 — 「설치하기」가 먼저다
    if (stateOf(a, root, home).state === "none") continue;
    out.push(
      auth.status
        ? { id: a.id, label: a.label, how: "ask", guess: false }
        : {
            id: a.id,
            label: a.label,
            how: "file",
            guess: fs.existsSync(path.join(home, auth.file)),
          },
    );
  }
  return out;
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
 *
 * ★ **기다리지 않는다 — 오면 알려달라고 한다** (2026-10-13).
 *
 * 🔴 여기가 `spawnSync` 였다. 부르는 쪽(`ChatPanel.authOf`)은 `setTimeout(…, 0)`
 * 으로 감싸두고 주석에 *"뒤에서 갱신한다"* 라고 적어뒀는데, **그건 이 스택에서
 * 비키는 것뿐**이다 — 콜백이 돌 때 `spawnSync` 가 **확장 호스트의 한 가닥을
 * 통째로 붙잡는다.** 그동안 우리 창도 git 도 명령 팔레트도 안 움직인다.
 *
 * ```
 * 이 기계 실측   claude 307~411ms · codex 70~125ms  (win32 는 cmd.exe 한 장 포함)
 * 최악           둘이 각각 AUTH_MS 를 다 쓰면 **직렬로 40초**
 * 닿는 길        창 열기 · 15초마다 · 로그인 직후 — 전부 사용자가 누르는 길
 * ```
 *
 * 평소 0.5초라 티가 안 나는 것이 더 나쁘다 — **안 될 때만** 40초가 된다.
 * 같은 날 `sweepStrays`(23~30초)를 고치고도 이쪽을 두면 반만 고친 것이다.
 */
export function authStatus(
  dir: string,
  cmd: AgentCmd & { yes: string },
): Promise<{ loggedIn: boolean } | undefined> {
  const found = cmdPath(dir, cmd);
  if (!found) return Promise.resolve(undefined);

  return new Promise((done) => {
    let out = ""; let err = "";
    let settled = false;
    /** 늦으면 **그냥 포기한다** — `undefined` 는 «못 물어봤다» 라 쓰던 값이 남는다 */
    const give = (r: { loggedIn: boolean } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 이미 죽었으면 그만 */ }
      give(undefined);
    }, AUTH_MS);
    try {
      child = spawn(found.exe, found.args, {
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch { give(undefined); return; }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { out += c; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => { err += c; });
    child.on("error", () => give(undefined));
    child.on("close", () => {
      // **모아서 한 번에 본다** — 두 흘림이 섞여 들어오면 표시가 갈릴 수 있다
      const said = `${out}${NEWLINE}${err}`;
      give(said.trim() ? { loggedIn: said.includes(cmd.yes) } : undefined);
    });
  });
}

const NEWLINE = String.fromCharCode(10);

/**
 * ★ **`tar` 로 푸는 것도 비동기로** (2026-10-13).
 *
 * 🔴 여기가 `spawnSync` 였다. **윈도우에서는 영영 안 타는 길**이라
 * (`.zip` 은 우리 `unzip` 이 푼다) 개발 기계에서 **한 번도 안 드러난다** —
 * 그런데 mac·linux 에서는 「설치하기」의 **진짜 경로**다. Node 를 그렇게
 * 푼다. P6 이 못으로 박는 바로 그 모양이다: *한쪽만 보고 넘어가면 다른 쪽
 * 사람들만 멈추고, 우리는 그걸 볼 길이 없다.*
 *
 * `unzip` 과 달리 일을 **남의 프로세스가** 하므로 `spawn` 으로 족하다 —
 * 안을 다시 짤 것이 없다.
 *
 * @returns 됐으면 `undefined`, 아니면 사람에게 보일 한 줄
 */
function untar(file: string, cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    let err = "";
    let settled = false;
    const give = (why: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(why);
    };
    let child: ReturnType<typeof spawn>;
    /* 늦으면 포기한다 — 멎은 `tar` 를 영영 기다리면 받기가 통째로 걸린다 */
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 이미 갔으면 그만 */ }
      give("푸는 데 너무 오래 걸립니다");
    }, UNTAR_MS);
    try {
      /* 🔴 절대경로를 넘기지 않는다 — 아래 호출부의 주석(§G5) */
      child = spawn("tar", ["-xzf", file], { cwd, windowsHide: true });
    } catch (e) { give(describeErr(e)); return; }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => { err += c; });
    child.on("error", (e) => give(describeErr(e)));
    child.on("close", (code) => give(code === 0 ? undefined : err.trim() || `tar 가 ${code} 로 끝났습니다`));
  });
}

/** 푸는 데 이보다 오래 걸리면 뭔가 잘못된 것이다 */
const UNTAR_MS = 180_000;

const describeErr = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `npm` 한 번 — 밖에서 갈아끼울 수 있게 빼둔다 */
// ── Node ─────────────────────────────────────────────────────────────────

/*
 * ★ **Node 도 우리가 받아둔다** (2026-10-07) — 까닭은 `agentCatalog.NODE_PIN`.
 *
 * 자리는 에이전트 옆이 아니라 **따로**다. 에이전트가 아니고 **여럿이 같이
 * 쓰므로** `agents/` 안에 두면 «어느 에이전트의 것» 처럼 보인다. 버려진
 * 프로세스를 쓸어담는 `sweepStrays` 도 `agents/` 만 본다.
 *
 * ```
 * <globalStorage>/node/current/        ← 푼 것. 판이 바뀌면 통째로 갈아끼운다
 * <globalStorage>/node/aio-node.json   ← 무슨 판을 받았나
 * ```
 */
const NODE_MARK = "aio-node.json";

/** 받아둔 Node 가 사는 자리 */
export function nodeHome(root: string): string {
  return path.join(root, "node", "current");
}

/**
 * `node`·`npm` 이 들어 있는 칸.
 *
 * ⚠️ **판마다 다르다.** 윈도우는 푼 자리 바로 밑에 `node.exe`·`npm.cmd` 가
 * 있고, 그 밖은 `bin/` 아래다. 한쪽만 보고 짜면 **반대쪽에서 조용히 못 찾는다.**
 */
export function nodeBinDir(root: string): string {
  const home = nodeHome(root);
  return process.platform === "win32" ? home : path.join(home, "bin");
}

/** 받아둔 Node 가 쓸 만한가 — 판이 맞고 실행파일이 있나 */
export function haveNode(root: string): boolean {
  try {
    const mark = JSON.parse(
      fs.readFileSync(path.join(root, "node", NODE_MARK), "utf8")) as { version?: string };
    if (mark.version !== NODE_PIN.version) return false;
  } catch { return false; }
  const exe = process.platform === "win32" ? "node.exe" : "node";
  return fs.existsSync(path.join(nodeBinDir(root), exe));
}

/**
 * ★ **받아둔 Node 를 길 맨 앞에 세운 환경**을 만든다.
 *
 * npm 이 만드는 `.bin/<이름>.cmd` 껍데기는 제 옆에 `node.exe` 가 없으면
 * **PATH 의 `node` 로 떨어진다**(껍데기 안을 열어보면 그렇게 적혀 있다).
 * 그래서 경로를 앞에 세우기만 하면 **껍데기를 손대지 않고도** 우리 Node 가
 * 걸린다.
 *
 * 안 받아뒀으면 아무것도 안 한다 — 그때는 사용자 것이 쓰인다.
 */
export function nodeEnv(root: string): Record<string, string> {
  if (!haveNode(root)) return {};
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { [key]: nodeBinDir(root) + path.delimiter + (process.env[key] ?? "") };
}

/**
 * 없거나 낡았으면 받는다. 돌려주는 것은 **쓸 수 있게 됐나**.
 *
 * 🔴 **막지 않는다.** 못 받아도 사용자 기계에 Node 가 있으면 그걸로 돌아간다 —
 * 여기서 던지면 **원래 되던 사람까지 막는 셈**이다.
 */
export async function ensureNode(
  root: string,
  onLine?: (line: string) => void,
): Promise<boolean> {
  if (haveNode(root)) return true;
  const at = NODE_PIN.at[hostKey()];
  if (!at) return false;

  const base = path.join(root, "node");
  try {
    onLine?.(`Node ${NODE_PIN.version} 를 받는 중…`);
    const res = await fetch(at.url);
    if (!res.ok) { onLine?.(`Node 를 받지 못했습니다 — HTTP ${res.status}`); return false; }
    const buf = Buffer.from(await res.arrayBuffer());

    /* 🔴 nodejs.org 는 sha256 을 준다 — 에이전트 쪽(sha512)과 다르다 */
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== at.sha256) { onLine?.("Node 가 온전하지 않습니다 — 해시가 다릅니다"); return false; }

    await remove(base).catch(() => undefined);
    await fsp.mkdir(base, { recursive: true });
    onLine?.("Node 를 푸는 중…");

    const isZip = at.url.endsWith(".zip");
    const tmp = path.join(base, isZip ? "_node.zip" : "_node.tar.gz");
    await fsp.writeFile(tmp, buf);
    if (isZip) {
      await unzip(tmp, base);
    } else {
      /* 절대경로를 넘기면 GNU tar 가 콜론을 원격 호스트로 읽는다 (§G5) */
      const why = await untar(path.basename(tmp), base);
      if (why !== undefined) { onLine?.(`Node 를 풀지 못했습니다 — ${why}`); return false; }
    }
    await fsp.rm(tmp, { force: true });

    /*
     * 푼 것은 `node-v24.21.0-win-x64/` 처럼 **판과 플랫폼이 박힌 이름**이다.
     * 그대로 두면 판을 올릴 때마다 경로가 바뀐다 — `current` 로 바꿔 단다.
     */
    const inside = (await fsp.readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("node-v"));
    if (inside.length !== 1) { onLine?.(`푼 모양이 뜻밖입니다 (${inside.length}개)`); return false; }
    await fsp.rename(path.join(base, inside[0]!.name), nodeHome(root));

    await fsp.writeFile(
      path.join(base, NODE_MARK), JSON.stringify({ version: NODE_PIN.version }), "utf8");
    return haveNode(root);
  } catch (err) {
    onLine?.(`Node 를 받지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export type Run = (
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
  /** 받아둔 Node 를 길 앞에 세우려고 넘긴다 (`nodeEnv`) */
  env?: Record<string, string>,
) => Promise<{ code: number; say: string }>;

export const realNpm: Run = (args, cwd, onLine, env) =>
  new Promise((done) => {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const p = spawn(cmd, args, {
      cwd, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"],
      /*
       * ★ **받아둔 Node 가 있으면 그걸 먼저 본다** (2026-10-07).
       *
       * `npm.cmd` 를 이름으로 부르므로 **PATH 가 정한다.** 앞에 우리
       * 칸을 세우면 사용자 기계에 Node 가 없어도 받을 수 있다.
       */
      ...(env ? { env: { ...process.env, ...env } } : {}),
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
  /*
   * ★ **받을 때도 옆에 치워둔 것을 쓸어담는다** (2026-10-07).
   *
   * 지울 때 떠 있으면 이름만 바꿔 치워둔다(`remove`). 그걸 쓸어담는
   * 자리가 지우기 안에만 있었다 — 다시 안 지우면 **81MB 가 그대로
   * 남는다.** 진짜로 하나 남아 있는 걸 보고 옮긴다. 받기 전이면
   * 뵙잡고 있던 프로세스도 끌나 있을 때라 지워질 확률도 높다.
   */
  await sweepOld(path.dirname(dir));
  const was = statusOf(dir, pkg);
  if (was.installed && !was.stale) return { ok: true, say: "이미 받아져 있습니다" };

  /* zip 꼴은 npm 을 안 부른다 — 받아서 푸는 것이 전부다 */
  const at = pickBinary(pkg);
  if (at) {
    return fetchBinary(dir, at, pkg.extras ?? [], onLine);
  }

  /*
   * 🔴 **npm 꼴은 Node 가 있어야 받는다** (2026-10-07).
   *
   * 사용자가 짚었다 — *"노드 20은 이거 깔릴때 같이 깔리게는 못해?"*.
   * CLI 를 안 깔아도 된다고 해놓고 Node 는 깔라고 하는 것은 앞뒤가 안
   * 맞는다. 받는 자리는 에이전트 옆이 아니라 따로다(`node/`).
   *
   * ⚠️ 못 받아도 **멈추지 않는다.** 사용자 기계에 Node 가 있으면
   * 그걸로 돌아간다 — 여기서 던지면 원래 되던 사람까지 막는 셔이다.
   */
  const root = path.dirname(path.dirname(dir));
  await ensureNode(root, onLine);

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "package.json"), manifestFor(pkg), "utf8");

  /*
   * `--no-audit --no-fund` 는 말수를 줄이려는 것이고, `--install-strategy=hoisted`
   * 는 `.bin` 이 **우리가 아는 자리**에 생기게 한다. 기본값이 바뀌어도
   * `node_modules/.bin/<이름>` 을 그대로 쓸 수 있어야 한다.
   */
  const r = await run(
    ["install", "--no-audit", "--no-fund", "--install-strategy=hoisted"],
    dir, onLine, nodeEnv(root));

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

/** 프로세스 표 한 줄. 플랫폼마다 긁는 법이 달라 모양만 맞춘다 */
export interface ProcRow { pid: number; ppid: number; path: string }

/**
 * ★ **버려진 것을 가려낸다** (2026-10-07).
 *
 * 🔴 사용자가 짚었다 — *"다른 애들도 이전게 남아있는지 확인해야될듯? 이거
 * 쌓이면 안되지"*. 세어보니 **Antigravity 27개 · 581MB** 였다.
 *
 * ```
 * agy_acp_server.exe         20개
 * localharness_external.exe   6개
 * agy.exe                     1개
 * ```
 *
 * 까닭은 **F5** 다. 확장 호스트가 죽을 때 `dispose` 가 못 돌고, 우리가 띄운
 * 서버는 그대로 산다. Claude·Codex 는 stdin 이 닫히면 알아서 끝나는데
 * Antigravity 의 파이썬 서버는 **안 끝난다.** 그래서 한쪽만 쌓였다.
 *
 * ⚠️ **창이 여럿일 수 있다.** globalStorage 는 창끼리 나눠 쓰므로 «우리 자리에서
 * 나온 것» 을 전부 죽이면 **옆 창이 쓰고 있는 것까지 죽인다.** 그래서 기준은
 * «우리 것이냐» 가 아니라 **«부모가 살아 있느냐»** 다 — 옆 창의 것은 그 창의
 * 확장 호스트가 부모로 살아 있다.
 *
 * 돌려주는 것은 **나무의 뿌리들**이다. 자식은 부모가 살아 있으니 안 걸리는데,
 * 뿌리를 나무째 죽이면 같이 간다.
 */
export function straysIn(rows: ProcRow[], root: string): number[] {
  const live = new Set(rows.map((r) => r.pid));
  const at = root.toLowerCase();
  return rows
    .filter((r) => r.path.toLowerCase().startsWith(at) && !live.has(r.ppid))
    .map((r) => r.pid);
}

/** 지금 도는 것들을 긁는다. 못 긁으면 빈 배열 — 치우기가 일을 막으면 안 된다 */
/**
 * 🔴 **동기로 돌리면 확장 호스트가 통째로 선다** (2026-10-13 실측).
 *
 * ```
 * powershell -Command 1                  3,658ms   ← 아무것도 안 해도
 * Get-CimInstance Win32_Process         40,000ms   ← 타임아웃에 걸린다
 * sweepStrays() 한 판                23,000~30,000ms
 * ```
 *
 * 이게 `activate` 길 위에서 `spawnSync` 로 돌고 있었다. 창이 안 뜨고,
 * 명령이 «없는 명령» 이 되고, **옆 확장까지 같이 선다** — 확장 호스트는
 * 한 가닥이기 때문이다.
 *
 * 그래서 **비동기로 바꾸고**, 부르는 쪽은 **켜기 길에서 비켰다**.
 * 기다리는 시간도 줄였다 — 이건 **청소**지 켜기의 조건이 아니다.
 */
const PROC_LIST_MS = 10_000;

function procRows(): Promise<ProcRow[]> {
  const win = process.platform === "win32";
  const cmd = win ? "powershell" : "ps";
  const args = win
    ? ["-NoProfile", "-NonInteractive", "-Command",
       "Get-CimInstance Win32_Process | " +
       "Where-Object { $_.ExecutablePath } | " +
       "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.ExecutablePath }"]
    : ["-eo", "pid=,ppid=,args="];

  return new Promise<ProcRow[]>((done) => {
    let out = "";
    let settled = false;
    /** 늦으면 **그냥 포기한다** — 못 쓸어담아도 나머지는 돌아가야 한다 */
    const give = (rows: ProcRow[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(rows);
    };
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 이미 죽었으면 그만 */ }
      give([]);
    }, PROC_LIST_MS);
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch { give([]); return; }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { out += c; });
    child.on("error", () => give([]));
    child.on("close", () => give(win
      ? parseRows(out, "|")
      : out.split(NEWLINE).flatMap((line) => {
          const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), path: m[3]! }] : [];
        })));
  });
}

function parseRows(out: string, sep: string): ProcRow[] {
  return out.split(NEWLINE).flatMap((line) => {
    const bits = line.trim().split(sep);
    if (bits.length < 3) return [];
    const pid = Number(bits[0]); const ppid = Number(bits[1]);
    if (!pid) return [];
    return [{ pid, ppid, path: bits.slice(2).join(sep) }];
  });
}

/** 그 나무를 통째로 내린다 */
/**
 * 🔴 **이것도 동기였다** (2026-10-13).
 *
 * 목록 뜨는 것만 비동기로 바꿔놓고 **죽이는 쪽을 두면 반만 고친 것**이다 —
 * 2026-10-07 에는 버려진 것이 **27개**였고, 그러면 `taskkill` 을 **스물일곱
 * 번 동기로** 띄운다. 한 번에 수백 ms 씩만 잡아도 확장 호스트가 몇 초를
 * 선다. 창을 막던 것을 뒤로 옮겨놓고 **거기서 똑같이 막는** 꼴이다.
 *
 * ⚠️ **기다리기는 한다.** 부르는 쪽(`remove`)이 **죽은 다음에** 파일을
 * 지우기 때문이다 — 안 기다리면 아직 붙들고 있는 파일을 지우려다 `EBUSY` 다.
 */
const KILL_MS = 15_000;

function killPid(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* 이미 죽었으면 말고 */ }
    return Promise.resolve();
  }
  return new Promise<void>((done) => {
    let settled = false;
    const give = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    };
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 이미 갔으면 말고 */ }
      give();
    }, KILL_MS);
    try {
      child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch { give(); return; }
    child.on("error", give);
    child.on("close", give);
  });
}

/**
 * 🔴 **지우기 전에 먼저 내린다** (2026-10-07).
 *
 * 사용자: *"제거할때 무시하고 제거는 안되나? kill 때리고 하는 느낌"*. 맞다.
 * 도는 것을 지울 수는 없는데, **지우겠다고 누른 사람에게 «그 CLI 를 끄고
 * 다시 해보세요» 라고 하는 것**은 할 일을 떠넘기는 것이다. 어차피 지울
 * 것이니 우리가 내린다.
 *
 * 여기서는 **부모가 살아 있든 말든** 그 자리에서 나온 것을 전부 내린다 —
 * 지우려는 자리라 살려둘 까닭이 없다.
 */
export async function killUnder(dir: string): Promise<number> {
  const at = path.resolve(dir).toLowerCase();
  const hit = (await procRows()).filter((r) => r.path.toLowerCase().startsWith(at));
  // **한꺼번에 내린다** — 하나씩 기다리면 스물일곱 번이 줄줄이 더해진다
  await Promise.all(hit.map((r) => killPid(r.pid)));
  return hit.length;
}

/**
 * 버려진 것만 내린다. 돌려주는 것은 내린 수.
 *
 * 받는 것은 **globalStorage 자리**다 — 그 안의 `agents/` 는 여기서 찾는다.
 * 자리 모양을 아는 것은 `dirFor` 와 같은 한 집이어야 한다.
 */
export async function sweepStrays(root: string): Promise<number> {
  const at = path.join(path.resolve(root), "agents");
  const pids = straysIn(await procRows(), at);
  // **한꺼번에 내린다** — 하나씩 기다리면 스물일곱 번이 줄줄이 더해진다
  await Promise.all(pids.map((pid) => killPid(pid)));
  return pids.length;
}

/** 지운다 — **우리 자리라서** 마음대로 지울 수 있다 */
export async function remove(dir: string): Promise<void> {
  /*
   * 🔴 **떠 있는 실행파일은 윈도우에서 못 지운다** (2026-10-06).
   *
   * 사용자가 밟았다 — Antigravity 를 지웠다가 다시 깔려는데:
   *
   * ```
   * EBUSY: resource busy or locked, open '…gy_acp_server.exe'
   * ```
   *
   * 지우기가 `agy.exe` 는 지우고 서버에서 막혔고, **반만 지워진 자리** 위에
   * 다시 풀려다 터진 것이다. 붙잡고 있던 것은 우리가 안 띄운 프로세스였다
   * (그 CLI 가 제 손으로 띄운 것). 남이 띄운 것을 우리가 죽일 수는 없다.
   *
   * ★ **그런데 못 지우는 것과 못 비우는 것은 다르다.** 윈도우는 떠 있는
   * 파일도 **이름은 바꾸게 해준다.** 그러니 치울 수 없으면 **옆으로 치운다** —
   * 자리가 비므로 다시 깔 수 있고, 치우다 만 것은 다음에 쓸어 담는다.
   */
  await sweepOld(path.dirname(dir));

  /*
   * 🔴 **먼저 내린다.** 사용자: *"제거할때 무시하고 제거는
   * 안되나? kill 때리고 하는 느낌"*. 맞다 — 지우겠다고 누른 사람에게
   * «그 CLI 를 끄고 다시 해보세요» 는 할 일을 떠넘기는 것이다.
   */
  const downed = await killUnder(dir);
  if (downed > 0) await new Promise((r) => setTimeout(r, 300));

  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }

  /* 못 지우면 옆으로 — 이름만 바꿔도 **자리는 비워진다** */
  const aside = `${dir}.old-${Date.now()}`;
  try {
    await fsp.rename(dir, aside);
  } catch {
    throw new Error(
      `지우지 못했습니다 — 아직 돌고 있는 것이 있습니다. ` +
      `그 CLI 를 끄고 다시 해보세요. (${last instanceof Error ? last.message : String(last)})`);
  }
  /* 옆으로 치운 것도 지워보되, 안 되면 그냥 둔다 — 자리는 이미 비었다 */
  await fsp.rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * 옆으로 치워뒀던 것들을 쓸어 담는다.
 *
 * 붙잡고 있던 프로세스가 그 사이 끝났으면 이제 지워진다. 안 지워져도
 * 그냥 넘어간다 — **치우기가 설치를 막으면 안 된다.**
 */
async function sweepOld(parent: string): Promise<void> {
  let names: string[];
  try { names = await fsp.readdir(parent); } catch { return; }
  for (const n of names) {
    if (!n.includes(".old-")) continue;
    await fsp.rm(path.join(parent, n), { recursive: true, force: true }).catch(() => undefined);
  }
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
  /*
   * 🔴 **지우는 명령도 같이 갈아끼운다** (2026-10-07).
   *
   * 여기서 `command`·`args` 만 바꿔었다. 그래서 `purgeSession` 은 카탈로그에
   * 적힌 `npx -y …` 그대로 남아, 방을 나갈 때마다 **받아둔 codex.exe 를 두고
   * npx 가 따로 받은 판**을 돌렸다. 사용자가 지우는 로직을 다시 보자고
   * 해서 나왔다.
   */
  const purge = agent.pkg.purge ? cmdPath(dir, agent.pkg.purge) : undefined;
  return {
    ...agent,
    command: s.command,
    args: s.args,
    /*
     * ★ **받아둔 Node 를 길 앞에 세운다** (2026-10-07).
     *
     * npm 꼴은 `.bin/<이름>.cmd` 껍데기로 뜨는데, 그 안은 제 옆에
     * `node.exe` 가 없으면 **PATH 의 `node` 로 떨어진다.** 그래서 경로만
     * 앞에 세우면 **껍데기를 손대지 않고** 우리 것이 걸린다.
     */
    env: { ...nodeEnv(root), ...agent.env, ...s.env },
    ...(purge ? { purgeSession: { command: purge.exe, args: purge.args } } : {}),
  };
}
