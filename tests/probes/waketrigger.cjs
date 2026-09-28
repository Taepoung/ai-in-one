/**
 * **«무엇이 깨웠는지»를 데이터로 짚을 수 있나** (2026-09-28).
 *
 * 봇이 스스로 깨어나는 것은 쟀다(`selfwake.cjs`). 화면에 그걸 «답장이 아닌
 * 말»로만 띄우면 *"이게 왜 온 거지"* 가 되므로, **무엇 때문에 깨어났는지**를
 * 같이 보여주고 싶다. 그러려면 그 연결이 **데이터에 있어야** 한다.
 *
 * 앞 기록에서 보인 것:
 *
 * ```
 *  4486ms  도구: Terminal (pending)
 *  5090ms  도구: sleep 25 && echo 감자칠십칠      ← 백그라운드로 띄운 일
 *  7100ms  턴 종료 (end_turn)
 * 33788ms  도구: Read File (pending)              ← 깨어나서 결과를 읽는다
 * 37146ms  말: «…끝났어. 출력은 감자칠십칠…»
 * ```
 *
 * 그런데 **제목만** 찍었더니 이어 붙일 실이 안 보인다. 여기서는 **id 와 상태**를
 * 찍는다. 물을 것 셋:
 *
 *   ① 백그라운드 도구가 턴이 끝날 때까지 **안 끝난 채로** 남나
 *      (그러면 «안 끝난 도구»가 곧 «깨울 것»의 표시다)
 *   ② 깨어난 뒤에 **그 도구의 id 로** 상태 갱신이 오나
 *      (오면 «이게 끝났다»를 정확히 짚을 수 있다)
 *   ③ 안 오면, 깨어난 묶음의 도구들에 **거슬러 갈 단서**가 있나
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-trig-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

const TOKEN = "감자칠십칠";
const SLEEP = 25;

let seq = 0, buf = "", err = "";
const waiting = new Map();
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
/** 도구 호출을 id 로 모은다 — 마지막 상태가 무엇인지 보려고 */
const tools = new Map();
const line = [];
let endedAt = null;

const snap = (u) => {
  const id = u.toolCallId ?? u.tool_call_id ?? "(id없음)";
  const prev = tools.get(id) ?? { id, title: "", statuses: [], firstAt: Date.now() - began };
  if (u.title) prev.title = u.title;
  if (u.kind) prev.kind = u.kind;
  prev.statuses.push(`${u.status ?? "-"}@${ms().trim()}`);
  prev.lastAt = Date.now() - began;
  prev.afterEnd = endedAt !== null;
  tools.set(id, prev);
  line.push(`${ms()}  ${endedAt === null ? " " : "*"} ${u.sessionUpdate} id=${String(id).slice(0, 18)} status=${u.status ?? "-"} «${String(u.title ?? "").replace(/\s+/g, " ").slice(0, 42)}»`);
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
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") snap(u);
      else if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const t = u.content.text.replace(/\s+/g, " ").trim();
        if (t) line.push(`${ms()}  ${endedAt === null ? " " : "*"} 말 «${t.slice(0, 50)}»`);
      }
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

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}\n`);

  const r = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      `Bash 도구를 **백그라운드(run_in_background)** 로 써서 ` +
      `\`sleep ${SLEEP} && echo ${TOKEN}\` 를 띄워줘. ` +
      `띄우자마자 "띄웠어" 라고만 하고 **기다리지 말고 턴을 끝내.**` }],
  });
  endedAt = Date.now();
  const turnMs = endedAt - began;
  console.log(`턴 종료: ${(turnMs / 1000).toFixed(1)}초 · ${r?.stopReason}\n`);
  if (r?.stopReason !== "end_turn" || turnMs > SLEEP * 1000) {
    console.log("[무효] 백그라운드로 안 띄웠다 — 다시 재야 한다");
    bye(0);
  }

  const beforeIds = new Set(tools.keys());
  await nap((SLEEP + 20) * 1000);

  console.log("-- 흐름 (* 는 턴이 끝난 뒤) ------------------------------");
  for (const l of line) console.log("  " + l);

  console.log("\n-- 도구별 ------------------------------");
  for (const t of tools.values()) {
    console.log(`  ${t.afterEnd ? "*" : " "} id=${String(t.id).slice(0, 20)} kind=${t.kind ?? "-"}`);
    console.log(`     «${String(t.title).replace(/\s+/g, " ").slice(0, 60)}»`);
    console.log(`     상태: ${t.statuses.join(" → ")}`);
  }

  // ── 판정 ──────────────────────────────────────────────────────────
  console.log("\n-- 결론 ------------------------------");
  const bg = [...tools.values()].find((t) => String(t.title).includes(TOKEN));
  const last = (t) => (t?.statuses.at(-1) ?? "").split("@")[0];

  mark(bg !== undefined, bg ? `백그라운드 도구를 찾았다 («${String(bg.title).slice(0, 40)}»)` : "백그라운드 도구를 못 찾았다");
  if (!bg) { bye(0); }

  const openAtEnd = bg.firstAt < turnMs && !["completed", "failed"].includes(last(bg));
  mark(openAtEnd,
    openAtEnd
      ? `★ ① **턴이 끝날 때 안 끝난 채로 남는다** (마지막 상태 ${last(bg)}) — «안 끝난 도구»가 곧 «깨울 것»의 표시다`
      : `① 턴이 끝나기 전에 ${last(bg)} 로 닫혔다 — 그러면 이 도구로는 못 짚는다`);

  const updatedAfter = bg.afterEnd || bg.lastAt > turnMs;
  mark(updatedAfter,
    updatedAfter
      ? "★ ② **깨어난 뒤에 그 도구의 id 로 갱신이 온다** — «이게 끝났다»를 정확히 짚을 수 있다"
      : "② 깨어난 뒤에 그 id 로는 아무 갱신도 안 온다 — 정확히 짚을 수는 없다");

  const woke = [...tools.values()].filter((t) => !beforeIds.has(t.id));
  console.log(`\n  깨어난 뒤 **새로** 생긴 도구: ${woke.length}개`);
  for (const t of woke) console.log(`    «${String(t.title).replace(/\s+/g, " ").slice(0, 60)}»`);

  if (err.trim()) console.log("\n  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
