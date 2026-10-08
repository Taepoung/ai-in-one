/**
 * **껐다 켜면 도구가 사나** — M2 (2026-10-08).
 *
 * 🔴 우리는 지금 `new`·`fork` 에만 `mcpServers` 를 넘기고 **`resume`·`load` 에는
 * 아예 안 싣는다**(`acpConnection.ts:510,705`). 그러면 **모든 방이 껐다 켜는
 * 순간 도구를 잃는다** — 옛 방 문제가 아니라 오늘의 버그다(V3.md 2.4).
 *
 * 셋을 본다:
 *
 *   ① 새 세션 + mcpServers                      부르나   (기준선)
 *   ② 프로세스를 새로 띄우고 resume + mcpServers  부르나
 *   ③ 같은 자리에서 resume, 단 mcpServers 없이    부르나   (대조군)
 *
 * ②가 되면 고칠 길이 있다. ③까지 되면 **에이전트가 들고 있던 것**이라
 * 우리가 안 실어도 된다.
 *
 *   node tests/probes/mcpresume.cjs [antigravity|codex]
 */
const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const WHICH = (process.argv[2] || "antigravity").toLowerCase();
function launcher() {
  if (WHICH === "antigravity") {
    const exe = path.join(
      process.env.APPDATA || "", "Code", "User", "globalStorage",
      "taein-yoon.ai-in-one", "agents", "antigravity", "agy_acp_server.exe",
    );
    if (!fs.existsSync(exe)) { console.log("설치된 Antigravity 가 없다"); process.exit(1); }
    return { cmd: exe, args: [], shell: false };
  }
  if (WHICH === "codex") {
    const { argsOf } = require("./pinned.cjs");
    return { cmd: process.platform === "win32" ? "npx.cmd" : "npx", args: argsOf("codex"), shell: true };
  }
  console.log("antigravity 또는 codex"); process.exit(1);
}
const LAUNCH = launcher();

const SECRET = "aio-" + Math.random().toString(36).slice(2);
let calls = [];
const TOOL = {
  name: "aio_peek",
  description: "AI in One 의 대기열을 들여다본다.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const server = http.createServer((req, res) => {
  if (req.headers["x-aio-secret"] !== SECRET) { res.writeHead(401).end("no"); return; }
  if (req.method === "GET") { res.writeHead(405).end("no"); return; }
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end("bad"); return; }
    const reply = (r) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: r }));
    };
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ai-in-one", version: "0.1.0" },
        });
      case "tools/list":
        return reply({ tools: [TOOL] });
      case "tools/call":
        calls.push(m.params?.name);
        return reply({ content: [{ type: "text", text: "대기열에 2건 (감자칠십칠)." }] });
      default:
        if (m.id === undefined) { res.writeHead(202).end(); return; }
        return reply({});
    }
  });
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mcpres-"));

function agent() {
  const proc = spawn(LAUNCH.cmd, LAUNCH.args, { cwd, shell: LAUNCH.shell, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 0, buf = "", err = "";
  const waiting = new Map();
  const said = [];
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
        m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
      } else if (m.method === "session/request_permission") {
        const o = (m.params?.options ?? []).find((x) => x.kind === "allow_once") ?? m.params?.options?.[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: o?.optionId } } });
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
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout " + method))), 180000);
  });
  const bye = () => {
    try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 이미 죽었다 */ }
  };
  return { call, said, bye, err: () => err };
}

const MCP = (url) => ({
  type: "http", name: "ai-in-one", url,
  headers: [{ name: "x-aio-secret", value: SECRET }],
});
const ASK = "ai-in-one MCP 서버의 aio_peek 도구를 지금 한 번 호출하고 결과를 그대로 알려줘.";
const CAPS = { fs: { readTextFile: false, writeTextFile: false } };
/** Codex 는 앞 프로세스가 세션을 놓을 때까지 걸린다 (PIN.md §F7) */
const WAIT = WHICH === "codex" ? 8000 : 1500;

server.listen(0, "127.0.0.1", async () => {
  const url = "http://127.0.0.1:" + server.address().port + "/mcp";
  console.log("[" + WHICH + "] 우리 MCP 서버: " + url + "\n");
  const out = [];
  let sessionId = null;

  try {
    const a = agent();
    const init = await a.call("initialize", { protocolVersion: 1, clientCapabilities: CAPS });
    console.log("  sessionCapabilities:", JSON.stringify(init?.agentCapabilities?.sessionCapabilities));
    const s = await a.call("session/new", { cwd, mcpServers: [MCP(url)] });
    sessionId = s.sessionId;
    calls = [];
    await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text: ASK }] });
    out.push(["① 새 세션 + mcpServers", String(calls.length) + "번"]);
    console.log("  ① 새 세션 + mcpServers        -> tools/call " + calls.length + "번");
    a.bye();
    await new Promise((r) => setTimeout(r, WAIT));

    const b = agent();
    await b.call("initialize", { protocolVersion: 1, clientCapabilities: CAPS });
    calls = [];
    try {
      await b.call("session/resume", { sessionId, cwd, mcpServers: [MCP(url)] });
      await b.call("session/prompt", { sessionId, prompt: [{ type: "text", text: ASK }] });
      out.push(["② resume + mcpServers", String(calls.length) + "번"]);
      console.log("  ② resume + mcpServers         -> tools/call " + calls.length + "번");
    } catch (e) {
      out.push(["② resume + mcpServers", "실패: " + e.message.slice(0, 100)]);
      console.log("  ② resume + mcpServers         -> 🔴 " + e.message.slice(0, 160));
    }
    b.bye();
    await new Promise((r) => setTimeout(r, WAIT));

    const c = agent();
    await c.call("initialize", { protocolVersion: 1, clientCapabilities: CAPS });
    calls = [];
    try {
      await c.call("session/resume", { sessionId, cwd });
      await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: ASK }] });
      out.push(["③ resume, mcpServers 없이", String(calls.length) + "번"]);
      console.log("  ③ resume, mcpServers 없이     -> tools/call " + calls.length + "번");
    } catch (e) {
      out.push(["③ resume, mcpServers 없이", "실패: " + e.message.slice(0, 100)]);
      console.log("  ③ resume, mcpServers 없이     -> 🔴 " + e.message.slice(0, 160));
    }
    console.log("\n  마지막 말: " + c.said.join("").slice(0, 200));
    c.bye();
  } catch (e) {
    console.log("\n🔴 실패: " + e.message);
  }

  console.log("\n── 결과 ──────────────────────");
  for (const row of out) console.log("  " + row[0].padEnd(26) + " " + row[1]);
  server.close();
  setTimeout(() => process.exit(0), 500);
});
