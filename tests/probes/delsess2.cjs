/**
 * **지운 뒤에 진짜 남는 게 뭔가** — 파일 속을 열고, TUI 로도 되짚어 본다.
 *
 * 앞 프로브(`delsess.cjs`)에서 `session/delete` 가 **파일을 안 지운다**는 것까지
 * 봤다. 그런데 파일이 165KB → 1055B 로 **줄었다.** 그러니 «안 지운다»는 말은
 * 거칠다 — 대화는 비우고 **껍데기를 남긴** 것이다. 남은 껍데기에는
 *
 *   last-prompt   사용자가 마지막으로 친 말 **원문**
 *   ai-title      «하늘의 색» 같은 자동 제목
 *
 * 이 둘이 들어 있다. 이건 정확히 **`/resume` 목록에 뜨는 그 글자들**이다.
 *
 * 그래서 마지막 질문 하나가 남는다:
 *
 *   지운 세션을 **`claude --resume <id>` 로 되살릴 수 있는가.**
 *
 *   된다   → 우리 앱에서 지운 방이 **claude 에서 그대로 열린다.** 고쳐야 한다
 *   안 된다 → 목록에 이름만 남고 내용은 못 되살린다. 그래도 «이름»은 샌다
 */
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const CLAUDE = path.join(os.homedir(), ".local", "bin", "claude.exe");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-del2-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@" + (process.env.AIO_ACP_VERSION || "0.81.2")], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

/** 되살아나면 **이 말이 되돌아온다** — 일반 단어로 재면 못 알아본다 */
const SECRET = "라벤더 스물셋";

let seq = 0, buf = "", err = "";
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
      if (m.error) bad(m.error); else ok(m.result);
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

function findFile(id) {
  if (!fs.existsSync(PROJECTS)) return null;
  for (const dir of fs.readdirSync(PROJECTS)) {
    const p = path.join(PROJECTS, dir, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const types = (p) => fs.readFileSync(p, "utf8").trim().split("\n")
  .filter(Boolean).map((l) => { try { return JSON.parse(l).type; } catch { return "?"; } });

const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
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

  await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      `내 비밀 암호는 «${SECRET}» 이야. 외워둬. 도구는 쓰지 말고 "외웠어"라고만 답해.` }],
  });
  await nap(1500);

  const p = findFile(sessionId);
  if (!p) { console.log("[무효] 파일이 안 생겼다"); bye(0); }
  console.log(`[전] ${fs.statSync(p).size}B · 줄 ${types(p).length}개`);
  console.log(`     ${types(p).join(", ").slice(0, 160)}`);

  // ── ★ 지운다 ──────────────────────────────────────────────────────
  try { await call("session/delete", { sessionId }); } catch (e) {
    console.log("delete 거부:", JSON.stringify(e).slice(0, 150));
  }
  await nap(1500);

  const q = findFile(sessionId);
  console.log(`\n[후] ${q ? `${fs.statSync(q).size}B · 줄 ${types(q).length}개` : "(파일 없음)"}`);
  if (q) {
    console.log(`     ${types(q).join(", ")}`);
    const raw = fs.readFileSync(q, "utf8");
    mark(!raw.includes(SECRET),
      raw.includes(SECRET)
        ? "🔴 **대화 내용이 파일에 그대로 남아 있다**"
        : "대화 내용은 비워졌다 — 남은 건 껍데기다");
    // 껍데기에 뭐가 적혀 있나 — 목록에 뜨는 글자들이다
    for (const line of raw.trim().split("\n")) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "last-prompt") console.log(`     🔴 last-prompt : «${String(o.lastPrompt).slice(0, 60)}»`);
      if (o.type === "ai-title") console.log(`     🔴 ai-title    : «${o.aiTitle}»`);
    }
  }

  // ── ★ 목록에 잡히나 ───────────────────────────────────────────────
  try {
    const r = await call("session/list", { cwd });
    const rows = r?.sessions ?? [];
    const mine = rows.find((s) => (s.sessionId ?? s.id) === sessionId);
    console.log(`\n[session/list] ${rows.length}개 · 우리 것: ${mine ? JSON.stringify(mine).slice(0, 200) : "(없음)"}`);
    mark(mine === undefined, "지운 세션이 목록에서 빠진다");
  } catch (e) {
    console.log("list 안 됨:", JSON.stringify(e).slice(0, 100));
  }

  // ── ★★ TUI 로 되살아나나 — 이게 사용자가 실제로 보는 것 ──────────
  console.log("\n[★ claude --resume 으로 되살아나나]");
  if (!fs.existsSync(CLAUDE)) {
    console.log("  (claude.exe 를 못 찾음 — 건너뜀)");
  } else {
    const r = spawnSync(CLAUDE, ["--resume", sessionId, "-p", "내 비밀 암호가 뭐였지? 한 줄로만."],
      { cwd, encoding: "utf8", timeout: 180000 });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    console.log(`  종료코드 ${r.status}`);
    console.log(`  답변: ${out.replace(/\\s+/g, " ").slice(0, 300) || "(없음)"}`);
    const revived = out.includes(SECRET) || out.includes("라벤더");
    console.log("");
    mark(!revived,
      revived
        ? "🔴 **되살아난다** — 우리 앱에서 지운 대화를 claude 가 그대로 기억한다"
        : "★ **못 되살린다** — 대화는 진짜로 사라졌다");
  }

  if (err.trim()) console.log("\n  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
