/**
 * **디스크 정리** (2026-11-19) — `src/core/install/cleanup.ts`.
 *
 * 사용자: *"캐시 정리할 수 있는 기능 넣을 수 있나?"*. 재는 것:
 *
 * ```
 * ① 받을 때 npm 이 **우리 캐시**를 쓰고, 끝나면 지운다      ← 더 안 쌓인다
 * ② 찌꺼기는 **묵은 것만** 찌꺼기다                       ← 옆 창이 받는 중인 것을 안 지운다
 * ③ 쓰는 중인 것(에이전트·Node)은 지우는 칸이 아니다
 * ④ npm·npx 캐시는 «남의 자리» 로 표시된다                ← 확장이 한 번 더 묻는다
 * ⑤ 지우기는 한 칸씩 — 하나가 잠겨도 나머지는 비워진다
 * ⑥ npm 캐시 자리 — OS 마다 기본값, 환경변수가 이긴다, npm 에게 물은 답을 쓴다
 * ```
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import {
  defaultNpmCache, duOf, leftovers, LEFTOVER_AGE_MS, npmCacheDir, survey, sweep,
} from "../src/core/install/cleanup.js";
import { dirFor, install, nodeBinDir, ownCacheFor, type Run } from "../src/core/install/agentInstaller.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { NODE_PIN } from "../src/core/install/nodePin.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const put = (p: string, bytes: number): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
};
const age = (p: string, ms: number): void => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
};

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-clean-"));

  console.log("\n[★ 받을 때 npm 은 우리 캐시를 쓰고, 끝나면 지운다]");
  {
    /* 따로 된 자리 — 아래 찌꺼기 검사의 크기가 섞이지 않게 */
    const own = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-clean-own-"));
    /* Node 는 받아진 척 — 안 그러면 install 이 nodejs.org 에서 진짜로 받는다 */
    fs.mkdirSync(path.join(own, "node"), { recursive: true });
    fs.writeFileSync(path.join(own, "node", "aio-node.json"), JSON.stringify({ version: NODE_PIN.version }));
    put(path.join(nodeBinDir(own), process.platform === "win32" ? "node.exe" : "node"), 1);
    const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
    const dir = dirFor(own, claude.id);
    const want = ownCacheFor(own, claude.id);
    let seen: string | undefined;
    let existedDuring = false;
    const fake: Run = async (_args, _cwd, _on, env) => {
      seen = env?.["npm_config_cache"];
      put(path.join(want, "_cacache", "blob"), 1000);
      existedDuring = fs.existsSync(want);
      return { code: 1, say: "가짜는 아무것도 안 받는다" };
    };
    await install(dir, claude.pkg!, fake);
    ok(seen === want, `★ npm_config_cache 가 우리 자리다 (${seen})`);
    ok(existedDuring && !fs.existsSync(want), "★ **받기가 끝나면 그 캐시는 없다** — 실패해도");

    const boom: Run = async () => { put(path.join(want, "x"), 10); throw new Error("터졌다"); };
    await install(dir, claude.pkg!, boom).catch(() => undefined);
    ok(!fs.existsSync(want), "★ npm 이 던져도 캐시는 지운다");
    await fsp.rm(own, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("\n[★ 찌꺼기는 묵은 것만 — 옆 창이 받는 중인 것은 안 건드린다]");
  {
    const oldAside = path.join(root, "agents", "codex.old-1700000000000");
    const freshAside = path.join(root, "agents", "codex.old-1800000000000");
    const oldCache = path.join(root, "npm-cache", "codex");
    const freshCache = path.join(root, "npm-cache", "claude");
    const oldZip = path.join(root, "node", "_node-123.zip");
    const oldUnpacked = path.join(root, "node", "node-v24.0.0-win-x64");
    const current = path.join(root, "node", "current");
    put(path.join(oldAside, "a.bin"), 2000);
    put(path.join(freshAside, "a.bin"), 2000);
    put(path.join(oldCache, "_cacache", "b"), 3000);
    put(path.join(freshCache, "_cacache", "b"), 3000);
    put(oldZip, 500);
    put(path.join(oldUnpacked, "node.exe"), 700);
    put(path.join(current, "node.exe"), 4000);
    put(path.join(root, "agents", "codex", "node_modules", "x.js"), 6000);
    const over = LEFTOVER_AGE_MS + 60_000;
    for (const p of [oldAside, oldCache, oldZip, oldUnpacked, current]) age(p, over);

    const left = (await leftovers(root)).map((p) => path.relative(root, p)).sort();
    console.log(`   ${left.join(" · ")}`);
    ok(left.length === 4, "★ 묵은 넷만 찌꺼기다");
    ok(!left.some((p) => p.includes("1800000000000") || p.endsWith("claude")),
       "★ **방금 생긴 것은 안 고른다** — 옆 창의 받기가 깨진다");
    ok(!left.some((p) => p.endsWith("current") || p === path.join("agents", "codex")),
       "★ 쓰는 Node·에이전트는 찌꺼기가 아니다");

    const npm = path.join(root, "fake-npm");
    put(path.join(npm, "_cacache", "index", "a"), 10_000);
    put(path.join(npm, "_npx", "aaa", "node_modules", "p.js"), 20_000);
    put(path.join(npm, "_npx", "bbb", "node_modules", "p.js"), 30_000);
    const spots = await survey(root, npm);
    const by = Object.fromEntries(spots.map((s) => [s.id, s]));
    console.log("   " + spots.map((s) => `${s.id}=${s.bytes}${s.canClean ? "" : "(쓰는 중)"}${s.shared ? "(남의 것)" : ""}`).join(" · "));
    ok(by["agents"]!.canClean === false && by["node"]!.canClean === false,
       "★ 쓰는 에이전트·Node 에는 지우는 단추가 없다 — 「제거」 가 따로 있다");
    ok(by["agents"]!.bytes === 6000 + 2000, "★ 에이전트 크기에서 옆으로 치운 찌꺼기는 뺀다 (방금 것은 아직 안 뺀다)");
    ok(by["node"]!.bytes === 4000, "★ Node 는 current 만 센다");
    ok(by["leftover"]!.bytes === 2000 + 3000 + 500 + 700 && by["leftover"]!.shared === false,
       "★ 찌꺼기는 우리 것이라 묻지 않는다");
    ok(by["npmCache"]!.bytes === 10_000 && by["npmCache"]!.shared, "★ npm 캐시는 남의 자리로 표시된다");
    ok(by["npx"]!.bytes === 50_000 && by["npx"]!.shared, "★ npx 캐시도");

    const r = await sweep(by["npx"]!.paths);
    ok(r.freed === 50_000 && r.kept === 0 && !fs.existsSync(path.join(npm, "_npx")), "★ npx 캐시를 비운다");
    const r2 = await sweep(by["leftover"]!.paths);
    ok(r2.freed === 6200, `★ 찌꺼기를 비운다 (${r2.freed})`);
    ok(fs.existsSync(current) && fs.existsSync(freshCache) && fs.existsSync(freshAside),
       "★ 쓰는 것과 방금 것은 그대로다");
    ok(await duOf(path.join(npm, "_cacache")) === 10_000, "★ 안 고른 칸은 안 건드린다");
  }

  console.log("\n[★ 하나가 잠겨도 나머지는 비운다]");
  /*
   * 못 지우는 칸을 만든다 — 쓰기 권한이 없는 폴더 안은 못 지운다. 다른 프로그램이 띄워 쓰는
   * `_npx` 칸과 같은 처지다. ⚠️ 윈도우는 이 방법이 안 먹고(권한 비트가 없다) Node 로 연 파일도
   * 지워지므로 거기선 못 만든다 — 리눅스·맥(CI)에서 잰다. root 는 권한을 무시하므로 건너뛴다.
   */
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const npx = path.join(root, "locked-npx");
    put(path.join(npx, "free", "a"), 1000);
    put(path.join(npx, "held", "inner", "x"), 1000);
    const held = path.join(npx, "held");
    fs.chmodSync(held, 0o500);
    try {
      const r = await sweep([npx]);
      console.log(`   비운 것 ${r.freed} · 남긴 것 ${r.kept}`);
      ok(!fs.existsSync(path.join(npx, "free")), "★ 안 잠긴 칸은 지워진다");
      ok(r.kept === 1 && fs.existsSync(held), "★ 못 지운 것은 남기고 **센다** — «다 지웠다» 고 안 한다");
      ok(r.freed === 1000, "★ 비운 만큼만 센다");
    } finally {
      fs.chmodSync(held, 0o700);
    }
  } else {
    console.log("  (리눅스·맥에서만 — 윈도우에선 못 지우는 칸을 만들 수 없다)");
  }

  console.log("\n[★ npm 캐시 자리 — OS 마다 기본값이 다르다]");
  {
    const home = path.join(path.sep, "home", "u");
    ok(defaultNpmCache({}, home, "linux") === path.join(home, ".npm"), "★ 리눅스는 ~/.npm");
    ok(defaultNpmCache({}, home, "darwin") === path.join(home, ".npm"), "★ 맥도 ~/.npm");
    ok(defaultNpmCache({ LOCALAPPDATA: path.join("C:", "L") }, home, "win32") === path.join("C:", "L", "npm-cache"),
       "★ 윈도우는 %LOCALAPPDATA%\\npm-cache");
    ok(defaultNpmCache({ NPM_CONFIG_CACHE: "/x/c" }, home, "linux") === "/x/c",
       "★ 환경변수가 이긴다 (대소문자 상관없이)");

    const said: Run = async () => ({ code: 0, say: `npm warn 뭔가\n${path.join(root, "custom-cache")}\n` });
    ok(await npmCacheDir(root, home, said) === path.join(root, "custom-cache"),
       "★ **npm 에게 물은 답을 쓴다** — .npmrc 로 옮겨뒀을 수 있다");
    const nonsense: Run = async () => ({ code: 0, say: "undefined" });
    ok(await npmCacheDir(root, home, nonsense) === defaultNpmCache(process.env, home, process.platform),
       "★ 답이 경로가 아니면 기본값");
    const broken: Run = async () => ({ code: 1, say: "npm 없음" });
    ok(await npmCacheDir(root, home, broken) === defaultNpmCache(process.env, home, process.platform),
       "★ npm 이 없으면 기본값");
  }

  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n디스크 정리 — 다 통과");
}

main().catch((e) => { console.error(e); process.exit(1); });
