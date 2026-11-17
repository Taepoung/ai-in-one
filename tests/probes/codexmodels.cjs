/**
 * **Codex 쪽은 모델이 어떻게 갱신되나** (2026-09-30).
 *
 * 사용자 물음: *"gpt의 경우는?"* — Claude 쪽에서 «어댑터 관리자가 새 판을
 * 내야 우리 모델이 올라간다» 를 확인한 뒤 이어진 물음이다.
 *
 * 두 어댑터가 **제 엔진을 무는 방식이 다르다.** 이것이 답을 가른다:
 *
 * ```
 * claude-agent-acp 0.84.0   "@anthropic-ai/claude-agent-sdk": "0.3.284"   ← 못
 * codex-acp        2.0.1    "@openai/codex":                  "^0.159.1"  ← 범위
 * ```
 *
 * 못이면 어댑터가 새 판을 내야 엔진이 움직인다. 범위면 **npm 이 받을 때마다
 * 고른다** — 우리는 `npx -y` 라 잠금파일이 없으므로 매번 새로 고른다.
 *
 * ⚠️ 다만 `0.x` 에서 `^` 는 `~` 처럼 좁게 군다: `^0.159.1` 은 `<0.160.0` 이다.
 * 그러니 «완전히 자동» 은 아니고 **패치 자리까지만** 이다. 그 경계를 눈으로
 * 확인하는 것이 이 probe 의 절반이고, 나머지 절반은 **실제로 무슨 모델이
 * 나오는가** 다.
 *
 * ⏪ **«핀을 안 박았다» 는 이제 아니다** (2026-10-01). 사용자가 박으라고 했고
 * `@2.1.0` 으로 박혔다. 그래서 이 probe 도 더 이상 `latest` 를 안 본다 —
 * `pinned.cjs` 가 애드온 파일(`src/agents/<id>/`)에서 읽어오므로 **제품이 띄우는 바로 그
 * 판**을 재다.
 *
 * 다만 박아도 **모델은 안 고정된다.** 엔진이 `^0.159.1` 로 물려 있어서다 —
 * 아래가 바로 그걸 찍는다. 그리고 여기서 보이는 셋째 줄이 중요하다 —
 * **사용자 PATH 의 `codex`** 는 또 다른 판이고, 나가기 뒷정리는 그걸 부른다
 * (`docs/PIN.md` §F5).
 */
const { spawn, execSync } = require("node:child_process");
const { argsOf, pkgOf } = require("./pinned.cjs");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };

function start(cwd) {
  const proc = spawn(CMD, argsOf("codex"), {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
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
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 250))); else ok(m.result);
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
  return { proc, call, stderr: () => err };
}

const flat = (opt) => {
  const out = [];
  for (const e of opt?.options ?? []) { if (e.options) out.push(...e.options); else out.push(e); }
  return out;
};
const ask = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch { return "(없음)"; } };

(async () => {
  console.log("\n[두 어댑터가 제 엔진을 무는 방식]");
  console.log(`  claude-agent-acp  @anthropic-ai/claude-agent-sdk : ${ask("npm view @agentclientprotocol/claude-agent-acp@0.84.0 dependencies.@anthropic-ai/claude-agent-sdk")}`);
  console.log(`  codex-acp         @openai/codex                  : ${ask("npm view @agentclientprotocol/codex-acp dependencies.@openai/codex")}`);
  console.log(`  @openai/codex 최신                                : ${ask("npm view @openai/codex version")}`);
  console.log(`  사용자 codex                                      : ${ask("codex --version")}`);

  console.log("\n[우리 쪽 핀]");
  // 리팩토링 ① 부터 에이전트마다 파일이 하나다 — 셋을 이어 붙여 읽는다
  const AGENTS = path.join(__dirname, "..", "..", "src", "agents");
  const cat = fs.readdirSync(AGENTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => fs.readFileSync(path.join(AGENTS, d.name, "index.ts"), "utf8"))
    .join("\n");
  for (const m of cat.matchAll(/"(-y)", "(@agentclientprotocol\/[^"]+)"/g)) {
    const spec = m[2];
    console.log(`  ${spec.includes("@", 1) ? "박음  " : "안 박음"} ${spec}`);
  }

  console.log("\n[codex-acp 가 실제로 주는 모델]");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-codex-"));
  const a = start(cwd);
  try {
    const init = await a.call("initialize", INIT);
    console.log(`  초기화 OK · resume ${Boolean(init?.agentCapabilities?.sessionCapabilities?.resume)}`);
    const s = await a.call("session/new", { cwd, mcpServers: [] });
    const opts = s.configOptions ?? [];
    console.log(`  설정 칸 ${opts.length}개: ${opts.map((o) => `${o.id}(${o.category})`).join(" · ") || "(없음)"}`);
    const model = opts.find((o) => o.category === "model" || o.id === "model");
    if (!model) {
      console.log("  🔴 **모델 칸이 없다** — 그러면 우리 화면의 모델 고르개가 Codex 방에서는 빈다");
    } else {
      console.log(`  지금 값: ${JSON.stringify(model.currentValue)}`);
      for (const v of flat(model)) {
        const dated = /\d|gpt-\d/.test(String(v.value));
        console.log(`    ${dated ? "판  " : "별명"} ${String(v.value).padEnd(28)} «${v.name}»`);
      }
    }
  } catch (e) {
    console.log(`  실패: ${String(e.message).slice(0, 200)}`);
    console.log(`  stderr: ${a.stderr().slice(0, 400).replace(/\n/g, " ")}`);
    console.log("  (로그인이 안 되어 있으면 여기서 막힌다 — `codex` 로 로그인하면 다시 잰다)");
  } finally {
    /*
     * 🔴 **어댑터만 죽이면 `codex.exe` 가 남는다** (2026-09-30에 겪음).
     *
     * `proc.kill()` 은 npx 껍데기만 죽인다. 그 아래 `codex.exe` 가 살아남아
     * **npx 캐시의 제 바이너리를 잡고 있고**, 다음 판에서 npm 이 그것을 새
     * 것으로 갈아치우려다 `EBUSY` 로 터진다 — 실제로 이 probe 가 한 번
     * 그렇게 죽었다. 핀이 없어서 매번 갈아치우려 드는 것과 겹친 사고다.
     *
     * 나무째 죽인다. `taskkill /T` 가 자식까지 간다.
     */
    try {
      execSync(`taskkill /PID ${a.proc.pid} /T /F`, { stdio: "ignore" });
    } catch { a.proc.kill(); }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
