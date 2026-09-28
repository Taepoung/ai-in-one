/**
 * **막힌 Edit 가 ACP 로 뭐라고 올라오나** (실측).
 *
 * 실측으로 확인한 것: Edit·Write 는 «읽은 뒤 파일이 바뀌었고 내가 고칠 자리가
 * 겹치면» 거부한다 — *File has been modified since read*. 그러면 봇은 안 망가지는
 * 대신 **다시 읽고 재시도**한다. 그 낭비가 조용하다는 게 문제였다.
 *
 * 여기서 보려는 것: 그 거부가 `session/update` 의 `tool_call` 로 올라오나?
 *   - status 가 "failed" 인가?
 *   - 사유 글("modified since read")이 실려 오나?
 *
 * 올라온다면 **부딪힘을 추측할 필요가 없다** — 에이전트가 대놓고 말해주는 것이라
 * `noteClash` 의 정황("같은 파일 만졌고 둘 다 도는 중") 대신 사실을 쓸 수 있다.
 *
 * 한 세션으로 경주를 **결정적으로** 재현한다:
 *   ① 읽힌다  ② 밖에서 그 줄을 바꾼다  ③ 다시 읽지 말고 고치라고 한다
 * 이게 실제 경주(T0에 읽고 T5에 쓰는 사이 남이 바꿈)와 같은 상황이다.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const ARGS = ["-y", "@agentclientprotocol/claude-agent-acp"];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clash-"));
const FILE = path.join(dir, "clash.ts");
fs.writeFileSync(FILE, "aaa\nTARGET LINE\nccc\n");

const proc = spawn(CMD, ARGS, { shell: true, stdio: ["pipe", "pipe", "pipe"], cwd: dir });
let buf = "";
let nextId = 1;
const waiting = new Map();
const updates = [];
let sessionId = null;

function send(obj) { proc.stdin.write(JSON.stringify(obj) + "\n"); }
function call(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }

    // 에이전트가 우리에게 보내는 요청
    if (m.method && m.id !== undefined) {
      if (m.method === "session/request_permission") {
        const opts = m.params?.options ?? [];
        const pick = opts.find((o) => o.kind === "allow_always")
                  ?? opts.find((o) => o.kind === "allow_once") ?? opts[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: pick?.optionId } } });
      } else if (m.method === "fs/read_text_file" || m.method === "fs/readTextFile") {
        let content = ""; try { content = fs.readFileSync(m.params.path, "utf8"); } catch {}
        send({ jsonrpc: "2.0", id: m.id, result: { content } });
      } else if (m.method === "fs/write_text_file" || m.method === "fs/writeTextFile") {
        try { fs.writeFileSync(m.params.path, m.params.content); } catch {}
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
      continue;
    }
    // 알림
    if (m.method === "session/update") { updates.push(m.params); continue; }
    // 응답
    if (m.id !== undefined && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    }
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => process.stderr.write("[agent] " + c));

const show = (label) => {
  console.log(`\n── ${label} ──────────────────────────────`);
  for (const u of updates) {
    const up = u.update ?? u;
    if (up.sessionUpdate !== "tool_call" && up.sessionUpdate !== "tool_call_update") continue;
    const paths = (up.locations ?? []).map((l) => l.path).join(",");
    console.log(`  ${up.sessionUpdate.padEnd(17)} ${String(up.status).padEnd(12)} ${up.title ?? ""} ${paths ? "· " + path.basename(paths) : ""}`);
    for (const c of up.content ?? []) {
      const t = c?.content?.text ?? c?.text;
      if (t) console.log(`      └ ${JSON.stringify(String(t).slice(0, 300))}`);
    }
    if (up.rawOutput) console.log(`      └ rawOutput: ${JSON.stringify(up.rawOutput).slice(0, 300)}`);
  }
  updates.length = 0;
};

(async () => {
  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const s = await call("session/new", { cwd: dir, mcpServers: [] });
    sessionId = s.sessionId;
    console.log("세션 열림:", sessionId);

    console.log("\n① 읽힌다");
    await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "clash.ts 를 읽고 2번째 줄이 뭔지만 한 줄로 답해줘. 고치지는 마." }],
    });
    show("① 읽기");

    console.log("② 밖에서 그 줄을 바꾼다 (다른 봇이 고친 것처럼)");
    fs.writeFileSync(FILE, "aaa\nALPHA CHANGED THIS\nccc\n");

    console.log("\n③ 다시 읽지 말고 고치라고 한다");
    await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text:
        "clash.ts 에서 'TARGET LINE' 을 'BETA LINE' 으로 Edit 도구로 바꿔줘. " +
        "파일을 다시 읽지 말고 바로 Edit 를 호출해. 실패하면 재시도하지 말고 실패했다고만 말해줘." }],
    });
    show("③ 충돌한 Edit");

    console.log("\n최종 파일 내용:");
    console.log(fs.readFileSync(FILE, "utf8").split("\n").map((l) => "  " + l).join("\n"));
  } catch (e) {
    console.error("에러:", e.message);
  } finally {
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
