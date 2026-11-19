/**
 * ★ **디스크 정리** (2026-11-19).
 *
 * 사용자: *"캐시 정리할 수 있는 기능 넣을 수 있나?"* — 리눅스 서버에서 사용자 할당량이
 * 차서 저장이 막힌 뒤에 나왔다. 이 기계에서 재보니 큰 것은 **우리 자리가 아니었다**:
 *
 * ```
 * agents/          972MB   우리 것 · 쓰는 중
 * node/            107MB   우리 것 · 쓰는 중
 * npm-cache/_cacache   3.7GB   npm 이 받은 것을 모아두는 곳 — 모두가 같이 쓴다
 * npm-cache/_npx       6.6GB   npx 가 받은 것 — 우리가 npx 를 쓰던 때와 남들의 것
 * ```
 *
 * `_cacache` 가 커지는 까닭은 우리다 — `npm install` 이 받은 것을 **한 벌씩 남기고**,
 * 핀을 올릴 때마다 수백 MB 가 더 쌓였다. 그건 `install` 이 따로 된 캐시를 쓰고 끝에 지우게
 * 해서 막았다(`ownCacheFor`). 이 파일은 **이미 쌓인 것**을 보여주고 치운다.
 *
 * 🔴 **남의 자리는 묻고 지운다.** npm·npx 캐시는 다른 편집기와 사용자 자신의 npm 도
 * 쓴다. 지워도 고장 나지는 않지만(필요하면 다시 받는다) 그 판단은 사용자가 한다 —
 * `shared` 가 그 표시다. 확인은 부르는 쪽(`ChatPanel`)이 받는다.
 *
 * ⚠️ **재는 것도 비동기다.** `_cacache` 는 파일이 수만 개라 `sizeOf`(동기)로 재면
 * 확장 호스트가 그동안 멈춘다.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { nodeEnv, ownCacheRoot, realNpm, type Run } from "./agentInstaller.js";

export type SpotId = "agents" | "node" | "leftover" | "npmCache" | "npx";

export interface Spot {
  id: SpotId;
  /** 사람에게 보이는 이름 */
  label: string;
  /** 어디인가 — 화면에 그대로 찍는다 */
  where: string;
  /** 지우면 실제로 지울 것들 */
  paths: string[];
  bytes: number;
  /** 다른 프로그램도 쓰는 자리 — 지우기 전에 묻는다 */
  shared: boolean;
  /** 지우는 단추를 다나 — 쓰는 중인 것은 위의 「제거」로만 지운다 */
  canClean: boolean;
}

/**
 * ★ **이만큼 묵은 것만 찌꺼기로 본다.** 옆 창이 지금 받고 있는 자리(npm 캐시, 푸는 중인
 * Node)를 지우면 **그 받기가 깨진다.** 받기는 몇 분이면 끝나므로 한 시간이면 넉넉하다.
 */
export const LEFTOVER_AGE_MS = 60 * 60 * 1000;

/**
 * npm 이 모아두는 곳의 기본값 — npm 에게 못 물어봤을 때 쓴다.
 *
 * ⚠️ **OS 마다 다르다.** 윈도우는 `%LOCALAPPDATA%\npm-cache`, 그 밖은 `~/.npm`.
 * 환경변수 `npm_config_cache` 가 있으면 그것이 이긴다(npm 의 규칙과 같다).
 */
export function defaultNpmCache(
  env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform,
): string {
  const set = Object.keys(env).find((k) => k.toLowerCase() === "npm_config_cache");
  if (set && env[set]) return env[set]!;
  if (platform === "win32") {
    return path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "npm-cache");
  }
  return path.join(home, ".npm");
}

/**
 * ★ **npm 에게 묻는다** — 사용자가 `.npmrc` 로 옮겨뒀을 수 있다. 기본값만 믿으면
 * 엉뚱한 곳을 «0MB» 라고 보여준다.
 *
 * 10초 안에 답이 없거나, 답이 절대경로가 아니면 기본값을 쓴다.
 */
export async function npmCacheDir(
  root: string, home: string, run: Run = realNpm,
): Promise<string> {
  const fallback = defaultNpmCache(process.env, home, process.platform);
  const asked = run(["config", "get", "cache"], root, undefined, nodeEnv(root))
    .catch(() => undefined);
  const late = new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000).unref());
  const got = await Promise.race([asked, late]);
  if (!got || got.code !== 0) return fallback;
  const line = got.say.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  return line && path.isAbsolute(line) ? line : fallback;
}

/** 그 자리가 얼마나 먹고 있나 — 비동기로, 한 번에 너무 많이 열지 않게 */
export async function duOf(at: string): Promise<number> {
  let st;
  try { st = await fsp.lstat(at); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let names: string[];
  try { names = await fsp.readdir(at); } catch { return 0; }
  let total = 0;
  for (let i = 0; i < names.length; i += 64) {
    const part = await Promise.all(names.slice(i, i + 64).map((n) => duOf(path.join(at, n))));
    for (const b of part) total += b;
  }
  return total;
}

async function oldEnough(at: string, now: number): Promise<boolean> {
  try { return now - (await fsp.stat(at)).mtimeMs > LEFTOVER_AGE_MS; } catch { return false; }
}

/**
 * **우리 자리의 찌꺼기** — 지우다 남은 옛 판, 받다 남은 캐시와 Node 임시 파일.
 *
 * ```
 * agents/<id>.old-<시각>        못 지워서 옆으로 치워둔 것 (`remove`)
 * npm-cache/<id>                받다 말고 끊겨 남은 우리 캐시
 * node/_node-<pid>.zip|tar.gz   받다 끊긴 Node 압축파일
 * node/node-v…                  풀어놓고 이름을 못 바꾼 것
 * ```
 */
export async function leftovers(root: string, now = Date.now()): Promise<string[]> {
  const out: string[] = [];
  const scan = async (dir: string, pick: (n: string) => boolean): Promise<void> => {
    let names: string[];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const n of names) {
      const at = path.join(dir, n);
      if (pick(n) && await oldEnough(at, now)) out.push(at);
    }
  };
  await scan(path.join(root, "agents"), (n) => n.includes(".old-"));
  await scan(ownCacheRoot(root), () => true);
  await scan(path.join(root, "node"), (n) => n.startsWith("_node-") || n.startsWith("node-v"));
  return out;
}

/** 어디에 무엇이 얼마나 있나 — 화면에 그대로 내보낸다 */
export async function survey(root: string, npmCache: string, now = Date.now()): Promise<Spot[]> {
  const left = await leftovers(root, now);
  const sum = async (ps: string[]): Promise<number> =>
    (await Promise.all(ps.map(duOf))).reduce((a, b) => a + b, 0);

  const agents = path.join(root, "agents");
  const node = path.join(root, "node", "current");
  const cacache = path.join(npmCache, "_cacache");
  const npx = path.join(npmCache, "_npx");
  return [
    {
      id: "agents", label: "받아둔 에이전트", where: agents, paths: [],
      bytes: (await duOf(agents)) - (await sum(left.filter((p) => p.startsWith(agents + path.sep)))),
      shared: false, canClean: false,
    },
    {
      id: "node", label: "같이 받은 Node", where: node, paths: [],
      bytes: await duOf(node), shared: false, canClean: false,
    },
    {
      id: "leftover", label: "받다·지우다 남은 것", where: root, paths: left,
      bytes: await sum(left), shared: false, canClean: true,
    },
    {
      id: "npmCache", label: "npm 캐시", where: cacache, paths: [cacache],
      bytes: await duOf(cacache), shared: true, canClean: true,
    },
    {
      id: "npx", label: "npx 캐시", where: npx, paths: [npx],
      bytes: await duOf(npx), shared: true, canClean: true,
    },
  ];
}

/**
 * 지운다. 돌려주는 것은 **실제로 비운 바이트**와 **못 지운 것의 수**.
 *
 * ★ **한 덩어리씩 지운다.** `_npx` 안의 어느 하나를 다른 프로그램이 띄워 쓰고 있으면
 * (윈도우는 도는 실행파일을 못 지운다) 통째 `rm` 은 거기서 멈춘다 — 나머지까지 남는다.
 * 한 칸씩 지우면 **쓰는 것만 남고** 나머지는 비워진다.
 */
export async function sweep(paths: readonly string[]): Promise<{ freed: number; kept: number }> {
  let freed = 0;
  let kept = 0;
  const one = async (at: string): Promise<void> => {
    const size = await duOf(at);
    try {
      await fsp.rm(at, { recursive: true, force: true });
      freed += size;
    } catch {
      freed += Math.max(0, size - await duOf(at));
      kept++;
    }
  };
  for (const p of paths) {
    let names: string[] | undefined;
    try {
      if ((await fsp.lstat(p)).isDirectory()) names = await fsp.readdir(p);
    } catch { continue; }
    if (names === undefined) { await one(p); continue; }
    for (const n of names) await one(path.join(p, n));
    await fsp.rmdir(p).catch(() => undefined);
  }
  return { freed, kept };
}
