/**
 * **모델 id 가 별명인가 판인가** (2026-09-29).
 *
 * 사용자 물음: *"모델의 버전 말이야"*.
 *
 * 우리는 고른 모델을 `configValues.model` 에 **id 로** 적어 둔다. 그 id 가
 *
 *   `sonnet`                       → **별명**. 가리키는 판이 말없이 바뀐다
 *   `claude-sonnet-4-5-20250929`   → **판**. 바뀌면 id 가 바뀐다
 *
 * 중 어느 쪽이냐에 따라 «모델이 바뀌었다» 를 우리가 알 수 있는지가 갈린다.
 * 별명이면 목록에서 사라지는 일이 없으므로 `restoreChoices` 의 감시망에
 * **처음부터 안 걸린다** — 어제의 Sonnet 과 오늘의 Sonnet 이 같은 값이다.
 *
 * `initialize` 응답에 어댑터/CLI 판이 실려 오는지도 같이 본다. 그게 있으면
 * 별명 뒤가 바뀐 것을 **간접으로** 알아챌 수 있다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mid-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "", err = "";
const waiting = new Map();
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
      if (m.error) bad(m.error); else ok(m.result);
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 180000);
});

(async () => {
  const init = await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  console.log("\n[initialize 응답 — 판이 실려 오나]");
  console.log(JSON.stringify(init, null, 2).slice(0, 1600));

  const sess = await call("session/new", { cwd, mcpServers: [] });
  const opts = sess.configOptions ?? sess.modes?.availableModes ?? [];
  const model = opts.find((o) => o.category === "model" || o.id === "model");

  console.log("\n[session/new 의 모델 칸 — 통째로]");
  console.log(JSON.stringify(model, null, 2));

  const flat = [];
  for (const e of model?.options ?? []) {
    if (e.options) for (const v of e.options) flat.push(v); else flat.push(e);
  }
  console.log("\n[판정]");
  console.log(`  지금 값: ${JSON.stringify(model?.currentValue)}`);
  for (const v of flat) {
    const dated = /\d{6,8}|-\d+-\d+/.test(v.value);
    console.log(`  ${dated ? "판" : "별명"}  ${String(v.value).padEnd(34)} «${v.name}»`);
  }
  const anyDated = flat.some((v) => /\d{6,8}/.test(v.value));
  console.log(`\n  → 날짜 박힌 id ${anyDated ? "있다" : "**없다** — 전부 별명이다"}`);

  proc.kill();
  fs.rmSync(cwd, { recursive: true, force: true });
})().catch((e) => {
  console.error("실패:", e?.message ?? e, "\nstderr:", err.slice(0, 600));
  proc.kill();
  process.exit(1);
});
