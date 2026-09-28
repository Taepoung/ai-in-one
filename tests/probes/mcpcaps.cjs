/**
 * **MCP 서버가 먼저 말할 수 있나, 그리고 무슨 말을 할 수 있나** — §7.
 *
 * `mcplist.cjs` 에서 절반은 봤다: Claude는 `GET … text/event-stream` 을 열고
 * Codex는 안 연다. 그건 **통로**가 있느냐다. 남은 절반은 **어휘**다 —
 * MCP에서 서버→클라이언트로 갈 수 있는 것은 정해진 목록이고, 그중 무엇을
 * 이 클라이언트가 받아주는지는 `initialize` 의 `capabilities` 에 적혀 온다.
 *
 * 🔴 지난 프로브는 `protocolVersion` 만 찍고 **capabilities를 버렸다.**
 * 그래서 «먼저 말할 수 있나»를 절반만 알고 있었다.
 *
 * 턴을 안 돈다 — `session/new` 만 해도 MCP `initialize` 가 들어온다.
 * **모델 토큰 0.**
 *
 *   node mcpcaps.cjs claude
 *   node mcpcaps.cjs codex
 */
const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const WHICH = (process.argv[2] || "claude").toLowerCase();
const AGENT = {
  claude: ["-y", "@agentclientprotocol/claude-agent-acp"],
  codex: ["-y", "@agentclientprotocol/codex-acp"],
}[WHICH];
if (!AGENT) { console.log("claude 또는 codex"); process.exit(1); }

const SECRET = "aio-" + Math.random().toString(36).slice(2);
let clientCaps = null, clientInfo = null, streamOpen = false;

const server = http.createServer((req, res) => {
  if (req.headers["x-aio-secret"] !== SECRET) { res.writeHead(401).end("no"); return; }

  if (req.method === "GET") {
    if (String(req.headers.accept || "").includes("text/event-stream")) {
      streamOpen = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": open\n\n");
      return;
    }
    res.writeHead(405).end("no");
    return;
  }

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400).end("bad"); return; }
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    switch (msg.method) {
      case "initialize":
        clientCaps = msg.params?.capabilities ?? {};
        clientInfo = msg.params?.clientInfo ?? {};
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true }, logging: {} },
          serverInfo: { name: "ai-in-one", version: "0.1.0" },
        });
      case "tools/list":
        return reply({ tools: [] });
      default:
        if (msg.id === undefined) { res.writeHead(202).end(); return; }
        return reply({});
    }
  });
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-caps-"));

server.listen(0, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
  const proc = spawn(CMD, AGENT, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });

  let seq = 0, buf = "";
  const waiting = new Map();
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
      } else if (m.id !== undefined) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
      }
    }
  });
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout " + method))), 120000);
  });

  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await call("session/new", {
      cwd,
      mcpServers: [{ type: "http", name: "ai-in-one", url, headers: [{ name: "x-aio-secret", value: SECRET }] }],
    });
    await new Promise((r) => setTimeout(r, 1500));

    console.log(`\n[${WHICH}] MCP 클라이언트가 우리에게 밝힌 것`);
    console.log(`  clientInfo   : ${JSON.stringify(clientInfo)}`);
    console.log(`  capabilities : ${JSON.stringify(clientCaps, null, 2)}`);
    console.log(`\n  서버→클라이언트 통로(GET SSE) : ${streamOpen ? "열렸다" : "**안 열렸다**"}`);
    const has = (k) => (clientCaps && k in clientCaps ? "✅" : "❌");
    console.log(`  sampling   (서버가 모델 호출을 시킨다) : ${has("sampling")}`);
    console.log(`  elicitation(서버가 사용자에게 묻는다)  : ${has("elicitation")}`);
    console.log(`  roots      (서버가 작업 폴더를 묻는다) : ${has("roots")}`);
  } catch (e) {
    console.log(`오류: ${e.message}`);
  }
  try { proc.kill(); } catch {}
  server.close();
  process.exit(0);
});
