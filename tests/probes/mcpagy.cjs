/**
 * **Antigravity 가 우리 MCP 도구를 쓰나** — M1·M6·M4 (2026-10-08).
 *
 * §7 의 도구 경로 실측은 Claude·Codex 둘뿐이었다. Antigravity 는 v2.2 에서
 * 들였는데 **한 번도 안 쟀다.** 그 결과가 V3.md 2.3(태그 폴백을 만드나)을
 * 가른다.
 *
 * 한 번에 넷을 찍는다:
 *
 *   M1  mcpCapabilities 를 뭐라고 광고하나 · 실제로 tools/call 을 부르나
 *   M6  우리 도구를 권한으로 막나 · ToolCall.name 이 오나 · readOnlyHint 를 보나
 *   M4  usage / UsageUpdate 를 실제로 보내나
 *
 * 설치된 것을 그대로 띄운다 — 124MB 를 다시 받지 않는다.
 *
 *   node tests/probes/mcpagy.cjs
 */
const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const WHICH = (process.argv[2] || "antigravity").toLowerCase();

/** 띄울 것 — 설치된 것을 그대로 쓴다 (다시 받지 않는다) */
function launcher() {
  if (WHICH === "antigravity") {
    const exe = path.join(
      process.env.APPDATA || "", "Code", "User", "globalStorage",
      "taein-yoon.ai-in-one", "agents", "antigravity", "agy_acp_server.exe",
    );
    if (!fs.existsSync(exe)) { console.log("설치된 Antigravity 가 없다:", exe); process.exit(1); }
    return { cmd: exe, args: [], shell: false };
  }
  if (WHICH === "codex") {
    const { argsOf } = require("./pinned.cjs");
    return {
      cmd: process.platform === "win32" ? "npx.cmd" : "npx",
      args: argsOf("codex"),
      shell: true,
    };
  }
  console.log("antigravity 또는 codex"); process.exit(1);
}
const LAUNCH = launcher();

const SECRET = "aio-" + Math.random().toString(36).slice(2);
const seen = { list: 0, calls: [], perms: [], updates: [], usage: [] };

/** 도구 둘 — 하나는 읽기 전용이라고 **광고**하고 하나는 안 한다 */
const TOOLS = [
  {
    name: "aio_peek",
    description: "AI in One 의 대기열을 들여다본다. 아무것도 바꾸지 않는다.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, title: "대기열 보기" },
  },
  {
    name: "aio_say",
    description: "AI in One 의 같은 방에 있는 다른 봇에게 말을 건다.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
  },
];

const server = http.createServer((req, res) => {
  if (req.headers["x-aio-secret"] !== SECRET) { res.writeHead(401).end("no"); return; }
  if (req.method === "GET") { res.writeHead(405).end("no"); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end("bad"); return; }
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    };
    switch (m.method) {
      case "initialize":
        console.log(`  · MCP initialize (protocol ${m.params?.protocolVersion})`);
        return reply({
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "ai-in-one", version: "0.1.0" },
        });
      case "tools/list":
        seen.list++;
        console.log(`  · tools/list #${seen.list}`);
        return reply({ tools: TOOLS });
      case "tools/call":
        seen.calls.push(m.params);
        console.log(`  ★ tools/call: ${m.params?.name} ${JSON.stringify(m.params?.arguments)}`);
        return reply({ content: [{ type: "text", text: "대기열에 2건 있습니다 (감자칠십칠)." }] });
      default:
        if (m.id === undefined) { res.writeHead(202).end(); return; }
        return reply({});
    }
  });
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mcpagy-"));

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  console.log(`우리 MCP 서버: ${url}\n`);

  const proc = spawn(LAUNCH.cmd, LAUNCH.args, { cwd, shell: LAUNCH.shell, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 0, buf = "", err = "";
  const waiting = new Map();
  const said = [];

  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout " + method))), 240000);
  });

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
        seen.updates.push(u?.sessionUpdate);
        // M4 — usage 가 실려 오나. 칸을 고르지 않고 통째로 본다
        const s = JSON.stringify(u);
        if (/usage|totalTokens|inputTokens|contextWindow|cost/i.test(s)) {
          seen.usage.push(s.slice(0, 400));
        }
        if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
          console.log("  · " + u.sessionUpdate + ": " + JSON.stringify(u).slice(0, 500));
        }
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
      } else if (m.method === "session/request_permission") {
        // ★ M6 — 우리 도구에 권한을 묻나. 무엇을 실어 오나
        const tc = m.params?.toolCall ?? {};
        seen.perms.push({ name: tc.name ?? null, title: tc.title, kind: tc.kind, rawInput: tc.rawInput });
        console.log("  ★ request_permission toolCall 통째: " + JSON.stringify(tc).slice(0, 600));
        // ⑬ 무엇을 고르게 해주나 — allow_once 가 없으면 봇 심사가 통째로 사람에게 간다
        const kinds = (m.params?.options ?? []).map((o) => o.kind);
        console.log(`     options: ${JSON.stringify(kinds)}`
          + (kinds.includes("allow_once") ? "" : "   🔴 allow_once 가 없다"));
        const opt = (m.params?.options ?? []).find((o) => o.kind === "allow_once")
          ?? (m.params?.options ?? []).find((o) => /allow/i.test(o.kind ?? ""))
          ?? m.params?.options?.[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      } else if (m.id !== undefined) {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { err += c; });

  const done = (code) => {
    console.log("\n── 결과 ──────────────────────");
    console.log(`  tools/list      : ${seen.list} 번`);
    console.log(`  tools/call      : ${seen.calls.length} 번  ${JSON.stringify(seen.calls.map((c) => c.name))}`);
    console.log(`  권한 요청        : ${seen.perms.length} 번`);
    for (const p of seen.perms) console.log(`      name=${JSON.stringify(p.name)}  title=${JSON.stringify(p.title)}  kind=${p.kind}`);
    console.log(`  usage 흔적       : ${seen.usage.length} 개`);
    for (const u of seen.usage.slice(0, 3)) console.log("      " + u);
    console.log(`  update 종류      : ${[...new Set(seen.updates)].join(" · ")}`);
    if (said.length) console.log(`  모델이 한 말     : ${said.join("").slice(0, 300)}`);
    if (err.trim()) console.log(`  stderr          : ${err.trim().slice(0, 400)}`);
    try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    server.close();
    setTimeout(() => process.exit(code), 500);
  };

  try {
    const init = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    console.log("── initialize ────────────────");
    console.log(JSON.stringify(init, null, 2).slice(0, 2000));
    const mcp = init?.agentCapabilities?.mcpCapabilities;
    console.log(`\n  ★ mcpCapabilities: ${JSON.stringify(mcp)}`);
    if (!mcp?.http) {
      console.log("  🔴 http 를 광고하지 않는다 — 그래도 실어 보고 받는지 본다");
    }

    const sess = await call("session/new", {
      cwd,
      mcpServers: [{ type: "http", name: "ai-in-one", url, headers: [{ name: "x-aio-secret", value: SECRET }] }],
    });
    console.log(`\n  세션: ${sess?.sessionId}`);
    if (sess?.models) console.log(`  모델 ${sess.models.availableModels?.length ?? "?"}개`);

    await call("session/prompt", {
      sessionId: sess.sessionId,
      prompt: [{
        type: "text",
        text: "ai-in-one MCP 서버의 aio_peek 도구를 지금 한 번 호출하고, 돌아온 내용을 그대로 알려줘.",
      }],
    });
    done(0);
  } catch (e) {
    console.log("\n🔴 실패:", e.message);
    done(1);
  }
});
