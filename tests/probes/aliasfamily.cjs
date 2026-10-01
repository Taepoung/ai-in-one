/**
 * **별명은 제 계열 안에서만 움직이나 — 그리고 Codex 는?** (2026-09-30).
 *
 * 사용자 물음: *"그럼 sonnet이면 같은 sonnet계열으로 바뀜? codex는 어떤데"*.
 *
 * 앞서 잰 것은 `sonnet` → `claude-sonnet-5` / `claude-sonnet-5-5` 였다. 둘 다
 * Sonnet 이니 «계열 안에서 움직인다» 로 보인다. 그런데 **그건 두 점을 본
 * 것이지 약속을 본 것이 아니다.** 그리고 목록에는 계열 이름이 아닌 것이 하나
 * 섞여 있다:
 *
 * ```
 * opus · sonnet · haiku      계열 이름
 * default                    **«추천»** — 계열 이름이 아니다
 * ```
 *
 * `default` 는 «오늘 우리가 미는 것» 이라는 뜻이라 **계열을 건널 수 있다.**
 * 방이 그걸 쓰고 있으면 Opus 를 쓰던 사람이 어느 날 딴 계열로 옮겨갈 수도
 * 있다는 말이다. 그게 진짜인지 본다.
 *
 * Codex 쪽은 사정이 다르다. id 가 `gpt-6-luna` 처럼 **판처럼 생겼다.** 그런데
 * `luna`·`terra` 는 날짜가 아니라 **이름**이라, 그것 자체가 움직이는 표적일
 * 수도 있다 — `sonnet` 이 그랬듯이. 물어봐서 확인한다.
 *
 * 모델의 자기 신고는 못 믿을 때가 있으므로 **선로에서 주운 id** 를 같이 본다.
 */
const { spawn } = require("node:child_process");
const { argsOf, pkgOf } = require("./pinned.cjs");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, session: { compaction: {} } },
};
const WHO = "너의 정확한 모델 id 를 한 줄로만 적어. 설명·도구 사용 금지. 모르면 «모름».";

function start(pkg, cwd) {
  const proc = spawn(CMD, ["-y", pkg], { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const said = [];
  let seq = 0, buf = "", wireModel = null;
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
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
        // ★ 선로가 말해주는 «지금 도는 모델» — 자기 신고보다 단단하다
        const w = u?._meta?.["_claude/model"];
        if (w) wireModel = w;
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
  return { proc, call, said, wire: () => wireModel };
}

const flat = (opt) => {
  const out = [];
  for (const e of opt?.options ?? []) { if (e.options) out.push(...e.options); else out.push(e); }
  return out;
};

async function ask(pkg, pick) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-fam-"));
  const a = start(pkg, cwd);
  try {
    await a.call("initialize", INIT);
    const s = await a.call("session/new", { cwd, mcpServers: [] });
    const opt = (s.configOptions ?? []).find((o) => o.category === "model");
    const label = flat(opt).find((v) => v.value === pick)?.name ?? "(목록에 없음)";
    if (pick !== opt?.currentValue) {
      await a.call("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: pick });
    }
    a.said.length = 0;
    await a.call("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: WHO }] });
    return { label, says: a.said.join("").trim().split("\n")[0].slice(0, 44), wire: a.wire() };
  } catch (e) {
    return { label: "?", says: `실패: ${String(e.message).slice(0, 80)}`, wire: null };
  } finally {
    try {
      require("node:child_process").execSync(`taskkill /PID ${a.proc.pid} /T /F`, { stdio: "ignore" });
    } catch { a.proc.kill(); }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  const CL = (v) => `@agentclientprotocol/claude-agent-acp@${v}`;

  console.log("\n[① Claude — 별명이 가리키는 곳]\n");
  const plan = [
    ["0.81.2", "sonnet"], ["0.84.0", "sonnet"],
    ["0.81.2", "haiku"],  ["0.84.0", "haiku"],
    ["0.81.2", "default"], ["0.84.0", "default"],
  ];
  const got = {};
  for (const [v, pick] of plan) {
    const r = await ask(CL(v), pick);
    got[`${v}/${pick}`] = r;
    console.log(`  ${v}  ${pick.padEnd(8)} 「${r.label}」`);
    console.log(`          자기 신고 ${r.says}`);
    console.log(`          선로      ${r.wire ?? "(없음)"}`);
  }

  console.log("\n[판정 — 계열을 건너나]");
  for (const pick of ["sonnet", "haiku", "default"]) {
    const a = got[`0.81.2/${pick}`], b = got[`0.84.0/${pick}`];
    const fam = (s) => (String(s).match(/opus|sonnet|haiku|fable/i) ?? ["?"])[0].toLowerCase();
    const fa = fam(a.wire ?? a.says), fb = fam(b.wire ?? b.says);
    const mark = fa === fb ? "제 계열 안" : "**계열을 건넜다**";
    console.log(`  ${pick.padEnd(8)} ${fa} → ${fb}   ${mark}`);
  }

  console.log("\n[② Codex — id 가 판인가 별명인가]\n");
  const cx = await ask(pkgOf("codex"), "gpt-5.5");
  console.log(`  gpt-5.5   「${cx.label}」`);
  console.log(`            자기 신고 ${cx.says}`);
  const cx2 = await ask(pkgOf("codex"), "gpt-6-luna");
  console.log(`  gpt-6-luna「${cx2.label}」`);
  console.log(`            자기 신고 ${cx2.says}`);
  console.log("\n  (고른 id 와 대는 이름이 같으면 **판**이다 — 움직일 자리가 없다)");
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
