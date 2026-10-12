/**
 * **Antigravity 가 할 줄 아는 메서드를 두드려 본다** (2026-10-12).
 *
 * `agydelete.cjs` 에서 `session/delete` 가 **Method not found** 였다. 그런데
 * «광고 안 함» 과 «구현 안 함» 은 다르고, 이름이 다를 수도 있다 —
 * 그래서 **그럴듯한 이름들을 직접 두드린다.**
 *
 * 🔴 **프롬프트를 안 보낸다.** 세션 하나만 열고 메서드 이름만 물어보므로
 * **할당량이 안 든다.** 세션 하나는 남지만(지울 길이 없으므로) 그게 바로
 * 이 프로브가 묻는 것이다.
 *
 *   node tests/probes/agymethods.cjs
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const EXE = path.join(
  process.env.APPDATA || "", "Code", "User", "globalStorage",
  "taein-yoon.ai-in-one", "agents", "antigravity", "agy_acp_server.exe",
);
if (!fs.existsSync(EXE)) { console.log("설치된 Antigravity 가 없다"); process.exit(1); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-agym-"));
const proc = spawn(EXE, [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
let seq = 0, buf = "";
const waiting = new Map();
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
      const { done } = waiting.get(m.id); waiting.delete(m.id);
      done(m);
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
proc.stderr.resume();
const call = (method, params) => new Promise((done) => {
  const id = ++seq; waiting.set(id, { done });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), done({ error: { message: "timeout" } })), 20000);
});

/**
 * 「Method not found」와 「그 메서드는 있는데 인자가 틀렸다」는 다르다.
 *
 * 🔴 **-32601 만 «없다» 다.** 나머지 오류는 **있다는 뜻**이다 — 세션 id 가
 * 틀렸다거나 상태가 안 맞는다거나. 그걸 «없다» 로 읽으면 **있는 길을 놓친다.**
 */
function read(m) {
  if (!m.error) return "✅ 됐다";
  const code = m.error.code;
  const text = String(m.error.message ?? "").slice(0, 90);
  if (code === -32601) return "— 없다";
  return `❓ **있다** (${code}) ${text}`;
}

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const s = await call("session/new", { cwd, mcpServers: [] });
  const id = s.result?.sessionId;
  console.log(`세션: ${id}\n`);

  /*
   * 지우기·닫기로 그럴듯한 이름들. ACP 스펙에 있는 것(`session/delete` ·
   * `session/close`)과, 저쪽 제품 말투로 있을 법한 것들을 같이 둔다.
   */
  const tries = [
    ["session/delete", { sessionId: id }],
    ["session/close", { sessionId: id }],
    ["session/remove", { sessionId: id }],
    ["session/discard", { sessionId: id }],
    ["session/end", { sessionId: id }],
    ["session/archive", { sessionId: id }],
    ["conversation/delete", { conversationId: id }],
    ["conversation/remove", { conversationId: id }],
    ["session/list", { cwd }],
    ["session/resume", { sessionId: id, cwd }],
  ];

  const out = [];
  for (const [method, params] of tries) {
    const got = await read(await call(method, params));
    console.log(`  ${method.padEnd(24)} ${got}`);
    out.push([method, got]);
  }

  console.log("\n── 결론 ──────────────────────────────");
  const alive = out.filter(([, v]) => !v.startsWith("—"));
  console.log(`  두드린 ${out.length}개 중 **있는 것** ${alive.length}개:`);
  for (const [k, v] of alive) console.log(`    ${k.padEnd(24)} ${v}`);
  const canDelete = alive.some(([k]) => /delete|remove|discard|archive/.test(k));
  console.log(`\n  지울 길이 있나: ${canDelete ? "**있다**" : "**없다**"}`);
  console.log(`\n⚠️ 세션 ${id} 가 남는다 — 지울 길이 없으면 손으로 치운다:`);
  console.log(`   ~/.gemini/antigravity-acp/brain/${id} · conversations/${id}.*`);

  try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 죽었다 */ }
  setTimeout(() => process.exit(0), 300);
})();
