/**
 * **도구 목록이 낡으면 갱신할 수 있나** — §7·§4.2.2 (도구 개수를 정하기 전).
 *
 * `ask_bot` 의 `inputSchema.enum` 은 **참여 봇 목록**이다. 그런데 스키마는
 * 세션을 열 때 한 번 오가므로, **봇을 나중에 초대하면 낡는다.** §7은 그걸
 * «재연결이 필요할 수 있다»고 적어뒀는데 — **그건 가정이지 측정이 아니다.**
 *
 * MCP에는 그걸 위한 게 이미 있다:
 *
 *   server capabilities: { tools: { listChanged: true } }
 *        → notifications/tools/list_changed
 *        → 클라이언트가 tools/list 를 **다시** 물어본다
 *
 * 되면 `list_bots` 도구가 필요 없다. 안 되면 필요하다. 그래서 잰다.
 *
 * 🔴 streamable HTTP에서 **서버가 먼저 말하려면** 클라이언트가
 * `GET ... Accept: text/event-stream` 을 열어둬야 한다. 그것부터 관찰한다.
 *
 *   node mcplist.cjs claude
 *   node mcplist.cjs codex
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
const calls = [];
const listedAt = [];          // tools/list 가 올 때마다 그때의 enum 을 적어둔다
let streamOpen = false;       // 클라이언트가 GET 스트림을 열었나
let pushed = false;           // 우리가 알림을 밀어넣었나
let sse = null;

/** 지금 내줄 봇 목록 — 도중에 «초대»로 늘린다 */
let roster = ["Codex"];

const toolList = () => ({
  tools: [{
    name: "ask_bot",
    description:
      "같은 채팅방의 다른 봇에게 물어보고 답을 받는다. 사용자가 다른 봇에게 " +
      "물어보라고 하면 이 도구를 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", enum: [...roster], description: "물어볼 봇" },
        message: { type: "string", description: "그 봇에게 전할 말" },
      },
      required: ["bot", "message"],
    },
  }],
});

const server = http.createServer((req, res) => {
  if (req.headers["x-aio-secret"] !== SECRET) { res.writeHead(401).end("no"); return; }

  // ── 서버가 먼저 말할 수 있는 통로 (MCP streamable HTTP)
  if (req.method === "GET") {
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/event-stream")) {
      streamOpen = true;
      console.log("  ✅ 클라이언트가 **GET 스트림을 열었다** — 서버가 먼저 말할 수 있다");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": open\n\n");
      sse = res;
      req.on("close", () => { sse = null; });
      return;
    }
    res.writeHead(405).end("no");
    return;
  }

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end("bad"); return; }

    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };

    switch (msg.method) {
      case "initialize":
        console.log(`  · MCP initialize (protocol ${msg.params?.protocolVersion})`);
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          // ★ 이번에는 **선언한다** — 지난 프로브는 `tools: {}` 였다
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "ai-in-one", version: "0.1.0" },
        });

      case "tools/list":
        listedAt.push([...roster]);
        console.log(`  · tools/list #${listedAt.length} — 지금 내주는 목록: [${roster.join(", ")}]`
          + (pushed ? "  ← **알림 뒤에 다시 물어봤다**" : ""));
        return reply(toolList());

      case "tools/call":
        calls.push(msg.params);
        console.log(`  ★ tools/call: ${JSON.stringify(msg.params?.arguments)}`);
        return reply({
          content: [{ type: "text", text: `${msg.params?.arguments?.bot}의 답: "알겠습니다."` }],
        });

      default:
        if (msg.id === undefined) { res.writeHead(202).end(); return; }
        return reply({});
    }
  });
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mcplist-"));

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  console.log(`[${WHICH}] 우리 MCP 서버: ${url}\n`);

  const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
  const proc = spawn(CMD, AGENT, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });

  let seq = 0, buf = "", err = "";
  const waiting = new Map();
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
        m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
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
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout " + method))), 240000);
  });
  const finish = (code) => { try { proc.kill(); } catch {} server.close(); process.exit(code); };

  const verdict = () => {
    console.log("\n── 결과 ──────────────────────");
    console.log(`  GET 스트림       : ${streamOpen ? "열렸다" : "**안 열렸다**"}`);
    console.log(`  tools/list 횟수  : ${listedAt.length}  ${JSON.stringify(listedAt)}`);
    console.log(`  tools/call 횟수  : ${calls.length}`);
    const sawNew = calls.some((c) => c.arguments?.bot === "리뷰어");
    if (calls.length === 0) {
      console.log("  🟡 도구를 안 불렀다 — «붙는다»까지만 확인된 것이다");
    } else if (sawNew) {
      console.log("  ★ **갱신이 된다** — 나중에 늘린 봇을 실제로 불렀다. `list_bots` 불필요");
    } else if (listedAt.length > 1) {
      console.log("  🟡 목록은 다시 물어봤는데 새 이름은 안 썼다 — 한 번 더 봐야 한다");
    } else {
      console.log("  ❌ **갱신이 안 된다** — 목록을 다시 안 물어봤다. `list_bots` 나 다른 길이 필요");
    }
  };

  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    console.log("1) 우리 MCP 서버를 물려 세션을 연다");
    const { sessionId } = await call("session/new", {
      cwd,
      mcpServers: [{
        type: "http", name: "ai-in-one", url,
        headers: [{ name: "x-aio-secret", value: SECRET }],
      }],
    });
    console.log(`   세션: ${sessionId}\n`);

    console.log("2) 첫 호출 — 지금 목록은 [Codex] 뿐이다");
    said.length = 0;
    await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "ask_bot 도구로 Codex에게 '테스트 좀 짜줘'라고 물어봐. 받은 답을 그대로 알려줘." }],
    });
    console.log(`   답: ${JSON.stringify(said.join("").trim().slice(0, 120))}\n`);

    console.log("3) ★ «리뷰어»를 초대했다 치고 목록을 늘린 뒤 알림을 민다");
    roster = ["Codex", "리뷰어"];
    pushed = true;
    if (sse) {
      sse.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
      console.log("   알림을 SSE로 밀어넣었다");
    } else {
      console.log("   🔴 **밀어넣을 통로가 없다** — 클라이언트가 GET 스트림을 안 열었다");
    }
    await new Promise((r) => setTimeout(r, 3000));

    /*
     * 🔴 **빠져나갈 길을 주면 안 된다.**
     *
     * 처음에는 *"도구가 리뷰어를 안 받으면 그렇다고 말해줘"* 라고 물었다.
     * 그건 유도다 — 모델은 시키는 대로 «안 받습니다»라고 답할 수 있고,
     * 그게 **스키마를 봐서인지 내 말을 따라서인지** 가릴 수가 없다.
     *
     * 대신 **모델이 지금 보고 있는 것을 그대로 읊게** 한다.
     */
    console.log("\n4) 같은 세션 — 모델이 지금 보는 enum 을 읊게 한다");
    said.length = 0;
    await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "ask_bot 도구의 bot 파라미터가 받는 값들을 그대로 나열해줘. 설명 없이 값만." }],
    });
    const seen1 = said.join("").trim();
    console.log(`   답: ${JSON.stringify(seen1.slice(0, 160))}`);
    const freshSame = seen1.includes("리뷰어");
    console.log(`   → 같은 세션이 새 목록을 ${freshSame ? "**본다**" : "**못 본다**"}`);

    /*
     * ★ **세션을 새로 열면 보이나.**
     *
     * 이게 갈라줘야 하는 두 가지다:
     *   (a) 알림 자체가 안 먹혔다            → 새 세션도 못 본다
     *   (b) 세션이 도구 목록을 **굳혀 들고 있다** → 새 세션은 본다
     * (b)면 «봇 초대 시 재연결»이 실제로 길이 된다는 뜻이다.
     */
    console.log("\n5) 세션을 새로 열면 보이나 — «재연결이 길인가»를 가른다");
    said.length = 0;
    const second = await call("session/new", {
      cwd,
      mcpServers: [{
        type: "http", name: "ai-in-one", url,
        headers: [{ name: "x-aio-secret", value: SECRET }],
      }],
    });
    await call("session/prompt", {
      sessionId: second.sessionId,
      prompt: [{ type: "text", text: "ask_bot 도구의 bot 파라미터가 받는 값들을 그대로 나열해줘. 설명 없이 값만." }],
    });
    const seen2 = said.join("").trim();
    console.log(`   답: ${JSON.stringify(seen2.slice(0, 160))}`);
    const freshNew = seen2.includes("리뷰어");
    console.log(`   → 새 세션이 새 목록을 ${freshNew ? "**본다**" : "**못 본다**"}`);

    console.log("\n── 갈림 ──────────────────────");
    if (freshSame) {
      console.log("  ★ **알림만으로 갱신된다** — `list_bots` 불필요, 재연결도 불필요");
    } else if (freshNew) {
      console.log("  🟡 **세션이 도구 목록을 굳혀 들고 있다** — 알림은 전송 계층까지만 간다.");
      console.log("     초대 시 **재연결**이 길이지만 그건 맥락을 버리는 일이다 → `list_bots` 나 자유 문자열이 낫다");
    } else {
      console.log("  ❌ 새 세션도 못 본다 — 알림 경로가 아예 안 먹는다");
    }

    verdict();
    finish(0);
  } catch (e) {
    console.log(`\n오류: ${e.message}`);
    if (/usageLimit|rate|quota/i.test(e.message)) {
      console.log("  ⚠️ **사용량 한도다** — 이 결과는 «안 된다»가 아니라 «못 쟀다»이다");
    }
    console.log(`stderr: ${err.slice(-300)}`);
    verdict();
    finish(1);
  }
});
