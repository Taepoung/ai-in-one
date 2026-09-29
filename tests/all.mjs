/** 전부 돌린다. `.mts`는 tsx, `.mjs`는 node. 실패한 것만 크게 찍는다 */
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 저장소 안에서 스스로 위치를 찾는다 — 절대경로를 박으면 남의 기계에서 안 돈다
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const SKIP = new Set(["all.mjs", "dom.mjs", "bench2.mjs"]);

/*
 * 🔴 **`.cjs` 는 기본적으로 안 돌린다** — 대부분 «진짜 CLI를 띄우는 프로브»라
 * 로그인과 할당량이 필요하기 때문이다. 그런데 그 탓에 `shell.cjs` (가짜 vscode
 * 로 **확장 번들을 실제로 로드하는** 테스트)가 **스위트 밖에서 표류했다** —
 * Gemini 를 기본 목록에서 뺀 지 한참인데 «에이전트 3종»을 계속 재고 있었다.
 * 가짜만 쓰는 것은 이름을 적어 넣는다.
 */
const ALSO = new Set(["shell.cjs"]);

/*
 * ★ **지난 판의 찌꺼기를 먼저 치운다** (2026-09-23).
 *
 * 🔴 `.mts` 테스트는 저마다 `mkdtemp(os.tmpdir(), "aio-…")` 로 작업폴더를 만들고
 * **한 번도 안 지웠다.** 모르고 있다가 8441개·101MB 가 쌓인 것을 발견했다.
 *
 * 더 나쁜 건 그 짝이다 — 진짜 CLI 를 띄우는 프로브는
 * `~/.claude/projects/<슬러그>/` 에 **세션 기록까지** 남겨서, 사용자의 `claude`
 * 프로젝트 목록에 **쓰레기 폴더가 줄지어 선다.** 우리가 만드는 앱이 바로 그
 * «나간 방이 CLI 에 남으면 안 된다»를 지키려는 참인데, 정작 우리 테스트가
 * 그걸 하고 있었다.
 *
 * 테스트 열예닐곱 개를 고치는 대신 **다 만드는 이 한 자리에서** 치운다.
 *
 * ★ **한 시간보다 오래된 것만.** 지금 도는 판(또는 옆에서 돌리는 다른 판)의
 * 폴더를 지우면 **그 판이 통째로 깨진다** — 같은 `suite.txt` 를 둘이 썼다가
 * 겪은 것과 같은 종류의 사고다.
 */
function sweep() {
  const HOUR = 60 * 60 * 1000;
  const old = (p) => {
    try { return Date.now() - fs.statSync(p).mtimeMs > HOUR; } catch { return false; }
  };
  const nuke = (dir, match) => {
    let n = 0;
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      if (!match(name)) continue;
      const p = path.join(dir, name);
      if (!old(p)) continue;
      // 폴더만 걸러내면 **파일로 떨어진 것들을 놓친다** — 실제로 389개가 그랬다
      try { fs.rmSync(p, { recursive: true, force: true }); n++; } catch { /* 잠겨 있으면 다음에 */ }
    }
    return n;
  };

  const tmp = nuke(os.tmpdir(), (n) => n.startsWith("aio-") || n.startsWith("clash-"));
  const proj = nuke(
    path.join(os.homedir(), ".claude", "projects"),
    // 진짜 프로젝트는 임시 폴더에 안 산다 — 이 조건이 유일한 안전장치다
    (n) => n.includes("AppData-Local-Temp-"),
  );
  if (tmp || proj) console.log(`(지난 판 찌꺼기 치움: 작업폴더 ${tmp} · 세션기록 ${proj})`);
}
sweep();

/*
 * ★ **돌리기 전에 짓는다** (2026-09-29).
 *
 * 🔴 **낡은 번들을 재고 «통과»라고 말하고 있었다.**
 *
 * `.mjs` 화면 검사들은 `dist/webview.js` 를 통째로 `eval` 한다 — 원본이 아니라
 * **지어놓은 것**이다. 그런데 이 자리에 짓는 코드가 없었다. 그래서 화면 코드를
 * 고치고 `npm test` 를 돌리면:
 *
 * ```
 * 고친 것은 src/webview/main.ts   ← 아무도 안 본다
 * 검사가 보는 것은 dist/webview.js ← 어제 것
 * 결과: 46 통과 · 0 실패          ← **아무것도 안 잰 초록불**
 * ```
 *
 * 색 고르개를 고치다 실제로 걸렸다. 새 동작을 재는 검사를 새로 썼는데 계속
 * 실패해서 «왜 안 되지» 를 한참 팠다 — 코드는 멀쩡했고 번들이 낡아 있었다.
 * 반대쪽이 더 무섭다: **고친 곳을 안 재고 초록불이 뜨는 것.**
 *
 * 짓는 데 60ms 다. 재는 것과 지어진 것이 어긋날 자리를 아예 없앤다.
 */
execFileSync("node", ["esbuild.mjs"], { cwd: ROOT, encoding: "utf8" });
{
  const js = path.join(ROOT, "dist", "webview.js");
  const age = ((Date.now() - fs.statSync(js).mtimeMs) / 1000).toFixed(1);
  console.log(`(지었다 — dist/webview.js ${age}초 전)`);
}

const files = fs.readdirSync(HERE)
  .filter((f) => ALSO.has(f) || ((f.endsWith(".mts") || f.endsWith(".mjs")) && !SKIP.has(f)))
  .sort();

const only = process.argv[2];
const bad = [];
let done = 0;
for (const f of files) {
  if (only && !f.includes(only)) continue;
  const mts = f.endsWith(".mts");
  const quoted = `"${path.join(HERE, f)}"`;
  try {
    execFileSync(
      "npx",
      /*
       * ★ **경로를 따옴표로 묶는다.**
       *
       * 🔴 `shell: true` 는 인자를 그냥 **이어 붙여** 명령줄로 만든다. 그래서
       * 경로에 공백이 있으면 **거기서 쪼개진다** — «C:\…\Taein Yoon\…» 이
       * «C:\…\Taein» 으로 잃혀 전부 MODULE_NOT_FOUND 이 됐다.
       *
       * 스크래치패드 경로에는 공백이 없어서 여태 안 드러났다. 저장소로
       * 옥기자마자 38개가 한꺼번에 터졌다.
       *
       * `shell` 을 끔고 `npx.cmd` 를 직접 부르는 길도 있지만, 최근 Node 는
       * 보안 문제로 `.cmd` 를 shell 없이 못 띄운다. 그래서 따옴표로 푸는 쪽이다.
       */
      mts ? ["tsx", quoted] : ["node", quoted],
      { cwd: ROOT, stdio: "pipe", shell: true, timeout: 300_000 },
    );
    done++;
    process.stdout.write(".");
  } catch (e) {
    bad.push([f, String(e.stdout ?? "") + String(e.stderr ?? "")]);
    process.stdout.write("X");
  }
}
process.stdout.write("\n");
for (const [f, out] of bad) {
  console.log("\n=== 실패: " + f + " ===");
  console.log(out.split("\n").slice(-25).join("\n"));
}
console.log(`\n통과 ${done} · 실패 ${bad.length}`);
process.exit(bad.length > 0 ? 1 : 0);
