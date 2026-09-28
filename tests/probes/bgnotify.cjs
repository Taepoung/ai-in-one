/**
 * **백그라운드가 끝났다는 «알림»이 우리한테도 보이나** (2026-09-28).
 *
 * `wakebusy.cjs` 에서 본 것: 턴이 도는 중에 끝나면 에이전트가 **제 답변에 녹여서**
 * 말한다 — «아까 띄운 `sleep 15 …`도 정상 종료됐어요(exit code 0)».
 *
 * 그런데 그때 에이전트는 **출력 파일을 안 읽었다**(읽은 도구가 0개였다). 그러면
 * 종료 코드를 **어디서 알았나.** 어딘가로 «끝났다»는 알림이 들어온 것이고,
 * 질문은 그게 **우리 눈에도 보이느냐**다.
 *
 *   보인다  → 1턴 말풍선의 **그 활동을 제자리에서 갱신**할 수 있다.
 *             «⏳ 도는 중» 이던 것이 «✓ 끝남» 이 된다 — 제일 정직한 표시다
 *   안 보인다 → 에이전트의 말이 유일한 흔적이다. 우리는 손댈 것이 없다
 *
 * ★ 그래서 이번에는 **모든 `session/update` 를 통째로** 찍는다. 앞서 두 번,
 * 칸을 골라 보다가 있는 것을 «없다»고 할 뻔했다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-bgn-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

const TOKEN = "미나리스물";
const BG_SLEEP = 14;

let seq = 0, buf = "", err = "";
const waiting = new Map();
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
/** 1턴에서 백그라운드를 띄운 도구의 id — 뒤에 이 id 가 또 나오는지가 핵심 */
let bgId = null;
/** 모든 업데이트 — 통째로 */
const all = [];

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
    if (!raw) continue;
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { ok, bad, label } = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) bad(m.error); else { all.push({ t: Date.now() - began, kind: `=${label}`, raw: m.result }); ok(m.result); }
      continue;
    }
    if (m.method === "session/update") {
      const u = m.params?.update;
      all.push({ t: Date.now() - began, kind: u?.sessionUpdate ?? "?", raw: u });
      // 띄운 도구의 id 를 잡아둔다
      const id = u?.toolCallId;
      if (id && JSON.stringify(u).includes(TOKEN)) bgId = bgId ?? id;
      continue;
    }
    if (m.method === "session/request_permission") {
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      continue;
    }
    // ★ **에이전트가 우리에게 거는 다른 요청도 적는다** — 알림이 이쪽일 수 있다
    if (m.method) all.push({ t: Date.now() - began, kind: `←${m.method}`, raw: m.params });
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params, label) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad, label: label ?? method });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 300000);
});
const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);
const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
  process.exit(code);
};
const say = (v, n) => JSON.stringify(v ?? null).replace(/\s+/g, " ").slice(0, n);

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}\n`);

  await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      `Bash 를 **백그라운드(run_in_background)** 로 \`sleep ${BG_SLEEP} && echo ${TOKEN}\` 를 ` +
      `띄워줘. 띄우자마자 "띄웠어" 라고만 하고 턴을 끝내.` }],
  }, "1턴");
  const t1 = Date.now() - began;
  console.log(`1턴 종료 ${(t1 / 1000).toFixed(1)}초 · 띄운 도구 id = ${bgId}`);
  const mark1 = all.length;

  console.log(`2턴 시작 — 백그라운드는 ${((BG_SLEEP * 1000 - t1) / 1000).toFixed(1)}초 뒤에 끝난다\n`);
  await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "bash 로 `sleep 10 && echo 하나` 를 돌리고, 끝나면 `sleep 10 && echo 둘` 을 " +
      "**차례로** 돌려줘. 그 다음 한 문장으로 알려줘." }],
  }, "2턴");
  console.log(`2턴 종료 ${((Date.now() - began) / 1000).toFixed(1)}초\n`);

  // ── 2턴 동안 온 것 전부 ───────────────────────────────────────────
  console.log("-- 2턴 동안 온 것 (통째로) ------------------------------");
  for (const e of all.slice(mark1)) {
    const hot = e.t > BG_SLEEP * 1000 && e.t < BG_SLEEP * 1000 + 8000;
    console.log(`  ${hot ? "★" : " "}${String(e.t).padStart(6)}ms ${e.kind}`);
    console.log(`        ${say(e.raw, 260)}`);
  }

  // ── 판정 ──────────────────────────────────────────────────────────
  console.log("\n-- 결론 ------------------------------");
  const after = all.slice(mark1);
  const byId = after.filter((e) => e.raw?.toolCallId && e.raw.toolCallId === bgId);
  const hasToken = after.filter((e) => say(e.raw, 100000).includes(TOKEN));
  const kinds = [...new Set(after.map((e) => e.kind))];

  console.log(`  2턴 동안 온 업데이트 종류: ${kinds.join(", ")}`);
  console.log(`  띄운 도구 id(${bgId}) 로 온 것: ${byId.length}개`);
  console.log(`  토큰(«${TOKEN}»)이 든 것: ${hasToken.length}개`);
  for (const e of hasToken) console.log(`     ${e.t}ms ${e.kind} — ${say(e.raw, 150)}`);
  console.log("");

  mark(byId.length > 0, byId.length > 0
    ? "★ **띄운 도구 id 로 갱신이 온다** — 1턴 말풍선의 그 활동을 제자리에서 갱신할 수 있다"
    : "🔴 그 id 로는 아무것도 안 온다 — 원래 활동을 갱신할 길이 없다");

  const onlyProse = hasToken.length > 0 &&
    hasToken.every((e) => e.kind === "agent_message_chunk" || String(e.kind).startsWith("="));
  mark(!onlyProse, onlyProse
    ? "🔴 **에이전트의 말이 유일한 흔적이다** — 구조로 잡을 것이 없다"
    : "★ 말 말고 다른 자리에도 흔적이 있다");

  if (err.trim()) console.log("\n  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
