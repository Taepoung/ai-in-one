/**
 * **Opus 5 → Opus 5.5 시나리오를 통째로 따라가 본다** (2026-09-29).
 *
 * 사용자 주문: *"cli가 업데이트되서 새로운 모델로 바뀌었을 때
 * opus5 -> opus5.5 시나리오를 봐봐"*.
 *
 * 지금 우리 방들이 실제로 들고 있는 값은 **`opus[1m]`** 이다 — 0.81.2 가
 * 주는 기본값이라 아무것도 안 고른 방은 전부 이것이다. 그리고 0.84.0 에서
 * 그 id 는 **사라지고 `opus` 가 된다.** 이름은 양쪽 다 「Opus 5.5」다.
 *
 * 우리는 바로 앞에 «이름이 같으면 입을 다문다» 는 규칙을 넣었다. 그 규칙이
 * 맞는지가 이 측정에 달려 있다. 그래서 세 가지를 따로 본다:
 *
 * ```
 * ① 보이는 이름      — 같은가
 * ② 진짜 모델        — 같은가            (스스로 대는 신분 + 선로)
 * ③ **맥락 크기**    — `[1m]` 이 사라진다는 게 무슨 뜻인가
 * ```
 *
 * ③이 이 probe 의 알맹이다. `[1m]` 은 «100만 토큰 맥락» 표시다. 0.84.0 의
 * 목록에는 `[1m]` 이 **하나도 없다.** 그러면 이름도 모델도 같은데 **맥락만
 * 줄어드는** 일이 생길 수 있고, 그건 이름으로는 절대 안 드러난다.
 *
 * 🔴 **첫 판에서 판정을 거꾸로 냈다.** 선로에서 주운 id 중 첫 번째를 «지금
 * 도는 모델» 로 봤는데, 그 줄에는 **모델 목록 전체**가 실려 있었다 —
 * 0.84.0 은 선택지가 12개라 `claude-sonnet-5` 가 맨 앞에 잡혔다. 그래서
 * «모델이 갈린다, 최악이다» 라고 쓸 뻔했다. 목록에 있는 값은 빼고 본다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, session: { compaction: {} } },
};
const ASK =
  "너의 정확한 모델 id 를 한 줄로만 적어. 설명·인사·도구 사용 전부 금지. " +
  "예: claude-opus-5-20260101. 모르면 «모름» 이라고만 적어.";

const PLAN = [
  { version: "0.81.2", pick: null, note: "지금 핀 · 기본값 (= 우리 방들의 값)" },
  { version: "0.84.0", pick: null, note: "올린 핀 · 기본값" },
  { version: "0.84.0", pick: "opus", note: "옛 방이 흘러가 닿는 자리" },
  { version: "0.84.0", pick: "claude-opus-5", note: "새로 생긴 박힌 id" },
];

function start(version, cwd) {
  const proc = spawn(CMD, ["-y", `@agentclientprotocol/claude-agent-acp@${version}`], {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  const said = [];
  const wire = [];
  const usage = [];
  let seq = 0, buf = "";
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const ids = line.match(/claude-[a-z]+-[0-9][0-9a-z-]*/g);
      if (ids) wire.push(...ids);
      if (m.id !== undefined && waiting.has(m.id)) {
        const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 200))); else ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
        // ★ **맥락 크기가 여기로 온다** — `[1m]` 이 진짜인지 가릴 유일한 자리
        if (u?.sessionUpdate === "usage_update" || u?.usage || u?.contextWindow) {
          usage.push(u.usage ?? u.contextWindow ?? u);
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
  return { proc, call, said, wire, usage };
}

const flat = (opt) => {
  const out = [];
  for (const e of opt?.options ?? []) { if (e.options) out.push(...e.options); else out.push(e); }
  return out;
};
/** 맥락 칸이 어디 박혀 있든 제일 큰 수를 집는다 */
const sizeOf = (usage) => {
  let best = 0;
  const walk = (v) => {
    if (typeof v === "number") { if (v > best) best = v; return; }
    if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(usage);
  return best;
};

async function once({ version, pick, note }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-opus-"));
  const a = start(version, cwd);
  await a.call("initialize", INIT);
  const sess = await a.call("session/new", { cwd, mcpServers: [] });
  const opt = (sess.configOptions ?? []).find((o) => o.category === "model");
  const all = flat(opt).map((v) => v.value);

  let value = opt?.currentValue;
  if (pick) {
    await a.call("session/set_config_option", { sessionId: sess.sessionId, configId: "model", value: pick });
    value = pick;
  }
  const label = flat(opt).find((v) => v.value === value)?.name ?? "(목록에 없음)";

  a.said.length = 0; a.wire.length = 0; a.usage.length = 0;
  await a.call("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: ASK }] });
  const says = a.said.join("").trim().split("\n")[0].slice(0, 40);
  // 🔴 **목록에 있는 값은 뺀다** — 그게 첫 판을 거꾸로 읽게 만든 것이다
  const wire = [...new Set(a.wire)].filter((s) => !all.includes(s));
  const ctx = sizeOf(a.usage);

  a.proc.kill();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  return { version, pick, note, value, label, says, wire, ctx, all };
}

const big = (n) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

(async () => {
  const rows = [];
  for (const p of PLAN) {
    process.stdout.write(`[${p.version}] ${p.note}…\n`);
    const r = await once(p);
    console.log(`   값 ${r.value}  ·  이름 「${r.label}」`);
    console.log(`   스스로 대는 신분: ${r.says}`);
    console.log(`   선로 (목록값 제외): ${r.wire.join(" · ") || "(없음)"}`);
    console.log(`   맥락 크기: ${r.ctx ? big(r.ctx) : "(안 알려줌)"}\n`);
    rows.push(r);
  }

  const [oldDef, , newOpus, newPinned] = rows;

  console.log("═══ 시나리오 ═══\n");
  console.log(`  지금 (핀 0.81.2) — 아무것도 안 고른 방`);
  console.log(`    값 ${oldDef.value} · 「${oldDef.label}」 · ${oldDef.says} · 맥락 ${big(oldDef.ctx)}\n`);
  console.log(`  핀을 0.84.0 으로 올린 뒤`);
  console.log(`    ${oldDef.value} 은 목록에 ${newOpus.all.includes(oldDef.value) ? "있다" : "**없다**"} → ${newOpus.value} 로 간다`);
  console.log(`    값 ${newOpus.value} · 「${newOpus.label}」 · ${newOpus.says} · 맥락 ${big(newOpus.ctx)}\n`);

  const sameName = oldDef.label === newOpus.label;
  const sameModel = oldDef.says.replace(/\[1m\]/, "") === newOpus.says.replace(/\[1m\]/, "");
  const sameCtx = oldDef.ctx === newOpus.ctx;

  console.log("═══ 판정 ═══\n");
  console.log(`  ① 이름   ${sameName ? "같다" : "**다르다**"}   「${oldDef.label}」 → 「${newOpus.label}」`);
  console.log(`  ② 모델   ${sameModel ? "같다" : "**다르다**"}   ${oldDef.says} → ${newOpus.says}`);
  console.log(`  ③ 맥락   ${sameCtx ? "같다" : "**다르다**"}   ${big(oldDef.ctx)} → ${big(newOpus.ctx)}\n`);

  if (sameName && sameModel && sameCtx) {
    console.log("  ✅ 셋 다 같다 — 표기만 갈렸다. «입을 다문다» 가 맞다.");
  } else if (sameName && sameModel && !sameCtx) {
    console.log("  🔴 **이름도 모델도 같은데 맥락만 줄어든다.**");
    console.log("     우리의 «이름이 같으면 입을 다문다» 규칙이 이걸 통째로 덮는다.");
    console.log("     사용자는 긴 대화가 갑자기 잘리기 시작해야 알아챈다 —");
    console.log("     그때도 원인은 모른다. 맥락도 같이 봐야 한다.");
  } else if (sameName && !sameModel) {
    console.log("  🔴 **이름은 같은데 모델이 갈린다.** «입을 다문다» 가 진짜 변화를 덮는다.");
  } else {
    console.log("  ✅ 이름이 다르므로 «바뀌었다» 알림이 나간다 — 덮이지 않는다.");
  }

  console.log(`\n  곁들여 — 0.84.0 의 박힌 id «${newPinned.value}»`);
  console.log(`    「${newPinned.label}」 · ${newPinned.says} · 맥락 ${big(newPinned.ctx)}`);
  console.log(`    이걸 고르면 판이 말없이 올라가는 일 자체가 없어진다.`);
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
