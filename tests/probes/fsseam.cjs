/**
 * **에이전트의 파일 접근이 «우리»를 거치나** (2026-09-28).
 *
 * 우리는 `initialize` 에서 `fs: { readTextFile: true, writeTextFile: true }` 를
 * 광고한다. 광고대로라면 에이전트가 파일을 읽을 때 **우리를 부르고 답을
 * 기다린다** — 그게 «도구 결과 이음매»에 우리가 서 있는 자리다.
 *
 * 그런데 **광고했다고 쓰는 건 아니다.** 어댑터가 제 손으로 fs 를 만져도
 * 프로토콜상 문제가 없다. 실제로 동시 쓰기 실험(`winwrite*.cjs`)에서는 파일이
 * **OS 수준에서** 덮여 썼는데, 그건 우리를 안 거쳤다는 뜻일 수 있다
 * (다만 그때는 `writeTextFile: false` 로 광고했으므로 결론이 안 된다).
 *
 * 그래서 **켜 놓고** 잰다:
 *   ① Read 가 `fs/read_text_file` 로 우리에게 오나
 *   ② Write/Edit 가 `fs/write_text_file` 로 우리에게 오나
 *
 * 온다면 우리는 **턴 한가운데서 에이전트를 붙잡고 있는 자리**를 이미 갖고 있다.
 * 안 온다면 그 자리는 MCP 뿐이다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-fsseam-"));
fs.writeFileSync(path.join(cwd, "note.txt"), "첫째 줄\n둘째 줄\n셋째 줄\n", "utf8");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@" + (process.env.AIO_ACP_VERSION || "0.81.2")], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "", err = "";
const waiting = new Map();
/** 에이전트가 **우리를** 부른 기록 */
const calledUs = [];
/** 에이전트가 제 손으로 돌린 도구들 */
const tools = [];
const said = [];

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
      if (m.error) bad(m.error); else ok(m.result);
      continue;
    }
    if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        said.push(u.content.text);
      } else if (u?.sessionUpdate === "tool_call") {
        tools.push(u.title ?? u.kind ?? "?");
      }
      continue;
    }
    if (m.method === "session/request_permission") {
      calledUs.push("session/request_permission");
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      continue;
    }
    // ★ 여기가 재려는 자리 — 우리가 **답을 쥐고 있는** 동안 에이전트는 멈춰 있다
    if (m.method === "fs/read_text_file") {
      calledUs.push(`fs/read_text_file ${path.basename(m.params?.path ?? "?")}`);
      let content = "";
      try { content = fs.readFileSync(m.params.path, "utf8"); } catch { /* 없으면 빈 것 */ }
      send({ jsonrpc: "2.0", id: m.id, result: { content } });
      continue;
    }
    if (m.method === "fs/write_text_file") {
      calledUs.push(`fs/write_text_file ${path.basename(m.params?.path ?? "?")}`);
      try { fs.writeFileSync(m.params.path, m.params.content, "utf8"); } catch { /* 무시 */ }
      send({ jsonrpc: "2.0", id: m.id, result: {} });
      continue;
    }
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 180000);
});
const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);
const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
  process.exit(code);
};

(async () => {
  // ★ **우리 앱이 광고하는 그대로** 켠다 (acpConnection.ts 300줄)
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}\n폴더 : ${cwd}\n`);

  console.log("[① 읽기]");
  await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "note.txt 의 둘째 줄만 그대로 말해줘. 설명 없이." }],
  });
  const afterRead = calledUs.length;
  console.log(`   에이전트가 돌린 도구: ${tools.join(", ") || "없음"}`);
  console.log(`   우리를 부른 것      : ${calledUs.join(" · ") || "없음"}`);
  console.log(`   답                  : «${said.join("").replace(/\s+/g, " ").trim().slice(0, 60)}»`);

  console.log("\n[② 쓰기]");
  const before = tools.length;
  await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "note.txt 의 넷째 줄에 «넷째 줄» 을 덧붙여줘." }],
  });
  console.log(`   에이전트가 돌린 도구: ${tools.slice(before).join(", ") || "없음"}`);
  console.log(`   우리를 부른 것      : ${calledUs.slice(afterRead).join(" · ") || "없음"}`);

  const readSeam = calledUs.some((c) => c.startsWith("fs/read_text_file"));
  const writeSeam = calledUs.some((c) => c.startsWith("fs/write_text_file"));
  console.log("");
  mark(readSeam, readSeam
    ? "★ **읽기가 우리를 거친다** — 턴 한가운데서 에이전트를 붙잡는 자리가 있다"
    : "🔴 읽기는 우리를 안 거친다 — 광고만 하고 안 쓴다");
  mark(writeSeam, writeSeam
    ? "★ **쓰기도 우리를 거친다**"
    : "🔴 쓰기는 우리를 안 거친다 — 어댑터가 제 손으로 파일을 만진다");

  console.log(`\n  (참고) 실제 파일 끝: «${fs.readFileSync(path.join(cwd, "note.txt"), "utf8").trim().split("\n").pop()}»`);
  if (err.trim()) console.log("  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
