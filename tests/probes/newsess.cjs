/**
 * **메시지마다 세션이 새로 생기나 — 진짜 CLI 쪽** (2026-09-28).
 *
 * `reusesess.mts` 는 **우리 코드**가 `bt.sessionId` 를 재사용하는지만 본다.
 * 그런데 우리가 같은 `sessionId` 로 세 번 불러도, **어댑터가 속으로 매번 새
 * 세션을 파면** 결과는 같다 — 맥락이 끊기고 디스크에 쌓인다.
 *
 * 불안한 이유가 있다. 같은 계열에서 이미 두 번 그랬다(2026-09-23 실측):
 *
 *   claude --print        메시지마다 **새 세션**
 *   Agent SDK             메시지마다 **새 세션**
 *   ACP                   ← 여기가 안 재본 칸
 *
 * 그래서 두 가지를 같이 본다:
 *   ① `~/.claude/projects/<슬러그>/` 의 `.jsonl` **개수**가 안 느는가
 *   ② 세 번째 프롬프트가 **첫 번째 말을 기억**하는가
 *
 * ②가 진짜 판정이다. 파일이 하나여도 내용이 매번 갈아엎히면 재사용이 아니다.
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-new-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

/** 첫 턴에만 알려주는 말 — 일반 단어로 재면 못 알아본다 */
const SECRET = "청록색 마흔둘";

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
      if (m.error) bad(m.error); else ok(m.result);
    } else if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        said.push(u.content.text);
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
const call = (method, params) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 180000);
});
const nap = (t) => new Promise((r) => setTimeout(r, t));
const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);

/** 이 cwd 앞으로 적힌 세션 파일들 — 슬러그 규칙을 짐작하지 않고 훑는다 */
function filesFor(cwdPath) {
  const out = [];
  if (!fs.existsSync(PROJECTS)) return out;
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    let names;
    try { names = fs.readdirSync(full); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      // 폴더 이름이 cwd 의 꼬리를 담고 있으면 우리 것이다
      if (dir.includes(path.basename(cwdPath))) out.push(path.join(full, n));
    }
  }
  return out;
}

const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  process.exit(code);
};

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}`);
  console.log(`폴더 : ${cwd}\n`);

  const turns = [
    `내 암호는 «${SECRET}» 이야. 도구 쓰지 말고 "외웠어"라고만 답해.`,
    `2 더하기 2는? 숫자만.`,
    `아까 알려준 내 암호가 뭐였지? 그대로만 답해.`,
  ];

  const counts = [];
  for (let i = 0; i < turns.length; i++) {
    const before = said.length;
    await call("session/prompt", { sessionId, prompt: [{ type: "text", text: turns[i] }] });
    await nap(1200);
    const files = filesFor(cwd);
    counts.push(files.length);
    const reply = said.slice(before).join("").replace(/\s+/g, " ").trim();
    console.log(`[${i + 1}턴] 파일 ${files.length}개 · 답 «${reply.slice(0, 60)}»`);
    if (i === turns.length - 1) {
      var lastReply = reply;
    }
  }

  console.log("");
  const files = filesFor(cwd);
  console.log(`세션 파일: ${files.map((f) => path.basename(f)).join(", ")}`);

  mark(counts.every((c) => c === counts[0]),
    counts.every((c) => c === counts[0])
      ? `★ **턴마다 안 는다** (${counts.join(" → ")}) — 파일은 하나로 유지된다`
      : `🔴 **턴마다 파일이 는다** (${counts.join(" → ")}) — 메시지마다 새 세션이다`);

  mark(files.length === 1 && path.basename(files[0]) === `${sessionId}.jsonl`,
    `★ 그리고 그게 **우리가 연 그 세션**이다`);

  // ★ 진짜 판정 — 파일 개수보다 이쪽이 세다
  mark(lastReply.includes("청록") || lastReply.includes(SECRET),
    lastReply.includes("청록") || lastReply.includes(SECRET)
      ? "★ **세 번째 턴이 첫 턴을 기억한다** — 세션이 진짜로 이어진다"
      : `🔴 **첫 턴을 잊었다** («${lastReply.slice(0, 60)}») — 파일이 하나여도 맥락은 끊겼다`);

  if (err.trim()) console.log("\n  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
