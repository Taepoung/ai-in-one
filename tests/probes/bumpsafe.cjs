/**
 * **핀을 올릴 때 세션을 잃나 — 넓게** (2026-09-29).
 *
 * 사용자 물음: *"근데 그렇게 올릴때 혹시 세션을 잃지는 않을까?"*
 *
 * `bumpver.cjs` 에서 이미 «안 잃는다» 를 봤다. 그런데 그건 **갓 만든 세션
 * 하나에 한 턴**이었다. 이 저장소에서 좁게 재서 «된다/안 된다» 를 거꾸로
 * 읽은 적이 네 번 있다 — 그러니 한 번 더 좁게 재고 «안전하다» 고 말하면
 * 같은 실수다. 진짜 상황은 이렇다:
 *
 *   세션 129개 · 가장 오래된 것 12일 전 · 긴 대화 · 진짜 프로젝트 폴더
 *
 * 그래서 세 가지를 더 본다.
 *
 * ```
 * ① 여러 턴짜리를 이어받나        — 한 턴은 «이어받기» 의 가장 쉬운 꼴이다
 * ② **되돌릴 수 있나**            ← 이게 핵심
 * ③ 0.84.0 이 옛 세션들을 보나    — session/list 로, 읽기만
 * ```
 *
 * ②가 핵심인 이유: 0.84.0 으로 올렸다가 뭔가 깨져서 0.81.2 로 돌아와야
 * 할 때, **그 사이에 오간 대화를 옛 판이 못 읽으면** 되돌리기가 곧 대화를
 * 버리는 일이 된다. 그러면 핀 올리기는 **한 방향 문**이고, 그건 올리기
 * 전에 알아야 하는 일이다.
 *
 * ③은 사용자의 진짜 세션을 건드린다 — 그래서 **`session/list` 만** 쓴다.
 * 읽기뿐이고 프롬프트를 안 보낸다. 이어받거나 지우지 않는다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const OLD = "0.81.2";
const NEW = process.argv[2] || "0.84.0";
const REAL_CWD = "C:/Users/BASE/Desktop/Taein Yoon/Project/AI_in_one";
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };

function start(version, cwd) {
  const proc = spawn(CMD, ["-y", `@agentclientprotocol/claude-agent-acp@${version}`], {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  const said = [];
  let seq = 0, buf = "", err = "";
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
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 300))); else ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          said.push(u.content.text);
        }
      } else if (m.method === "session/request_permission") {
        const o = m.params?.options?.[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: o?.optionId } } });
      } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { err += c; });

  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 240000);
  });
  return { proc, call, said, stderr: () => err, init: null };
}

const mark = (c, m) => { console.log(`  ${c ? "OK" : "NO"} - ${m}`); return c; };
const nap = (t) => new Promise((r) => setTimeout(r, t));

/** 세션을 이어받는다. resume 이 없거나 실패하면 load 로. */
async function attach(a, sessionId, cwd) {
  try {
    const r = await a.call("session/resume", { sessionId, cwd });
    return { how: "resume", res: r };
  } catch (e) {
    const r = await a.call("session/load", { sessionId, cwd });
    return { how: "load", res: r, why: String(e.message).slice(0, 100) };
  }
}

async function say(a, sessionId, text) {
  a.said.length = 0;
  await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return a.said.join("").trim();
}

(async () => {
  const results = [];

  // ══ ①② 여러 턴 → 올리고 → **되돌린다** ═══════════════════════
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-safe-"));
  console.log(`\n[① ${OLD} 에서 여러 턴짜리 세션을 만든다]`);
  const a = start(OLD, cwd);
  await a.call("initialize", INIT);
  const sess = await a.call("session/new", { cwd, mcpServers: [] });
  const sid = sess.sessionId;
  console.log(`   ${sid}`);

  await say(a, sid, "첫째 암호는 «청록색 마흔둘» 이야. \"1\" 이라고만 답해.");
  await say(a, sid, "둘째 암호는 «보랏빛 아홉» 이야. \"2\" 라고만 답해.");
  const t3 = await say(a, sid, "셋째 암호는 «잿빛 스물셋» 이야. \"3\" 이라고만 답해.");
  console.log(`   세 턴 심었다 (마지막 답: ${t3.slice(0, 20)})`);
  a.proc.kill();
  await nap(2000);

  console.log(`\n[② ${NEW} 로 올려서 이어받는다]`);
  const b = start(NEW, cwd);
  await b.call("initialize", INIT);
  const got = await attach(b, sid, cwd);
  console.log(`   «${got.how}»${got.why ? ` (resume 실패: ${got.why})` : ""}`);
  const back = await say(b, sid, "내가 알려준 암호 셋을 순서대로 한 줄에 적어.");
  console.log(`   답: ${back.slice(0, 120)}`);
  results.push(mark(
    back.includes("청록색") && back.includes("보랏빛") && back.includes("잿빛"),
    `★ **세 턴이 다 살아 있다** — 첫 턴까지 거슬러 기억한다`,
  ));

  // 새 판에서 한 턴 더 — 되돌릴 때 이게 살아남는지가 관건이다
  await say(b, sid, `넷째 암호는 «주홍빛 여든» 이야. "4" 라고만 답해.`);
  console.log(`   ${NEW} 에서 넷째 암호를 더 심었다`);
  b.proc.kill();
  await nap(2000);

  console.log(`\n[③ **되돌린다** — 다시 ${OLD} 로]`);
  const c = start(OLD, cwd);
  await c.call("initialize", INIT);
  let rolled = null, rollErr = null;
  try {
    rolled = await attach(c, sid, cwd);
    console.log(`   «${rolled.how}»${rolled.why ? ` (resume 실패: ${rolled.why})` : ""}`);
  } catch (e) {
    rollErr = String(e.message).slice(0, 200);
    console.log(`   이어받기 실패: ${rollErr}`);
  }
  if (rolled) {
    const back2 = await say(c, sid, "내가 알려준 암호 넷을 순서대로 한 줄에 적어.");
    console.log(`   답: ${back2.slice(0, 150)}`);
    results.push(mark(
      back2.includes("청록색") && back2.includes("주홍빛"),
      `★ **되돌려도 다 남는다** — 새 판에서 오간 넷째까지 옛 판이 읽는다`,
    ));
  } else {
    results.push(mark(false, "★ 되돌리면 세션을 못 읽는다 — 핀 올리기가 한 방향 문이다"));
  }
  c.proc.kill();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}

  // ══ ④ 진짜 프로젝트의 옛 세션들 — **읽기만** ══════════════════
  console.log(`\n[④ ${NEW} 가 이 프로젝트의 옛 세션들을 보나 — 목록만 읽는다]`);
  console.log(`   (프롬프트를 안 보낸다. 이어받지도 지우지도 않는다)`);
  const lists = {};
  for (const v of [OLD, NEW]) {
    const d = start(v, REAL_CWD);
    const init = await d.call("initialize", INIT);
    const can = Boolean(init?.agentCapabilities?.sessionCapabilities?.list);
    if (!can) { console.log(`   ${v}: session/list 를 안 준다`); lists[v] = null; }
    else {
      try {
        const r = await d.call("session/list", { cwd: REAL_CWD });
        lists[v] = (r?.sessions ?? []).map((s) => String(s.sessionId));
        console.log(`   ${v}: ${lists[v].length}개`);
      } catch (e) {
        console.log(`   ${v}: 실패 ${String(e.message).slice(0, 100)}`);
        lists[v] = null;
      }
    }
    d.proc.kill();
    await nap(1200);
  }
  if (lists[OLD] && lists[NEW]) {
    const missing = lists[OLD].filter((s) => !lists[NEW].includes(s));
    console.log(`   옛 판에만 있는 것: ${missing.length}개`);
    results.push(mark(missing.length === 0, `★ **새 판이 옛 세션을 다 본다** — 목록에서 사라지는 것이 없다`));
  } else {
    console.log("   ?? - 한쪽이 목록을 안 줘서 비교 불가");
  }

  console.log(`\n[판정] ${results.filter(Boolean).length}/${results.length} 통과`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
