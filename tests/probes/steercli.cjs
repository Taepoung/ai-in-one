/**
 * **CLI 직결로는 도는 중에 끼어들 수 있나** — `steer.cjs` 와 같은 실험, 통로만 다름.
 *
 * ACP 어댑터로는 **줄을 섰다**(2026-09-23 실측): 첫 턴이 40까지 다 세고 끝난
 * 뒤에야 둘째가 처리됐다. 그런데 `claude --help` 에 이런 것이 있다:
 *
 * ```
 * --input-format stream-json     "stream-json" (realtime streaming input)
 * --replay-user-messages         stdin 으로 넣은 것을 stdout 으로 되돌려 확인
 * ```
 *
 * **«realtime streaming input»** 이 도는 세션에 사용자 메시지를 밀어 넣는
 * 통로라면, ACP 에는 없던 길이 CLI 에는 있는 셈이다.
 *
 * 가르는 것은 **순서**다 (프로브가 한 번 속은 자리):
 *
 * ```
 * 바나나가 첫 result **앞**  →  끼어들었다 (steering)
 * 바나나가 첫 result **뒤**  →  또 줄을 섰다 — «턴 끝 배달»이 CLI 자체의 모델
 * ```
 */
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cli-"));
// 🔴 Windows 에서  는 **npm 셈이 아니라 네이티브 실행 파일**이다
//    (~/.local/bin/claude.exe, 244MB).  를 찾으면 없다.
const CMD = process.env.AIO_CLAUDE
  ?? (process.platform === "win32"
    ? path.join(os.homedir(), ".local", "bin", "claude.exe")
    : "claude");

const args = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--replay-user-messages",
  "--model", "sonnet",
];

const proc = spawn(CMD, args, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });

const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
const log = [];
/** 판정용 — **안 자른** 원문. 자른 글로 판정하면 «끊겼다»가 거짓으로 나온다 */
const said = [];
let buf = "";
let err = "";

/** 사용자 메시지 한 줄 — SDK 가 읽는 모양 */
const say = (text) => {
  log.push(`${ms()}ms  → 보냄: ${text.slice(0, 32)}`);
  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n",
  );
};

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { log.push(`${ms()}ms  ? 파싱 실패: ${line.slice(0, 80)}`); continue; }

    if (m.type === "assistant") {
      const text = (m.message?.content ?? [])
        .filter((c) => c.type === "text").map((c) => c.text).join(" ")
        .replace(/\s+/g, " ").trim();
      /*
       * 🔴 **자른 글로 판정하면 안 된다.** 「40까지 셌나」를 로그 줄에서 찾다가
       * 70자에서 잘린 탓에 «끊겼다»로 나왔다 — 모델은 멀쩡히 다 셌는데.
       * 보여주는 것은 자르되 **판정은 원문으로** 한다.
       */
      if (text) said.push(text);
      if (text) log.push(`${ms()}ms    말: ${text.slice(0, 70)}`);
    } else if (m.type === "result") {
      log.push(`${ms()}ms  ✓ result (${m.subtype ?? "?"}) turns=${m.num_turns ?? "?"}`);
    } else if (m.type === "user") {
      // --replay-user-messages — **받았다**는 확인
      const t = JSON.stringify(m.message?.content ?? "").slice(0, 40);
      log.push(`${ms()}ms  ↩ 되돌아옴(받음): ${t}`);
    } else if (m.type === "system") {
      log.push(`${ms()}ms  · system/${m.subtype ?? "?"}`);
    } else {
      log.push(`${ms()}ms  · ${m.type}`);
    }
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });

const done = new Promise((r) => proc.on("exit", (code) => r(code)));

(async () => {
  await new Promise((r) => setTimeout(r, 1200));   // 뜨는 시간
  console.log("1) 오래 걸릴 일을 시킨다");
  say("1부터 40까지 한 줄에 하나씩, 천천히 세어줘. 숫자만.");

  await new Promise((r) => setTimeout(r, 3000));
  console.log("2) ★ 아직 도는 중에 또 보낸다");
  say("그만 세고 '바나나'라고만 답해.");

  // 둘 다 끝날 때까지 기다렸다가 stdin 을 닫는다
  await new Promise((r) => setTimeout(r, 45000));
  try { proc.stdin.end(); } catch { /* 이미 닫혔을 수 있다 */ }
  const code = await Promise.race([done, new Promise((r) => setTimeout(() => r("timeout"), 20000))]);

  console.log("\n── 일어난 순서 ──────────────────────");
  for (const l of log) console.log("  " + l);

  console.log("\n── 결론 ──────────────────────");
  const iFirstResult = log.findIndex((l) => l.includes("✓ result"));
  const iBanana = log.findIndex((l) => l.includes("말:") && l.includes("바나나"));
  const counted40 = said.some((t) => /\b40\b/.test(t));
  const gotSecond = log.filter((l) => l.includes("→ 보냄")).length === 2;

  console.log(`  둘째를 보냈나: ${gotSecond ? "예" : "아니오"}`);
  console.log(`  첫 일이 끝까지 갔나 (40까지): ${counted40 ? "예 — 안 끊겼다" : "아니오 — 끊겼다"}`);
  if (iBanana < 0) {
    console.log("  ❌ 바나나가 안 나왔다 — 둘째가 처리되지 않았다 (무시 또는 거부)");
  } else if (iFirstResult >= 0 && iBanana < iFirstResult) {
    console.log("  (라) ✅ **도는 턴에 끼어들었다 — CLI 직결이면 steering 이 된다**");
  } else if (iFirstResult < 0) {
    console.log("  ? result 가 안 보인다 — 아래 순서를 직접 읽어야 한다");
  } else {
    console.log("  (마) **또 줄을 섰다** — «턴 끝 배달»이 CLI 자체의 모델이다");
  }

  /*
   * ★ `--print` 는 **메시지마다 새 세션**이다 (2026-09-23 실측).
   *
   * `system/init` 이 두 번, `turns=1` 이 두 번 나온다. «도는 세션에 끼어든다»가
   * 아니라 **애초에 이어지는 세션이 없다** — 둘째는 첫째의 맥락도 모른다.
   */
  const inits = log.filter((l) => l.includes("system/init")).length;
  console.log(`  system/init 횟수: ${inits}${inits > 1 ? "  ← **메시지마다 새 세션이다**" : ""}`);
  if (err.trim()) console.log("\n  stderr:", err.slice(-400));
  console.log("  exit:", code);

  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 지워진다 */ }
  process.exit(0);
})();
