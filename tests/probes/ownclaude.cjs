/**
 * **어댑터를 안 올리고도 모델을 올릴 수 있나** (2026-09-30).
 *
 * 사용자 물음: *"흠 그러면 얘네가 업데이트 해줘야 우리도 모델 업데이트가
 * 된다는 얘기인가"*.
 *
 * 앞서 잰 것은 «핀이 곧 모델 판» 이었다. 그 말대로라면 우리는 관리자 셋이
 * 새 판을 낼 때까지 **기다리는 것 말고 할 수 있는 일이 없다.** 그런데 어댑터
 * 코드를 읽다 보니 이런 것이 있었다:
 *
 * ```js
 * export async function claudeCliPath() {
 *     if (process.env.CLAUDE_CODE_EXECUTABLE) {
 *         return process.env.CLAUDE_CODE_EXECUTABLE;   // ← 이걸 먼저 본다
 *     }
 *     // The SDK's CLI is a native binary shipped as a platform-specific …
 * }
 * ```
 *
 * 즉 **어댑터가 들고 온 `claude.exe` 를 갈아끼울 손잡이가 있다.** 그렇다면
 * 물음은 하나로 좁혀진다:
 *
 *   **모델 표를 «어댑터» 가 들고 있나, «claude» 가 들고 있나?**
 *
 * ```
 * 어댑터가 들고 있다  → 갈아끼워도 목록이 그대로. 기다리는 수밖에 없다
 * claude 가 들고 있다 → 갈아끼우면 목록이 바뀐다. **우리 손에 길이 하나 더 있다**
 * ```
 *
 * 핀은 **0.81.2 그대로 두고** 실행파일만 바꿔서 잰다. 그래야 «어댑터를 안
 * 올리고도» 가 성립한다.
 */
const { spawn, execSync } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const PINNED = "0.81.2";
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };

/** 이 기계에 있는 다른 claude 들 */
function candidates() {
  const out = [];
  try {
    const p = execSync("where claude", { encoding: "utf8" }).split(/\r?\n/).filter(Boolean)[0];
    if (p) out.push({ how: "사용자 PATH", path: p.trim() });
  } catch {}
  const ext = path.join(os.homedir(), ".vscode", "extensions");
  try {
    for (const d of fs.readdirSync(ext)) {
      if (!/^anthropic\.claude-code-/.test(d)) continue;
      const exe = path.join(ext, d, "resources", "native-binary", "claude.exe");
      if (fs.existsSync(exe)) out.push({ how: `VSCode 확장 (${d.replace(/^anthropic\.claude-code-/, "")})`, path: exe });
    }
  } catch {}
  /*
   * 확장은 낡은 판본이 지워지지 않고 쌓여 있다 — 이 기계에 열 벌이 넘었다.
   * 다 띄우면 거의 같은 답을 열 번 받는다. **제일 새 것 하나만** 본다 —
   * 물음은 «다른 claude 를 물리면 목록이 바뀌나» 이지 «판본마다 몇 개인가»
   * 가 아니다.
   */
  const exts = out.filter((o) => o.how.startsWith("VSCode"));
  const rest = out.filter((o) => !o.how.startsWith("VSCode"));
  exts.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return [...rest, ...exts.slice(-1)];
}

function start(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-own-"));
  const proc = spawn(CMD, ["-y", `@agentclientprotocol/claude-agent-acp@${PINNED}`], {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env },
  });
  const waiting = new Map();
  let seq = 0, buf = "", err = "";
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && waiting.has(m.id)) {
        const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 200))); else ok(m.result);
      } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { err += c; });
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 180000);
  });
  return { proc, call, cwd, stderr: () => err };
}

const flat = (opt) => {
  const out = [];
  for (const e of opt?.options ?? []) { if (e.options) out.push(...e.options); else out.push(e); }
  return out;
};

async function models(label, env) {
  const a = start(env);
  try {
    await a.call("initialize", INIT);
    const s = await a.call("session/new", { cwd: a.cwd, mcpServers: [] });
    const opt = (s.configOptions ?? []).find((o) => o.category === "model");
    const list = flat(opt).map((v) => `${v.value}=${v.name}`);
    console.log(`  ${label}`);
    console.log(`     ${list.length}개 · ${list.join(" · ")}`);
    return list;
  } catch (e) {
    console.log(`  ${label}\n     실패: ${String(e.message).slice(0, 140)}`);
    console.log(`     stderr: ${a.stderr().slice(0, 200).replace(/\n/g, " ")}`);
    return null;
  } finally {
    a.proc.kill();
    try { fs.rmSync(a.cwd, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  console.log(`\n[어댑터는 ${PINNED} 로 고정 — 실행파일만 바꾼다]\n`);

  const base = await models("① 어댑터가 들고 온 claude (지금 우리 모습)", {});
  console.log();

  const found = candidates();
  if (found.length === 0) console.log("  (이 기계에 다른 claude 가 없다)");

  const others = [];
  for (const c of found) {
    const got = await models(`② ${c.how}\n     ${c.path}`, { CLAUDE_CODE_EXECUTABLE: c.path });
    others.push({ ...c, list: got });
    console.log();
  }

  console.log("[판정]");
  if (!base) { console.log("  기준을 못 재서 비교 불가"); return; }
  let moved = false;
  for (const o of others) {
    if (!o.list) { console.log(`  ${o.how}: 못 띄웠다 — 이 길은 막혀 있다`); continue; }
    const same = o.list.join("|") === base.join("|");
    console.log(`  ${o.how}: 목록이 ${same ? "**똑같다**" : "**달라진다**"}`);
    if (!same) {
      moved = true;
      for (const v of o.list) if (!base.includes(v)) console.log(`     + ${v}`);
      for (const v of base) if (!o.list.includes(v)) console.log(`     - ${v}`);
    }
  }
  console.log(
    moved
      ? "\n  → **모델 표는 `claude` 가 들고 있다.** 어댑터를 안 올려도\n" +
        "     실행파일만 갈면 모델이 올라간다 — 기다리는 것 말고 길이 하나 더 있다."
      : "\n  → **모델 표는 어댑터 쪽에 묶여 있다.** 실행파일을 갈아도 그대로다 —\n" +
        "     새 모델을 쓰려면 어댑터가 새 판을 내는 수밖에 없다.",
  );
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
