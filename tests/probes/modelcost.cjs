/**
 * **모델 판이 달라지면 무엇이 달라지나 — 토큰과 돈** (2026-09-30).
 *
 * 사용자 물음: *"그럼 모델 버전이 달라지면 어떤 일이 벌어지는데"*.
 *
 * 여태 «안 깨진다» 만 쟀다 — 세션이 붙고, 대화가 살고, 맥락 창도 그대로.
 * 그런데 **안 깨지는 것과 같은 것은 다르다.** `bumpsonnet` 이 찍은 usage 에
 * 눈에 띄는 것이 있었다:
 *
 * ```
 * claude-sonnet-5     used 45533   cost 0.2106
 * claude-sonnet-5-5   used 46404   cost 0.5618     ← 토큰은 2% 느는데 돈은 2.7배
 * ```
 *
 * 🔴 **그 숫자는 못 믿는다.** 두 측정 사이에 프롬프트가 여러 번 오갔고 그중
 * 하나는 **Opus** 에서 돌았다(이어받은 직후 기본값이라). 섞인 것을 보고
 * «Sonnet 5.5 가 2.7배 비싸다» 고 하면 틀린다.
 *
 * 그래서 갈라서 잰다. 두 가지가 섞여 있다:
 *
 * ```
 * ㉠ 모델이 달라서 비싼가        — 판마다 단가가 다르다
 * ㉡ 이어받아서 비싼가           — 캐시가 깨져 맥락을 다시 읽는다
 * ```
 *
 * ㉡을 가르려면 **같은 모델로 이어받아** 봐야 한다. 그러면 남는 차이는
 * 이어받기 탓이다.
 *
 * 프롬프트는 짧고 똑같이 고정한다 — 답 길이가 흔들리면 비교가 안 된다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, session: { compaction: {} } },
};
/** 답 길이를 묶어둔다 — 안 그러면 토큰이 답마다 흔들린다 */
const TURNS = [
  '"가"  한 글자만 답해. 설명·도구 금지.',
  '"나"  한 글자만 답해. 설명·도구 금지.',
  '"다"  한 글자만 답해. 설명·도구 금지.',
];

function start(version, cwd) {
  const proc = spawn(CMD, ["-y", `@agentclientprotocol/claude-agent-acp@${version}`], {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  const usage = [];
  let seq = 0, buf = "", model = "?";
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
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "usage_update") {
          // ★ 실제로 도는 모델이 여기 실려 온다 — 물어보는 것보다 단단하다
          const who = u?._meta?.["_claude/model"];
          if (who) model = who;
          usage.push({ used: u.used, cost: u.cost?.amount ?? 0, model: who ?? model });
        }
      } else if (m.method === "session/request_permission") {
        const o = m.params?.options?.[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: o?.optionId } } });
      } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });
  proc.stderr.resume();
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 240000);
  });
  return { proc, call, usage, who: () => model };
}

const money = (n) => `$${n.toFixed(4)}`;

/** 한 세션에서 세 턴을 돌리고 **턴마다 늘어난 양**을 돌려준다 */
async function run(a, sid, turns) {
  const rows = [];
  for (const t of turns) {
    const before = a.usage.at(-1) ?? { used: 0, cost: 0 };
    await a.call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: t }] });
    const after = a.usage.at(-1) ?? before;
    rows.push({
      model: after.model,
      used: after.used, dUsed: after.used - before.used,
      cost: after.cost, dCost: after.cost - before.cost,
    });
  }
  return rows;
}

const show = (label, rows) => {
  console.log(`  ${label}`);
  for (const [i, r] of rows.entries()) {
    console.log(
      `    ${i + 1}턴  ${String(r.model).padEnd(20)} 누적 ${String(r.used).padStart(7)}토큰 ` +
      `${money(r.cost)}   이번 턴 +${String(r.dUsed).padStart(5)}토큰 +${money(r.dCost)}`,
    );
  }
};

(async () => {
  const out = {};

  // ── ① 판마다 «같은 일» 이 얼마인가 ────────────────────────────
  console.log("\n[① 새 세션에서 똑같은 세 턴 — 판만 다르게]\n");
  for (const [label, version, pick] of [
    ["0.81.2 · sonnet", "0.81.2", "sonnet"],
    ["0.84.0 · sonnet", "0.84.0", "sonnet"],
  ]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cost-"));
    const a = start(version, cwd);
    try {
      await a.call("initialize", INIT);
      const s = await a.call("session/new", { cwd, mcpServers: [] });
      await a.call("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: pick });
      const rows = await run(a, s.sessionId, TURNS);
      out[label] = rows;
      show(label, rows);
    } catch (e) {
      console.log(`  ${label}\n    실패: ${String(e.message).slice(0, 150)}`);
    } finally {
      a.proc.kill();
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
    console.log();
  }

  // ── ② 이어받으면 첫 턴이 비싼가 (모델은 그대로) ───────────────
  console.log("[② 같은 판·같은 모델로 «이어받기» — 캐시가 깨지나]\n");
  let resumed = null;
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-cost2-"));
    const a = start("0.84.0", cwd);
    let sid;
    try {
      await a.call("initialize", INIT);
      const s = await a.call("session/new", { cwd, mcpServers: [] });
      sid = s.sessionId;
      await a.call("session/set_config_option", { sessionId: sid, configId: "model", value: "sonnet" });
      const rows = await run(a, sid, TURNS);
      show("붙인 채로 세 턴", rows);
    } finally {
      a.proc.kill();
      await new Promise((r) => setTimeout(r, 1500));
    }
    const b = start("0.84.0", cwd);
    try {
      await b.call("initialize", INIT);
      await b.call("session/resume", { sessionId: sid, cwd });
      await b.call("session/set_config_option", { sessionId: sid, configId: "model", value: "sonnet" });
      const rows = await run(b, sid, ['"라"  한 글자만 답해. 설명·도구 금지.']);
      resumed = rows[0];
      show("→ 프로세스를 죽였다 살린 뒤 네 번째 턴", rows);
    } catch (e) {
      console.log(`    실패: ${String(e.message).slice(0, 150)}`);
    } finally {
      b.proc.kill();
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
  }

  // ── 판정 ──────────────────────────────────────────────────────
  console.log("\n[판정]");
  const a5 = out["0.81.2 · sonnet"], a55 = out["0.84.0 · sonnet"];
  if (a5 && a55) {
    const sum = (r) => r.reduce((x, y) => x + y.dCost, 0);
    const tok = (r) => r.at(-1).used;
    console.log(`  ${a5[0].model.padEnd(20)} 세 턴 ${money(sum(a5))} · 맥락 ${tok(a5)}토큰`);
    console.log(`  ${a55[0].model.padEnd(20)} 세 턴 ${money(sum(a55))} · 맥락 ${tok(a55)}토큰`);
    const r = sum(a5) > 0 ? sum(a55) / sum(a5) : 0;
    console.log(`  → 같은 일에 **${r.toFixed(2)}배**`);
  }
  if (resumed) {
    console.log(`  이어받은 첫 턴: +${resumed.dUsed}토큰 +${money(resumed.dCost)}`);
    console.log("  (붙인 채로 돌린 턴과 견줘 크게 비싸면 **캐시가 깨진 것**이다)");
  }
  console.log("\n  ⚠️ 한 번 잰 값이다. 답 길이·서버 사정으로 흔들린다.");
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
