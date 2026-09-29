/**
 * **별명 뒤의 진짜 모델은 서버가 정하나, 바이너리가 정하나** (2026-09-29).
 *
 * 사용자 물음: *"근데 cli를 업데이트해야 모델이 올라가나?"*
 *
 * 지금까지 잰 것은 **목록**이다 — 0.81.2 는 `sonnet=Sonnet 5`, 0.84.0 은
 * `sonnet=Sonnet 5.5`. 같은 시각·같은 계정인데 다르므로 **목록은 바이너리에
 * 박혀 있다**가 증명됐다.
 *
 * 그런데 그게 곧 «옛 모델이 돈다» 는 아니다. 두 갈래가 남는다:
 *
 * ```
 * ㉠ 클라이언트가 `sonnet` 을 **그대로 보낸다**
 *      → 서버가 오늘의 Sonnet 으로 푼다
 *      → **모델은 이미 최신.** 낡은 건 화면의 이름뿐이다
 *
 * ㉡ 클라이언트가 `sonnet` 을 **제 표로 풀어서** 보낸다
 *      → `claude-sonnet-5-2025…` 같은 박힌 id 가 나간다
 *      → **모델도 옛것.** CLI 를 올려야 올라간다
 * ```
 *
 * 둘은 사용자에게 완전히 다른 얘기다. ㉠이면 핀을 안 올려도 성능은
 * 따라오고, ㉡이면 우리가 사용자를 옛 모델에 묶어두고 있는 것이다.
 *
 * 가르는 법: **양쪽 판에 같은 별명으로 물어본다.** 모델이 제 신분을 대는
 * 것은 못 믿을 때가 있으므로, ACP 가 실어 보내는 `_meta`·usage 쪽도 같이
 * 긁는다 — 그쪽이 더 단단한 증거다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const VERSIONS = [process.argv[2] || "0.81.2", process.argv[3] || "0.84.0"];
const ALIAS = "sonnet";
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";

function start(version, cwd) {
  const proc = spawn(CMD, ["-y", `@agentclientprotocol/claude-agent-acp@${version}`], {
    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  const said = [];
  const metas = [];
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
      // 모델 이름이 들어 있을 만한 곳을 통째로 그러모은다
      if (/"model"|claude-[a-z]+-\d/.test(line)) metas.push(line.slice(0, 400));
      if (m.id !== undefined && waiting.has(m.id)) {
        const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) bad(new Error(JSON.stringify(m.error))); else ok(m.result);
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
  let err = "";
  proc.stderr.on("data", (c) => { err += c; });

  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 240000);
  });
  return { proc, call, said, metas, stderr: () => err };
}

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };
const ASK =
  "너의 정확한 모델 id 를 한 줄로만 적어. 설명·인사·도구 사용 전부 금지. " +
  "예: claude-sonnet-5-20260101. 모르면 «모름» 이라고만 적어.";

async function run(version) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-real-"));
  const a = start(version, cwd);
  await a.call("initialize", INIT);
  const sess = await a.call("session/new", { cwd, mcpServers: [] });

  // **같은 별명으로 맞춘다** — 이게 이 측정의 전부다
  let set = "(못 바꿈)";
  try {
    await a.call("session/set_config_option", {
      sessionId: sess.sessionId, configId: "model", value: ALIAS,
    });
    set = ALIAS;
  } catch (e) {
    try {
      await a.call("session/setConfigOption", {
        sessionId: sess.sessionId, configId: "model", value: ALIAS,
      });
      set = ALIAS;
    } catch (e2) { set = `(실패: ${String(e2.message).slice(0, 80)})`; }
  }

  a.said.length = 0;
  await a.call("session/prompt", {
    sessionId: sess.sessionId, prompt: [{ type: "text", text: ASK }],
  });
  const answer = a.said.join("").trim();
  a.proc.kill();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  return { version, set, answer, metas: a.metas };
}

(async () => {
  const out = [];
  for (const v of VERSIONS) {
    process.stdout.write(`\n[${v}] «${ALIAS}» 로 맞추고 신분을 묻는다…\n`);
    const r = await run(v);
    console.log(`   맞춘 값: ${r.set}`);
    console.log(`   답: ${r.answer.slice(0, 200).replace(/\n/g, " ⏎ ")}`);
    const ids = [...new Set(r.metas.join(" ").match(/claude-[a-z]+-[0-9][0-9a-z-]*/g) ?? [])];
    console.log(`   오간 줄에서 주운 모델 id: ${ids.length ? ids.join(" · ") : "(없음)"}`);
    out.push({ ...r, ids });
  }

  console.log("\n[판정]");
  const [a, b] = out;
  const same = a.answer.trim() === b.answer.trim();
  console.log(`  ${a.version} → «${a.answer.slice(0, 60)}»`);
  console.log(`  ${b.version} → «${b.answer.slice(0, 60)}»`);
  console.log(
    same
      ? "\n  → **같다.** 별명은 그대로 나가고 **서버가 푼다** —\n" +
        "     핀을 안 올려도 도는 모델은 따라 올라간다. 낡은 건 화면의 이름뿐."
      : "\n  → **다르다.** 클라이언트가 별명을 제 표로 풀어 보낸다 —\n" +
        "     핀을 안 올리면 **옛 모델에 묶인다.**",
  );
  console.log("\n  * 모델의 자기 신고는 완전히 믿을 것이 못 된다. 위의 «주운 id» 가 있으면 그쪽이 낫다.");
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  process.exit(1);
});
