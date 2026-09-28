/**
 * **에이전트가 구조화된 질문(elicitation, D4)을 실제로 쓰나** — 없애기 전에.
 *
 * 우리는 `clientCapabilities` 에 `elicitation: {form, url}` 을 **광고하고 있다.**
 * 주석이 *"광고하지 않으면 에이전트가 질문을 시도조차 하지 않는다"* 라고 적혀
 * 있으니, 안 광고하면 그 채널은 그냥 사라진다 — **한 줄짜리 결정**이다.
 *
 * 그런데 없애도 되는지는 두 가지에 달렸다:
 *
 *   1. **쓰기는 쓰나?** 안 쓰면 D4 전체가 죽은 코드다
 *   2. **안 광고하면 글로 묻나?** 아니면 **혼자 정해버리나**
 *
 * 2번이 중요하다. 지금 `answerPolicy: "auto"` 가 `cancel` 로 답하는데 그건
 * «에이전트가 혼자 판단»이다. 광고를 빼도 그 꼴이면 **없애는 게 손해**다 —
 * 물어보던 것이 조용한 추측으로 바뀐다.
 *
 *   node elicit.cjs claude        (광고함)
 *   node elicit.cjs claude off    (광고 안 함)
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const WHICH = (process.argv[2] || "claude").toLowerCase();
const ADVERTISE = process.argv[3] !== "off";
const AGENT = {
  claude: ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"],
  codex: ["-y", "@agentclientprotocol/codex-acp"],
}[WHICH];
if (!AGENT) { console.log("claude 또는 codex"); process.exit(1); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-elicit-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, AGENT, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });

let seq = 0, buf = "", err = "";
const waiting = new Map();
const said = [];
let elicited = 0, permissioned = 0;

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
      continue;
    }
    if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said.push(u.content.text);
      continue;
    }
    // ★ 구조화된 질문이 왔나
    if (typeof m.method === "string" && /elicit/i.test(m.method)) {
      elicited++;
      console.log(`  ★ **구조화된 질문이 왔다**: ${m.method}`);
      console.log(`     ${JSON.stringify(m.params).slice(0, 400)}`);
      // 거절해서 «그다음에 뭘 하나»를 본다
      send({ jsonrpc: "2.0", id: m.id, result: { action: "decline" } });
      continue;
    }
    if (m.method === "session/request_permission") {
      permissioned++;
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? "")) ?? m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
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
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout " + method))), 240000);
});

(async () => {
  try {
    const caps = {
      fs: { readTextFile: true, writeTextFile: true },
      session: { compaction: {} },
      ...(ADVERTISE ? { elicitation: { form: {}, url: {} } } : {}),
    };
    console.log(`[${WHICH}] elicitation 광고: ${ADVERTISE ? "**함**" : "**안 함**"}`);
    await call("initialize", { protocolVersion: 1, clientCapabilities: caps });

    const { sessionId } = await call("session/new", { cwd, mcpServers: [] });

    // **묻게 만드는** 프롬프트. 고르라고 시키되 우리가 답을 안 준다.
    said.length = 0;
    await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text:
        "이 폴더에 메모 파일을 하나 만들 건데 이름을 정해야 해. " +
        "`note-a.md` 와 `note-b.md` 둘 중 어느 쪽으로 할지 **네가 정하지 말고 나한테 물어봐.** " +
        "내 답을 받기 전에는 파일을 만들지 마." }],
    });

    const text = said.join("").trim();
    console.log(`\n  답: ${JSON.stringify(text.slice(0, 260))}`);
    console.log("\n── 결과 ──────────────────────");
    console.log(`  구조화된 질문(elicitation) : ${elicited}회`);
    console.log(`  권한 요청                  : ${permissioned}회`);
    const askedInProse = /\?|물어|어느|골라|선택|알려주|말씀/.test(text);
    console.log(`  글로 물어봤나              : ${askedInProse ? "**그렇다**" : "아니다"}`);
    if (elicited > 0) console.log("  → D4 는 살아 있는 코드다");
    else if (askedInProse) console.log("  → **구조화 없이도 글로 묻는다**");
    else console.log("  → 🔴 묻지도 않았다 — 혼자 정했을 수 있다");
  } catch (e) {
    console.log(`오류: ${e.message}`);
    console.log(`stderr: ${err.slice(-300)}`);
  }
  try { proc.kill(); } catch {}
  process.exit(0);
})();
