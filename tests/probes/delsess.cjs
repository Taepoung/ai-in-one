/**
 * **«방 나가기»가 진짜로 세션을 지우나** — 디스크까지 본다 (2026-09-23).
 *
 * 우리 코드는 `session/delete` 를 부르고 «지웠다»고 여긴다. 그런데 그건
 * **에이전트에게 부탁한 것**일 뿐이다. 실제로 확인할 것은 하나다:
 *
 *   ~/.claude/projects/<cwd 슬러그>/<sessionId>.jsonl  ← 이게 사라지는가
 *
 * 이 파일이 **TUI 의 `/resume` 목록 그 자체**다. 남아 있으면 사용자는 우리
 * 앱에서 방을 지웠는데 **claude 를 켜면 그 대화가 그대로 있는** 것을 본다.
 *
 * 겸사겸사 우리 코드가 근거로 삼은 주장 하나도 같이 잰다:
 *   «에이전트는 **첫 프롬프트를 받아야** 세션을 디스크에 쓴다»
 *   (그래서 빈 세션엔 delete 대신 close 를 부른다 — `deleteSession`)
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-del-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "", err = "";
const waiting = new Map();
const log = [];
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { ok, bad, label } = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) { log.push(`${ms()}ms  x ${label}: ${JSON.stringify(m.error).slice(0, 120)}`); bad(m.error); }
      else { log.push(`${ms()}ms  = ${label}`); ok(m.result); }
    } else if (m.method === "session/request_permission") {
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params, label) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad, label: label ?? method });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 180000);
});
const nap = (t) => new Promise((r) => setTimeout(r, t));
const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
  process.exit(code);
};

/**
 * 세션 파일을 **이름으로 찾는다** — 슬러그 규칙을 짐작하지 않는다.
 *
 * cwd 를 폴더 이름으로 바꾸는 규칙이 바뀌면 «없다»가 거짓으로 나오고, 그러면
 * «잘 지워졌다»고 잘못 읽는다. 전 폴더를 훑는 편이 느려도 안 속는다.
 */
function findSessionFile(sessionId) {
  if (!fs.existsSync(PROJECTS)) return null;
  for (const dir of fs.readdirSync(PROJECTS)) {
    const p = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);

(async () => {
  const init = await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const caps = init?.agentCapabilities?.sessionCapabilities ?? {};
  console.log("세션 기능:", Object.keys(caps).join(", ") || "(없음)");
  console.log("작업 폴더:", cwd, "\n");

  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션: ${sessionId}\n`);

  // ── ① 빈 세션은 디스크에 없나 (우리 코드가 근거로 삼은 주장) ──────
  console.log("[① 프롬프트 전 — 디스크에 있나]");
  const before = findSessionFile(sessionId);
  console.log(`   파일: ${before ?? "(없음)"}`);
  mark(before === null,
    "**빈 세션은 디스크에 없다** — `deleteSession` 이 빈 세션에 close 를 부르는 근거");

  // ── ② 한 마디 하면 생기나 ────────────────────────────────────────
  console.log("\n[② 한 마디 주고받은 뒤]");
  await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "한 단어로만 답해줘: 하늘은 무슨 색?" }],
  }, "프롬프트");
  await nap(1200);   // 디스크 쓰기가 턴 종료보다 약간 늦을 수 있다

  const after = findSessionFile(sessionId);
  console.log(`   파일: ${after ?? "(없음)"}`);
  mark(after !== null, "**대화가 오가면 디스크에 적힌다** — 이게 TUI `/resume` 이 읽는 그 파일");
  if (after === null) {
    console.log("\n  [무효] 파일이 애초에 안 생겼다 — 지워지는지를 잴 수가 없다.");
    bye(0);
  }
  console.log(`   크기: ${fs.statSync(after).size} 바이트`);

  // ── ③ 에이전트도 «있다»고 하나 ───────────────────────────────────
  console.log("\n[③ session/list 에 잡히나]");
  let listedBefore = null;
  try {
    const r = await call("session/list", { cwd }, "list");
    const ids = (r?.sessions ?? []).map((s) => s.sessionId ?? s.id);
    listedBefore = ids.includes(sessionId);
    console.log(`   목록 ${ids.length}개 · 우리 것 포함: ${listedBefore}`);
  } catch (e) {
    console.log(`   (list 안 됨: ${JSON.stringify(e).slice(0, 80)})`);
  }

  // ── ④ ★ 지운다 — 우리 «방 나가기»가 하는 그 호출 ─────────────────
  console.log("\n[④ ★ session/delete — 우리 «방 나가기»가 부르는 것]");
  let deleteOk = true;
  try {
    await call("session/delete", { sessionId }, "delete");
  } catch (e) {
    deleteOk = false;
    console.log(`   거부: ${JSON.stringify(e).slice(0, 200)}`);
  }
  await nap(1200);

  const gone = findSessionFile(sessionId);
  console.log(`   파일: ${gone ?? "(없음)"}`);
  console.log("");
  mark(deleteOk, "delete 자체는 받아들여졌다");
  mark(gone === null,
    gone === null
      ? "★ **디스크에서 진짜로 사라진다** — TUI 를 켜도 그 대화가 없다"
      : "🔴 **파일이 남아 있다** — 우리 앱에서 지운 방이 claude 에는 그대로다");

  if (listedBefore === true) {
    try {
      const r = await call("session/list", { cwd }, "list(후)");
      const ids = (r?.sessions ?? []).map((s) => s.sessionId ?? s.id);
      mark(!ids.includes(sessionId), "목록에서도 빠진다");
    } catch { /* 위에서 이미 봤다 */ }
  }

  console.log("\n-- 일어난 순서 ------------------------------");
  for (const l of log) console.log("  " + l);
  if (err.trim()) console.log("\n  stderr:", err.slice(-300));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
