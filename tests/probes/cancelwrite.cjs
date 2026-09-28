/**
 * **말을 쓰는 중에 끊어도 맥락이 남나** — 도구 단계 취소와 다를 수 있다.
 *
 * 앞서 **도구 단계**에서 끊었을 때는 맥락이 남았다(`cancelctx.cjs`, 2026-09-23):
 * 에이전트가 `sleep 5 && echo 하나` 라는 명령어까지 기억했다. 그런데 그때는
 * **도구 호출이 세션에 이미 적혀 있었다.**
 *
 * 말을 쓰는 중은 다르다 — 반쯤 쓴 문장은 **아직 아무 데도 안 적혔을 수 있다.**
 * 그러면 끊는 순간 그 말이 통째로 사라지고, 에이전트는 «무슨 말을 하려던
 * 거였지»를 모른다.
 *
 *   남는다 →  «끼어들기»가 **어느 단계에서든** 된다
 *   사라진다 → 쓰는 중에는 «잃는 것»이 더 크다. 화면에 그렇게 알려야 한다
 *
 * ── 전제조건을 먼저 본다 ──────────────────────────────────────────
 * 이 프로브의 형제들이 두 번 헛돌았다. 취소가 안 꽂혔거나(턴이 먼저 끝남)
 * 애초에 쓴 말이 없으면 **아무것도 안 잰 것**이다. 결론보다 먼저 찍는다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cw-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "", err = "";
const waiting = new Map();
const log = [];
/** 판정용 — **안 자른** 원문 */
const said = [];
let toolCount = 0;
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
      if (m.error) { log.push(`${ms()}ms  x ${label} 거부`); bad(m.error); }
      else { log.push(`${ms()}ms  = ${label} (stopReason=${m.result?.stopReason})`); ok(m.result); }
    } else if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const t = u.content.text;
        if (t.trim()) { said.push(t); log.push(`${ms()}ms    말: ${t.replace(/\s+/g, " ").trim().slice(0, 50)}`); }
      } else if (u?.sessionUpdate === "tool_call") {
        toolCount++;
        log.push(`${ms()}ms    [도구] ${u.title ?? "?"}`);
      }
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
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const call = (method, params, label) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad, label: label ?? method });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 240000);
});
const nap = (t) => new Promise((r) => setTimeout(r, t));
const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
  process.exit(code);
};

/** 취소를 꽂을 때까지 **말이 흐르는지 보고** 기다린다 — 시간으로 재면 흔들린다 */
async function waitForWriting(minChunks, capMs) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    if (said.length >= minChunks) return true;
    await nap(150);
  }
  return said.length >= minChunks;
}

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션: ${sessionId}\n`);

  console.log("1) 도구 없이 **긴 글만** 쓰게 시킨다");
  const first = call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "도구는 **쓰지 말고** 글로만 답해줘. 재귀 함수를 처음 배우는 사람에게 " +
      "아주 자세히 설명해줘 — 정의, 종료 조건, 호출 스택, 예제 다섯 개, 흔한 실수까지. " +
      "각 항목을 문단으로 나눠서 길게 써줘." }],
  }, "첫째").then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

  console.log("2) ★ 말이 흐르기 시작하면 그 한가운데서 끊는다");
  const writing = await waitForWriting(3, 30000);
  await nap(300);
  log.push(`${ms()}ms  [중단] session/cancel 보냄 (지금까지 조각 ${said.length}개)`);
  notify("session/cancel", { sessionId });

  const a = await first;
  const cutAt = said.length;
  const partial = said.join("");

  await nap(800);
  console.log("3) ★ 그 다음, 뭘 쓰던 중이었는지 물어본다");
  const b = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "방금 뭘 쓰던 중이었지? 어디까지 썼는지 한 문장으로만 답해." }],
  }, "둘째").then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

  console.log("\n-- 일어난 순서 ------------------------------");
  for (const l of log) console.log("  " + l);

  const stop = a.ok ? a.r?.stopReason : "(거부)";
  console.log("\n-- 전제조건 ------------------------------");
  console.log(`  첫째 stopReason : ${stop}`);
  console.log(`  중단 전 글 조각 : ${cutAt}개 (${partial.length}자)`);
  console.log(`  중단 전 도구    : ${toolCount}개 ${toolCount === 0 ? "(글만 썼다 — 원하던 조건)" : "(도구도 썼다)"}`);

  if (stop === "end_turn") {
    console.log("\n  [무효] 취소 전에 턴이 이미 끝났다 — 더 긴 글을 시켜야 한다.");
    bye(0);
  }
  if (!writing || cutAt === 0) {
    console.log("\n  [무효] 끊기 전에 쓴 말이 없다 — 중단할 «쓰던 것»이 없었다.");
    bye(0);
  }

  const after = said.slice(cutAt).join(" ").replace(/\s+/g, " ").trim();
  console.log(`\n  중단 전에 쓴 것 (앞 120자) : ${partial.replace(/\s+/g, " ").slice(0, 120)}`);
  console.log(`  중단 뒤의 답               : ${after.slice(0, 220) || "(없음)"}`);

  /*
   * **그 일에만 나오는 말**로 판정한다 — 일반 부정어로 보면 속는다
   * («조절할 수 **없**어서» 의 «없» 에 걸린 적이 있다).
   */
  const knows = /재귀|recursion|종료 조건|호출 스택|설명/i.test(after);
  console.log("");
  if (!after.trim()) {
    console.log("  ? 둘째가 답을 안 했다 — 위 순서를 직접 읽어야 한다");
  } else if (knows) {
    console.log("  OK **쓰는 중에 끊어도 맥락이 남는다** — 끼어들기가 어느 단계에서든 된다");
  } else {
    console.log("  NO **쓰던 말이 사라진다** — 쓰는 중 중단은 도구 단계보다 비싸다");
    console.log("     화면에서 «지금 끊으면 쓰던 말을 잃는다»고 알려야 한다");
  }
  if (err.trim()) console.log("\n  stderr:", err.slice(-250));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
