/**
 * **봇이 백그라운드 일을 돌려놓고 «스스로» 다시 말할 수 있나** (2026-09-28).
 *
 * Claude Code 는 한다 — `run_in_background` 로 띄우고, 턴을 이어가다가, 그게
 * 끝나면 **하네스가 모델을 다시 부른다.** 그래서 «다 됐네요»가 저절로 온다.
 *
 * 우리는 ACP 뒤에 있다. 물어볼 것은 둘이다:
 *
 *   ① 어댑터가 애초에 **백그라운드 실행을 내주나**
 *   ② 턴이 끝난 **뒤에** 에이전트가 제 발로 `session/update` 를 보내나
 *
 * ②가 핵심이다. `session/prompt` 가 `end_turn` 으로 돌아온 다음에도 말이
 * 오면, **봇이 스스로 깨어나는 것**이고 우리는 그걸 화면에 얹기만 하면 된다.
 * 안 오면 «백그라운드»는 턴 안에서만 사는 개념이고, 우리가 막는 게 아니라
 * **애초에 그런 길이 없다.**
 *
 * ── 이 프로브가 «무효»가 되는 경우 ─────────────────────────────────
 * 🔴 에이전트가 백그라운드로 안 띄우고 **그냥 기다려 버리면** 아무것도 못 잰다.
 * 그때는 턴이 20초 넘게 걸리고 `end_turn` 이 sleep 뒤에 온다 — 먼저 찍는다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-wake-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@" + (process.env.AIO_ACP_VERSION || "0.81.2")], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

/** 백그라운드 일이 끝나야만 나올 수 있는 말 */
const TOKEN = "감자칠십칠";
/** 잠들 초 — 턴이 끝나고도 한참 남아야 한다 */
const SLEEP = 25;

let seq = 0, buf = "", err = "";
const waiting = new Map();
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
const log = [];
/** 턴이 끝난 시각. 이후에 온 것이 «스스로 깨어난» 증거다 */
let endedAt = null;
const afterEnd = [];

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
      if (m.error) { log.push(`${ms()}ms  x ${label}`); bad(m.error); }
      else { log.push(`${ms()}ms  = ${label} (stopReason=${m.result?.stopReason})`); ok(m.result); }
      continue;
    }

    // ★ 턴이 끝난 뒤에 오는 것은 **전부** 적는다 — 이게 재려는 것이다
    if (endedAt !== null) afterEnd.push({ at: Date.now() - endedAt, msg: m });

    if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const t = u.content.text.replace(/\s+/g, " ").trim();
        if (t) log.push(`${ms()}ms    말: ${t.slice(0, 70)}`);
      } else if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        const title = (u.title ?? "").replace(/\s+/g, " ");
        if (title) log.push(`${ms()}ms    도구: ${title.slice(0, 70)} (${u.status ?? "?"})`);
      } else if (u?.sessionUpdate) {
        log.push(`${ms()}ms    [${u.sessionUpdate}]`);
      }
      continue;
    }
    if (m.method === "session/request_permission") {
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      log.push(`${ms()}ms    (권한 자동 허용)`);
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      continue;
    }
    if (m.method) log.push(`${ms()}ms    <- ${m.method}`);
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params, label) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad, label: label ?? method });
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

(async () => {
  const init = await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log("에이전트 기능:", JSON.stringify(init?.agentCapabilities ?? {}).slice(0, 200));

  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}`);
  console.log(`폴더 : ${cwd}\n`);

  console.log(`[1] 백그라운드로 ${SLEEP}초짜리를 띄우고 **기다리지 말라**고 시킨다`);
  const t0 = Date.now();
  const r = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      `Bash 도구를 **백그라운드(run_in_background)** 로 써서 ` +
      `\`sleep ${SLEEP} && echo ${TOKEN}\` 를 띄워줘. ` +
      `띄우자마자 "띄웠어" 라고만 하고 **기다리지 말고 턴을 끝내.** ` +
      `결과는 나중에 나오면 그때 말해주면 돼.` }],
  }, "첫째");
  const turnMs = Date.now() - t0;
  endedAt = Date.now();

  console.log(`\n[2] 턴이 ${(turnMs / 1000).toFixed(1)}초에 ${r?.stopReason} 로 끝났다`);
  console.log(`    이제 **아무것도 안 보내고** ${SLEEP + 20}초 동안 기다린다`);
  await nap((SLEEP + 20) * 1000);

  console.log("\n-- 일어난 순서 ------------------------------");
  for (const l of log) console.log("  " + l);

  console.log("\n-- 전제조건 ------------------------------");
  console.log(`  턴 길이     : ${(turnMs / 1000).toFixed(1)}초 (sleep ${SLEEP}초)`);
  console.log(`  stopReason  : ${r?.stopReason}`);
  if (turnMs > SLEEP * 1000) {
    console.log("\n  [무효] 턴이 sleep 보다 길다 — 에이전트가 **그냥 기다렸다.**");
    console.log("        백그라운드로 안 띄운 것이므로 ②를 못 잰다.");
    bye(0);
  }

  console.log("\n-- 결론 ------------------------------");
  const texts = afterEnd
    .filter((e) => e.msg.method === "session/update")
    .map((e) => e.msg.params?.update)
    .filter((u) => u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
    .map((u) => u.content.text);
  console.log(`  턴 종료 뒤에 온 메시지 : ${afterEnd.length}개`);
  for (const e of afterEnd.slice(0, 8)) {
    console.log(`    +${(e.at / 1000).toFixed(1)}초  ${e.msg.method ?? `(응답 id=${e.msg.id})`}`);
  }
  console.log(`  그 중 봇의 말          : «${texts.join("").replace(/\s+/g, " ").trim().slice(0, 100) || "(없음)"}»`);

  const woke = afterEnd.length > 0;
  const told = texts.join("").includes(TOKEN);
  console.log("");
  mark(woke, woke
    ? "★ **턴이 끝난 뒤에도 말이 온다** — 봇이 스스로 깨어난다"
    : "🔴 **턴이 끝나면 아무것도 안 온다** — 스스로 깨어나는 길이 없다");
  if (woke) {
    mark(told, told
      ? `★ 그리고 백그라운드 결과(«${TOKEN}»)를 **제 입으로** 말한다`
      : `그런데 결과(«${TOKEN}»)는 안 말했다 — 온 것이 무엇인지 위를 읽어야 한다`);
  }

  if (err.trim()) console.log("\n  stderr:", err.slice(-300));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
