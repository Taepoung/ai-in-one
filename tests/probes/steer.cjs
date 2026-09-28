/**
 * **도는 중에 또 보내면 어떻게 되나** — steering이 되나.
 *
 * 우리는 지금 무조건 큐에 쌓고 턴이 끝나야 보낸다. 로드맵에는 *"ACP 세션은
 * 순차적이다 … 거부하거나 상태가 꼬이거나 응답 스트림이 섞인다"* 고 적혀 있는데,
 * **그건 재본 것이 아니라 스펙을 읽고 쓴 문장이다.** ACP에 steering 메서드는
 * 없다(`session/prompt` 하나뿐). 그러면 남는 질문은 하나다:
 *
 *   진행 중인 턴에 `session/prompt`를 또 보내면 **실제로** 무슨 일이 벌어지나.
 *
 *   (가) 에러로 거부한다        → 큐가 유일한 길이다
 *   (나) 조용히 무시한다        → 최악. 보낸 줄 알고 넘어간다
 *   (다) 둘째가 먼저 답을 받는다 → 스트림이 섞인다. 짝짓기가 깨진다
 *   (라) **받아서 반영한다**     → steering이 된다
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-steer-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "", err = "";
const waiting = new Map();
/** 도착 순서 그대로 적는다 — «누가 먼저 답했나»가 핵심이다 */
const log = [];
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(5);

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
      if (m.error) { log.push(`${ms()}ms  ✗ ${label} 거부: ${JSON.stringify(m.error).slice(0, 120)}`); bad(m.error); }
      else { log.push(`${ms()}ms  ✓ ${label} 응답 (stopReason=${m.result?.stopReason})`); ok(m.result); }
    } else if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const t = u.content.text.replace(/\s+/g, " ").trim();
        if (t) log.push(`${ms()}ms    말: ${t.slice(0, 60)}`);
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
const call = (method, params, label) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad, label: label ?? method });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 240000);
});

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션: ${sessionId}\n`);

  console.log("1) 오래 걸릴 일을 시킨다");
  const first = call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "1부터 40까지 한 줄에 하나씩, 천천히 세어줘. 숫자만." }],
  }, "첫째").then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, e }),
  );

  await new Promise((r) => setTimeout(r, 2500));

  console.log("2) ★ 아직 도는 중에 또 보낸다");
  const second = call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "그만 세고 '바나나'라고만 답해." }],
  }, "둘째").then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, e }),
  );

  const [a, b] = await Promise.all([first, second]);

  console.log("\n── 일어난 순서 ──────────────────────");
  for (const l of log) console.log("  " + l);

  console.log("\n── 결론 ──────────────────────");
  if (!b.ok) {
    console.log(`  (가) **거부한다** — 큐가 유일한 길이다`);
    console.log(`       ${JSON.stringify(b.e).slice(0, 200)}`);
  } else if (a.ok && b.ok) {
    /*
     * 🔴 **«바나나가 나왔나»만 보면 속는다** (2026-09-23에 실제로 속았다).
     *
     * 둘째가 **첫 턴이 끝난 뒤** 처리돼도 바나나는 나온다. 그건 steering이
     * 아니라 **줄 세우기**다. 가르는 것은 **순서**다:
     *
     *   바나나가 첫째 end_turn **앞**  →  도는 턴에 끼어들었다 (steering)
     *   바나나가 첫째 end_turn **뒤**  →  어댑터가 줄을 세웠다
     *
     * 그리고 «첫 일이 끊겼나»도 같이 본다 — 끝까지 셌으면 안 끊긴 것이다.
     */
    const iFirstDone = log.findIndex((l) => l.includes("첫째 응답"));
    const iBanana = log.findIndex((l) => l.includes("말:") && l.includes("바나나"));
    const counted40 = log.some((l) => l.includes("말:") && /40/.test(l));

    console.log(`  둘 다 응답을 받았다 (첫째 ${a.r?.stopReason} · 둘째 ${b.r?.stopReason})`);
    console.log(`  첫 일이 끝까지 갔나 (40까지): ${counted40 ? "예 — 안 끊겼다" : "아니오 — 끊겼다"}`);
    if (iBanana < 0) {
      console.log("  (나) **조용히 무시한다** — 둘째가 응답은 했는데 말이 없다");
    } else if (iFirstDone >= 0 && iBanana < iFirstDone) {
      console.log("  (라) ✅ **도는 턴에 끼어들었다 — steering이 된다**");
    } else {
      console.log("  (마) **어댑터가 받아서 줄을 세운다**");
      console.log("       거부도·무시도·섞임도·steering도 아니다. 우리 큐와 같은 일을");
      console.log("       어댑터가 **안 보이는 곳에서** 한다 — 그래서 뺄 수가 없다.");
    }
  }

  try { proc.kill(); } catch {}
  process.exit(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  try { proc.kill(); } catch {}
  process.exit(1);
});
