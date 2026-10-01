import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn } from "node:child_process";
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
  const { name, version } = splitSpec(pkg.spec);
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
  const { name, version } = splitSpec(pkg.spec);
  let have: string | undefined;
  try {
    const raw = fs.readFileSync(
      path.join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8");
    have = (JSON.parse(raw) as { version?: string }).version;
  } catch { /* 없으면 안 받아진 것 */ }

  const ready = have !== undefined && fs.existsSync(binPath(dir, pkg.bin));
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
  const env: Record<string, string> = {};
  if (pkg.exeEnv) env[pkg.exeEnv.name] = binPath(dir, pkg.exeEnv.bin);
  return { command: binPath(dir, pkg.bin), args: [], env };
}

/**
 * `AgentCmd` 를 실제 경로로.
 *
 * `bin` 은 `.bin` 에서, `find` 는 꺼리 안에서 찾는다. 둘 다 없거나 못
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
  await fsp.rm(dir, { recursive: true, force: true });
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
 * 플랫폼별 꺼리 이름이 달라서 필요하다 — `claude-agent-sdk-win32-x64` 와
 * `-darwin-arm64` 가 같은 자리를 차지한다. npm 이 `os`/`cpu` 로 골라 하나만
 * 받으므로 **거기 있는 하나**를 찾으면 된다.
 */
export function findOne(dir: string, pattern: string): string | undefined {
  let at = [dir];
  for (const seg of pattern.split("/")) {
    const next: string[] = [];
    for (const base of at) {
      if (!seg.includes("*")) {
        const full = path.join(base, seg);
        if (fs.existsSync(full)) next.push(full);
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
  if (!statusOf(dir, agent.pkg).installed) return agent;
  const s = spawnSpecFor(dir, agent.pkg);
  return { ...agent, command: s.command, args: s.args, env: { ...agent.env, ...s.env } };
}
