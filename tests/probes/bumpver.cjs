/**
 * **핀을 올리면 세션을 잃나 — 그리고 모델 목록은 따라오나** (2026-09-29).
 *
 * 사용자 물음: *"버전이 올라가면 자동으로 추적해서 바뀌어? 세션을 안잃고?"*
 *
 * 우리는 어댑터를 `@0.81.2` 로 **박아뒀다.** 그 핀이 SDK `0.3.280` 을 박고,
 * 그 안에 `claude.exe` 가 통째로 들어 있다 — 모델 이름·설명 문자열이 **그
 * 바이너리 안에** 있다(`grep` 으로 확인). 즉 핀을 안 올리면 목록은 **안
 * 바뀐다.** 사용자가 제 `claude` CLI 를 올려도 우리와 무관하다.
 *
 * 그러면 남는 물음은 **핀을 올릴 때**다:
 *
 *   ① 목록이 실제로 달라지나            (0.81.2 vs 최신)
 *   ② 옛 판이 만든 세션을 새 판이 잇나  ← «세션을 안잃고?»
 *
 * ②가 진짜다. 못 이으면 핀 올리기가 **모든 방의 맥락을 버리는 일**이 된다.
 * 그러면 «조용히 업데이트» 같은 건 아예 못 한다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const OLD = "0.81.2";
const NEW = process.argv[2] ?? "0.84.0";
const SECRET = "청록색 마흔둘";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-bump-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";

function start(version) {
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
        if (m.error) bad(new Error(JSON.stringify(m.error))); else ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          said.push(u.content.text);
        }
      } else if (m.method === "session/request_permission") {
        const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId))
          ?? m.params?.options?.[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      } else if (m.id !== undefined) {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { err += c; });

  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 240000);
  });

  return { proc, call, said, stderr: () => err };
}

const flat = (opt) => {
  const out = [];
  for (const e of opt?.options ?? []) { if (e.options) out.push(...e.options); else out.push(e); }
  return out;
};
const modelOpt = (options) => (options ?? []).find((o) => o.category === "model" || o.id === "model");
const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };

(async () => {
  // ── 옛 판: 세션을 하나 만들고 비밀을 심는다 ──────────────────────
  console.log(`\n[${OLD} — 세션을 만들고 비밀을 심는다]`);
  const a = start(OLD);
  const initA = await a.call("initialize", INIT);
  const sessA = await a.call("session/new", { cwd, mcpServers: [] });
  const sid = sessA.sessionId;
  const modelsA = flat(modelOpt(sessA.configOptions)).map((v) => `${v.value}=${v.name}`);
  console.log(`   sessionId ${sid}`);
  console.log(`   모델: ${modelsA.join(" · ")}`);

  await a.call("session/prompt", {
    sessionId: sid,
    prompt: [{ type: "text", text: `암호는 «${SECRET}» 이야. 딴 말 말고 "외웠어" 라고만 해.` }],
  });
  console.log(`   답: ${a.said.join("").trim().slice(0, 60)}`);
  a.proc.kill();
  await new Promise((r) => setTimeout(r, 1500));

  // ── 새 판: 그 세션을 이어받아 본다 ──────────────────────────────
  console.log(`\n[${NEW} — 옛 판이 만든 세션을 이어받아 본다]`);
  const b = start(NEW);
  const initB = await b.call("initialize", INIT);
  const capB = initB.agentCapabilities ?? {};
  console.log(`   resume ${Boolean(capB.sessionCapabilities?.resume)} · load ${Boolean(capB.loadSession)}`);

  let resumed, how = "resume";
  try {
    resumed = await b.call("session/resume", { sessionId: sid, cwd });
  } catch (e) {
    console.log(`   resume 실패: ${e.message.slice(0, 120)}`);
    how = "load";
    resumed = await b.call("session/load", { sessionId: sid, cwd });
  }
  mark(true, `«${how}» 로 이어받았다 — 에러 없이 돌아왔다`);

  const modelsB = flat(modelOpt(resumed?.configOptions)).map((v) => `${v.value}=${v.name}`);
  console.log(`   모델: ${modelsB.length ? modelsB.join(" · ") : "(응답에 없음)"}`);

  // ★ 진짜 판정 — 기억하나
  b.said.length = 0;
  await b.call("session/prompt", {
    sessionId: sid,
    prompt: [{ type: "text", text: "아까 내가 알려준 암호가 뭐였지? 그 말만 그대로 적어." }],
  });
  const back = b.said.join("").trim();
  console.log(`   답: ${back.slice(0, 120)}`);

  console.log("\n[판정]");
  mark(back.includes(SECRET), `★ **세션을 안 잃는다** — 옛 판의 비밀을 새 판이 기억한다`);
  const same = modelsA.join("|") === modelsB.join("|");
  if (modelsB.length === 0) {
    console.log("  ?? - 모델 목록이 복구 응답에 안 실려 왔다 — 비교 불가");
  } else {
    mark(!same, `★ 목록이 ${same ? "**똑같다** — 핀을 올려도 안 바뀐다" : "달라진다 — 핀이 곧 모델 판이다"}`);
    for (const v of modelsB) if (!modelsA.includes(v)) console.log(`     + ${v}`);
    for (const v of modelsA) if (!modelsB.includes(v)) console.log(`     - ${v}`);
  }

  b.proc.kill();
})().catch((e) => {
  console.error("실패:", e?.message ?? e);
  process.exit(1);
});
