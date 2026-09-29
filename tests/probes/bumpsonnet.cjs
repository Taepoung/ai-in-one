/**
 * **모델이 갈리면서 세션을 이어받으면 맥락이 사나** (2026-09-29).
 *
 * 사용자 물음: *"모델 버전이 올라가도 세션 잘 붙고 컨텍스트 유지된다는거지?"*
 *
 * 🔴 **아직 못 한 답이었다.** `bumpsafe.cjs` 에서 «이어받아도 다 기억한다»
 * 를 봤지만 그건 **기본값(opus) 방**이었고, opus 는 두 판에서 **같은 모델**
 * 이다(`opusbump.cjs`). 즉 «모델이 안 갈리는 세션» 을 이어받아 본 것이다.
 * 정작 모델이 갈리는 쪽은 sonnet 이다:
 *
 * ```
 * sonnet   0.81.2 → claude-sonnet-5
 *          0.84.0 → claude-sonnet-5-5
 * ```
 *
 * 그래서 진짜 물어야 할 것은 **둘이 겹칠 때**다 — 세션을 이어받으면서
 * 그 세션이 쓰던 모델이 바뀐다. 맥락을 기록이 들고 있으면 살고, 모델을
 * 갈아끼우며 새로 시작하면 죽는다. 둘 다 그럴듯하므로 **재야 안다.**
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const OLD = "0.81.2";
const NEW = process.argv[2] || "0.84.0";
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, session: { compaction: {} } },
};

function start(version, cwd) {
  const proc = spawn(CMD, ["-y", `@agentclientprotocol/claude-agent-acp@${version}`], {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  const said = [];
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
      if (m.id !== undefined && waiting.has(m.id)) {
        const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 250))); else ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
        if (u?.sessionUpdate === "usage_update" || u?.usage) usage.push(u.usage ?? u);
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
  return { proc, call, said, usage };
}

/**
 * 맥락 창 크기.
 *
 * 🔴 처음엔 «usage 어디든 제일 큰 수» 를 집었다. `1790.82M` 이 나왔다 —
 * 맥락일 리가 없는 수다. 비용이든 시각이든 딴 칸이 섞인 것이다.
 * **칸 이름을 보고 집는다.**
 */
function ctxSize(list) {
  for (const u of [...list].reverse()) {
    for (const key of ["contextWindow", "maxTokens", "size", "total", "limit"]) {
      const v = u?.[key];
      if (typeof v === "number" && v > 1000 && v < 100_000_000) return v;
    }
  }
  return 0;
}
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const mark = (c, m) => { console.log(`  ${c ? "OK" : "NO"} - ${m}`); return c; };
const nap = (t) => new Promise((r) => setTimeout(r, t));

async function say(a, sid, text) {
  a.said.length = 0;
  await a.call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] });
  return a.said.join("").trim().split("\n")[0].trim();
}
const WHO = "너의 정확한 모델 id 를 한 줄로만 적어. 설명·도구 사용 금지. 모르면 «모름».";

(async () => {
  const results = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-son-"));

  console.log(`\n[① ${OLD} · **sonnet 으로 맞추고** 세 턴을 심는다]`);
  const a = start(OLD, cwd);
  await a.call("initialize", INIT);
  const sess = await a.call("session/new", { cwd, mcpServers: [] });
  const sid = sess.sessionId;
  await a.call("session/set_config_option", { sessionId: sid, configId: "model", value: "sonnet" });

  const m1 = await say(a, sid, WHO);
  console.log(`   지금 모델: ${m1.slice(0, 40)}`);
  await say(a, sid, "첫째 암호는 «청록색 마흔둘» 이야. \"1\" 이라고만 답해.");
  await say(a, sid, "둘째 암호는 «보랏빛 아홉» 이야. \"2\" 라고만 답해.");
  await say(a, sid, "셋째 암호는 «잿빛 스물셋» 이야. \"3\" 이라고만 답해.");
  console.log(`   usage 원본: ${JSON.stringify(a.usage.at(-1) ?? null).slice(0, 220)}`);
  const ctx1 = ctxSize(a.usage);
  console.log(`   세 턴 심었다 · 맥락 ${ctx1 ? big(ctx1) : "(못 읽음)"}`);
  a.proc.kill();
  await nap(2000);

  console.log(`\n[② ${NEW} 로 올려서 이어받는다 — 여기서 모델이 갈린다]`);
  const b = start(NEW, cwd);
  await b.call("initialize", INIT);
  let how = "resume";
  try {
    await b.call("session/resume", { sessionId: sid, cwd });
  } catch {
    how = "load";
    await b.call("session/load", { sessionId: sid, cwd });
  }
  console.log(`   «${how}» 로 붙었다`);

  /*
   * 🔴 **이어받기만 하면 기본값으로 돌아간다** (2026-09-29 실측).
   *
   * 첫 판에서는 붙기만 하고 모델을 물었는데 `claude-opus-5-5` 가 나왔다 —
   * `sonnet` 으로 맞춰둔 세션이었는데도. 어댑터는 이어받을 때 설정을
   * **안 돌려준다.** 그걸 돌려놓는 것이 바로 우리 `restoreChoices` 다.
   *
   * 그래서 여기서도 같이 돌려놔야 **우리 제품이 가는 길**을 재는 것이 된다.
   * 안 그러면 «고른 모델이 날아간다» 는 엉뚱한 결론이 난다.
   */
  const raw = await say(b, sid, WHO);
  console.log(`   (돌려놓기 전) 모델: ${raw.slice(0, 40)}`);
  await b.call("session/set_config_option", { sessionId: sid, configId: "model", value: "sonnet" });
  console.log(`   restoreChoices 와 같이 «sonnet» 을 다시 넘겼다`);

  const m2 = await say(b, sid, WHO);
  console.log(`   모델: ${m1}  →  ${m2}`);
  results.push(mark(m1 !== m2, `★ **모델이 실제로 갈렸다** — 안 갈리면 이 측정은 뜻이 없다`));

  const back = await say(b, sid, "내가 알려준 암호 셋을 순서대로 한 줄에 적어.");
  console.log(`   답: ${back.slice(0, 140)}`);
  results.push(mark(
    back.includes("청록색") && back.includes("보랏빛") && back.includes("잿빛"),
    `★ **모델이 갈려도 맥락이 산다** — 세 턴을 다 기억한다`,
  ));

  console.log(`   usage 원본: ${JSON.stringify(b.usage.at(-1) ?? null).slice(0, 220)}`);
  const ctx2 = ctxSize(b.usage);
  console.log(`   맥락 창: ${ctx1 ? big(ctx1) : "?"} → ${ctx2 ? big(ctx2) : "?"}`);
  if (ctx1 && ctx2) results.push(mark(ctx2 >= ctx1, `★ 맥락 창이 안 줄었다 (${big(ctx1)} → ${big(ctx2)})`));
  else console.log("  ?? - 맥락 크기를 못 읽어서 비교 불가");

  b.proc.kill();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}

  console.log(`\n[판정] ${results.filter(Boolean).length}/${results.length} 통과`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
