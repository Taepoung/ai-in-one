/**
 * **중단하면 «하던 일»이 세션에 남나** — 남으면 «끼어들기»가 된다.
 *
 * 도중에 말을 미는 길은 세 통로 전부 닫혔다(ACP·CLI·SDK, 2026-09-23). 그런데
 * TUI 도 추론 한가운데가 아니라 **단계 사이**에 넣는 것이고, 사용자가 실제로
 * 하는 일은 **Esc 누르고 다시 치기**다. 그건 우리가 이미 할 수 있다 —
 * `session/cancel` 뒤에 새 프롬프트.
 *
 * 남은 질문은 하나뿐이다:
 *
 *   중단한 뒤에도 에이전트가 **자기가 뭘 하다 말았는지** 아는가.
 *
 *   안다   →  «끼어들기» 단추 하나로 TUI 와 같은 일이 된다. 잃는 것이 없다
 *   모른다 →  진짜로 날아간다. 그때야 «중단은 비싸다»가 참이다
 *
 * ── 이 프로브가 두 번 무효였던 이유 ───────────────────────────────
 *
 * 🔴 **«천천히 세어줘» 는 안 통한다.** 모델이 1초 만에 다 뱉어서 **취소가 낄
 * 틈이 없었다** (첫 턴 6.2초 end_turn, 취소 6.9초). 말은 빨라도 **도구는 진짜로
 * 기다리므로**, 일은 `sleep` 으로 잡는다.
 *
 * 🔴 **판정을 단어 줍기로 하면 속는다.** «조절할 수 **없**어서» 의 «없» 이
 * `/모르|없|처음/` 에 걸려 «맥락이 날아갔다»로 찍힌 적이 있다 — 정작 답은
 * «40까지 모두 셌어요» 였다. **그 일에만 나오는 말**로 본다.
 *
 * 🔴 무엇보다 **전제조건을 먼저 본다.** 취소가 안 꽂혔으면 이 실험은 아무것도
 * 안 잰 것이다. 그걸 모르고 결론을 찍을 뻔했다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cx-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@" + (process.env.AIO_ACP_VERSION || "0.81.2")], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "", err = "";
const waiting = new Map();
const log = [];
/** 판정용 — **안 자른** 원문 */
const said = [];
/** 에이전트가 돌린 도구들 — «정말 일이 돌았나»의 증거 */
const tools = [];
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
      if (m.error) { log.push(`${ms()}ms  x ${label} 거부: ${JSON.stringify(m.error).slice(0, 100)}`); bad(m.error); }
      else { log.push(`${ms()}ms  = ${label} (stopReason=${m.result?.stopReason})`); ok(m.result); }
    } else if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const t = u.content.text.replace(/\s+/g, " ").trim();
        if (t) { said.push(t); log.push(`${ms()}ms    말: ${t.slice(0, 64)}`); }
      } else if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        const title = u.title ?? "";
        if (title) { tools.push(title); log.push(`${ms()}ms    도구: ${title.slice(0, 50)} (${u.status ?? "?"})`); }
      }
    } else if (m.method === "session/request_permission") {
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      log.push(`${ms()}ms    (권한 자동 허용)`);
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

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션: ${sessionId}\n`);

  console.log("1) 진짜로 오래 걸리는 일을 시킨다 (sleep 이 실제로 기다린다)");
  const first = call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "bash 로 `sleep 5 && echo 하나` 를 돌려줘. 끝나면 `sleep 5 && echo 둘` 을, " +
      "그 다음 `sleep 5 && echo 셋` 을 **차례로** 돌려줘. 설명 없이 결과만." }],
  }, "첫째").then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

  await nap(9000);
  console.log("2) ★ 도중에 중단한다 (사용자가 Esc 누른 것과 같다)");
  log.push(`${ms()}ms  [중단] session/cancel 보냄`);
  notify("session/cancel", { sessionId });

  const a = await first;
  const cutAt = said.length;   // 여기까지가 «중단 전에 한 말»
  const toolsBefore = tools.length;

  await nap(800);
  console.log("3) ★ 그 다음, 앞 일을 아는지 물어본다");
  const b = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "방금 하던 일이 뭐였지? 어디까지 했는지 한 문장으로만 답해." }],
  }, "둘째").then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

  console.log("\n-- 일어난 순서 ------------------------------");
  for (const l of log) console.log("  " + l);

  const stop = a.ok ? a.r?.stopReason : "(거부)";
  console.log("\n-- 결론 ------------------------------");
  console.log(`  첫째 stopReason : ${stop}`);
  console.log(`  둘째 stopReason : ${b.ok ? b.r?.stopReason : "(거부)"}`);
  console.log(`  중단 전 도구 수 : ${toolsBefore}`);

  /*
   * ★ **전제조건부터.** 취소가 안 꽂혔으면 아무것도 안 잰 것이다 —
   * 이 프로브가 두 번 그렇게 헛돌았다.
   */
  if (stop === "end_turn") {
    console.log("\n  [무효] **실험이 성립하지 않았다** — 취소 전에 턴이 이미 끝났다.");
    console.log("        일을 더 길게 잡고 다시 재야 한다.");
    bye(0);
  }
  if (toolsBefore === 0) {
    console.log("\n  [무효] 도구가 한 번도 안 돌았다 — 중단할 «하던 일»이 없었다.");
    bye(0);
  }

  const after = said.slice(cutAt).join(" ");
  console.log(`\n  중단 뒤의 답 : ${after.slice(0, 200) || "(없음)"}`);

  /*
   * **그 일에만 나오는 말**로 본다. 일반 부정어로 판정하지 않는다.
   */
  const knows = /하나|둘|셋|sleep|echo|bash/i.test(after);
  console.log("");
  if (!after.trim()) {
    console.log("  ? 둘째가 답을 안 했다 — 위 순서를 직접 읽어야 한다");
  } else if (knows) {
    console.log("  OK **중단해도 맥락이 남는다** — «끼어들기»가 된다");
    console.log("     cancel -> 새 프롬프트 로 TUI 의 Esc 와 같은 일을 할 수 있다");
  } else {
    console.log("  NO **맥락이 날아간다** — 중단은 정말로 비싸다");
  }
  if (err.trim()) console.log("\n  stderr:", err.slice(-250));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
