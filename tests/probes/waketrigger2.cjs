/**
 * **깨운 활동을 짚을 실이 «어디엔가» 있나** (2026-09-28).
 *
 * `waketrigger.cjs` 에서 본 것: 백그라운드 도구는 «띄우는 데 성공»한 시점에
 * `completed` 로 닫히고, 깨어난 뒤에는 **그 id 로 아무 갱신도 안 온다.**
 * 그래서 «어느 활동이 깨웠나»를 id 로는 못 짚는다.
 *
 * 그런데 그때 **경로를 60자에서 잘라서** 봤다:
 *
 * ```
 * 37331*  tool_call  «Read File»
 * 38874*  tool_call_update  «Read C:\Users\BASE\AppData\Local\Temp\clau…»
 * ```
 *
 * 깨어난 에이전트가 **제일 먼저 하는 일이 결과 파일을 읽는 것**이다. 그 경로에
 * 띄울 때 받은 무언가(셸 id 같은)가 들어 있으면 **거기가 실이다.** 그래서
 * 이번에는 **자르지 않고 통째로** 본다 — 제목·`rawInput`·`locations` 까지.
 *
 * ── 그리고 «도중에 딴 말» 을 같이 만든다 ──────────────────────────
 *
 * 지금 화면은 «이 봇이 마지막으로 답한 턴»을 가리킨다. 백그라운드가 도는
 * 사이에 사용자가 딴 말을 하면 **그 턴으로 잘못 걸린다.** 실제로 그렇게
 * 걸리는지, 그리고 실이 있으면 그걸로 **갈라낼 수 있는지** 같이 본다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-trig2-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

const TOKEN = "보라매아흔";
const SLEEP = 30;

let seq = 0, buf = "", err = "";
const waiting = new Map();
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
/** 턴 번호 — 어느 턴에서 생긴 활동인지 가르려고 */
let turn = 0;
let ended = false;
/** 도구 호출 전부 — **안 자른** 원문 */
const calls = [];

const keep = (u) => {
  calls.push({
    t: ms().trim(), turn, afterEnd: ended,
    id: u.toolCallId ?? u.tool_call_id ?? null,
    kind: u.kind ?? null,
    status: u.status ?? null,
    title: u.title ?? null,
    locations: u.locations ?? null,
    rawInput: u.rawInput ?? u.raw_input ?? null,
    /*
     * ★ **안 본 칸이 있었다** (2026-09-28). 처음에는 title·locations·rawInput 만
     * 찍고 «실이 없다»고 할 뿔했다. 도구 **결과**(`content`·`rawOutput`)에
     * 백그라운드 id 가 적힐 수 있는데 그걸 안 봤다. **통째로** 들고 있는다.
     */
    all: u,
  });
};

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
    if (!raw) continue;
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) bad(m.error); else ok(m.result);
      continue;
    }
    if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") keep(u);
      continue;
    }
    if (m.method === "session/request_permission") {
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      continue;
    }
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 240000);
});
const nap = (t) => new Promise((r) => setTimeout(r, t));
const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);
const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
  process.exit(code);
};
const say = (v, n = 200) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined || s === null ? "-" : s.replace(/\s+/g, " ").slice(0, n);
};

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}\n`);

  // ── 1턴: 백그라운드로 띄운다 ──────────────────────────────────────
  turn = 1;
  const r1 = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      `Bash 를 **백그라운드(run_in_background)** 로 써서 \`sleep ${SLEEP} && echo ${TOKEN}\` 를 ` +
      `띄워줘. 띄우자마자 "띄웠어" 라고만 하고 **기다리지 말고 턴을 끝내.**` }],
  });
  console.log(`1턴 종료: ${((Date.now() - began) / 1000).toFixed(1)}초 · ${r1?.stopReason}`);

  // ── 2턴: ★ 도중에 딴 말 — 이게 지금 오판을 만드는 상황이다 ────────
  turn = 2;
  const r2 = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "잠깐, 2 더하기 2는? 도구 쓰지 말고 숫자만." }],
  });
  console.log(`2턴 종료: ${((Date.now() - began) / 1000).toFixed(1)}초 · ${r2?.stopReason}`);

  turn = 0;
  ended = true;
  console.log(`\n이제 아무것도 안 보내고 ${SLEEP}초쯤 기다린다…\n`);
  await nap((SLEEP + 15) * 1000);

  console.log("-- 도구 호출 전부 (자르지 않음) ------------------------------");
  for (const c of calls) {
    console.log(`  ${c.afterEnd ? "*" : `${c.turn}턴`} ${c.t}ms  id=${say(c.id, 24)} kind=${c.kind} status=${c.status}`);
    if (c.title) console.log(`       title     : ${say(c.title, 240)}`);
    if (c.locations) console.log(`       locations : ${say(c.locations, 300)}`);
    if (c.rawInput) console.log(`       rawInput  : ${say(c.rawInput, 400)}`);
    if (c.all?.content) console.log(`       content   : ${say(c.all.content, 500)}`);
    if (c.all?.rawOutput) console.log(`       rawOutput : ${say(c.all.rawOutput, 500)}`);
  }

  // ── 판정 ──────────────────────────────────────────────────────────
  console.log("\n-- 실이 있나 ------------------------------");
  const launch = calls.find((c) => !c.afterEnd && say(c.title, 400).includes(TOKEN));
  const woke = calls.filter((c) => c.afterEnd);
  console.log(`  띄운 호출     : ${launch ? `${launch.turn}턴 · id=${say(launch.id, 24)}` : "(못 찾음)"}`);
  console.log(`  깨어난 뒤 호출 : ${woke.length}개`);

  if (!launch || woke.length === 0) {
    console.log("\n  [무효] 띄운 호출이나 깨어난 호출이 없다 — 다시 재야 한다");
    bye(0);
  }

  // 통째로 비교한다 — 칸을 골라 보다 한 번 놓쳐다
  const wokeBlob = woke.map((c) => say(c.all, 20000)).join(" ");
  const sameId = woke.some((c) => c.id && c.id === launch.id);
  mark(sameId, sameId
    ? "★ 깨어난 호출이 **띄운 id 를 그대로** 쓴다"
    : "🔴 id 는 안 이어진다 (앞서 본 그대로)");

  const cmdHit = wokeBlob.includes(TOKEN);
  mark(cmdHit, cmdHit
    ? `★ **명령 원문(«${TOKEN}»)이 깨어난 호출에 들어 있다** — 이걸로 짚을 수 있다`
    : `🔴 명령 원문(«${TOKEN}»)이 깨어난 호출에 없다`);

  /*
   * 띄운 호출의 **id 꼬리**나 rawInput 의 어떤 값이 깨어난 경로에 박혀 있나.
   * 셸 id 같은 것이 파일 이름에 들어가는 방식이면 여기서 걸린다.
   */
  const launchBlob = calls.filter((c) => c.id === launch.id).map((c) => say(c.all, 20000)).join(" ");
  const tokens = [...new Set(launchBlob.match(/[A-Za-z0-9_-]{6,}/g) ?? [])];
  const shared = tokens.filter((t) => wokeBlob.includes(t));
  console.log(`\n  띄운 쪽의 긴 조각 ${tokens.length}개 중 깨어난 쪽에도 있는 것: ${shared.length}개`);
  if (shared.length) console.log(`    ${shared.slice(0, 8).join(" · ")}`);
  mark(shared.length > 0,
    shared.length > 0
      ? "★ **공통 조각이 있다** — 이걸로 «어느 활동이 깨웠나»를 짚을 수 있다"
      : "🔴 공통 조각이 없다 — 깨운 활동을 데이터로는 못 짚는다");

  if (err.trim()) console.log("\n  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
