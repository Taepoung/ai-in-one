/**
 * **세션 방 이름을 우리가 정할 수 있나** (2026-10-01).
 *
 * 사용자 물음: *"혹시 세션 만들때, 세션 방 이름을 우리가 설정할 수 있어?"*
 *
 * 왜 묻는지가 중요하다. Codex 확장의 목록에 우리가 만든 세션이 *"hi"* 같은
 * 이름으로 줄줄이 떴다. 우리 방 이름이 거기 뜨면 **어느 것이 무엇인지** 알 수
 * 있다.
 *
 * 스펙부터 보면 길이 막혀 있다 — `session/new` 가 받는 것은 넷뿐이다:
 *
 * ```
 * cwd  ·  additionalDirectories  ·  mcpServers  ·  _meta
 * ```
 *
 * `title` 이 없다. 그리고 **제목을 보내는 메서드가 프로토콜 전체에 없다** —
 * `session/*` 열 몇 개를 다 훑어도 client→agent 방향엔 제목이 없다. 반대쪽엔
 * 있다: `session/update` 가 `session_info_update` 를 실어나르고 거기 `title`
 * 이 들어 있다. **에이전트가 우리에게 알려주는 방향**이다.
 *
 * 그래서 글로만 읽고 «안 된다» 하지 않고 셋을 잰다:
 *
 * ```
 * ① `_meta` 에 제목을 끼워 보내면 받아주나   ← 남은 유일한 문
 * ② 에이전트가 `session_info_update` 를 보내나 — 보낸다면 무슨 제목으로
 * ③ Codex 목록의 제목은 결국 어디서 오나 (첫 프롬프트?)
 * ```
 *
 * ②가 «온다» 면 **설정은 못 해도 표시는 맞출 수 있다** — 지금 우리는 그
 * 알림을 통째로 버리고 있다(`acpConnection.ts` 의 switch 에 없다).
 *
 * ───── **재본 결과** (2026-10-01) ─────
 *
 * ```
 * ① _meta 제목        둘 다 조용히 무시한다. 거절도 안 하고 반영도 안 한다
 * ② session_info_update  **둘 다 보낸다** — 우리만 안 받고 있었다
 * ③ Codex 목록 제목   **첫 프롬프트 그대로** — 사용자가 본 «hi» 가 이것이다
 * ```
 *
 * 그래서 답은 **아니다.** 제목을 보낼 길은 프로토콜 어디에도 없고,
 * 열려있는 `_meta` 로도 안 된다. 단 두 가지가 손에 남는다:
 *
 * ```
 * · Codex 목록에 뭐가 뜨는지는 **첫 프롬프트가 정한다** — 그건 우리 손에 있다
 * · 에이전트가 붙인 이름은 **받아서 보여줄 수** 있다 (Claude 는 요약해서 준다)
 * ```
 *
 * ⚠️ 첫 프롬프트를 손대는 것은 **사용자의 말을 고치는 일**이다. 목록을
 * 예쪽게 하자고 보내는 말에 우리 글을 섬는 것은 따로 정할 일이다.
 */
const { spawn, execFileSync } = require("node:child_process");
const { argsOf, pkgOf } = require("./pinned.cjs");
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };
const NAP = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (c, m) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };

/** 우리가 끼워 넣어보는 제목 — 첫 프롬프트와 **다르게** 둬야 구분된다 */
const WANT = "우리가정한방이름-ZZQ";

function start(args, cwd) {
  const proc = spawn(CMD, args, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const notes = [];
  let seq = 0, buf = "", err = "";
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
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 250))); else ok(m.result);
      } else if (m.method === "session/update") {
        notes.push(m.params && m.params.update);
      } else if (m.id !== undefined) {
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } });
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { err += c; });
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 180000);
  });
  return { proc, call, notes, stderr: () => err };
}

/** Codex 가 제 목록에 적어둔 제목 */
function codexTitles(id) {
  const out = {};
  const dig = (file, sql, key) => {
    try {
      const db = new DatabaseSync(path.join(os.homedir(), ".codex", file), { readOnly: true });
      const r = db.prepare(sql).get(id);
      db.close();
      out[key] = r ? JSON.stringify(Object.values(r)[0]) : "(행 없음)";
    } catch (e) { out[key] = "(못 읽음: " + String(e.message).slice(0, 40) + ")"; }
  };
  dig("state_5.sqlite", "select title from threads where id = ?", "threads.title");
  dig(path.join("sqlite", "codex-dev.db"),
      "select display_title from local_thread_catalog where thread_id = ?", "목록.display_title");
  return out;
}

async function one(label, args, after) {
  console.log(`\n[${label}]`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-name-"));
  const a = start(args, cwd);
  const out = [];
  try {
    await a.call("initialize", INIT);

    /*
     * ① **남은 유일한 문은 `_meta` 다.**
     *
     * 스펙이 «구현별 확장» 자리로 열어둔 곳이라, 어댑터가 마음먹으면 여기서
     * 제목을 받을 수 있다. 여러 이름으로 한 번에 찔러본다 — 하나라도 붙으면
     * 길이 있는 것이다. 모르는 키는 그냥 무시되는 자리이므로 **보내도 안전**.
     */
    const made = await a.call("session/new", {
      cwd, mcpServers: [],
      _meta: { title: WANT, name: WANT, sessionTitle: WANT, "session/title": WANT },
    });
    const sid = made.sessionId;
    console.log(`   세션 ${String(sid).slice(0, 18)}…`);
    out.push(mark(!!sid, "★ `_meta` 에 제목을 끼워도 **거절당하진 않는다** — 모르는 키는 무시되는 자리다"));

    await a.call("session/prompt", {
      sessionId: sid,
      prompt: [{ type: "text", text: "«봤다» 라고만 답해. 도구 쓰지 마." }],
    });
    await NAP(1500);

    /* ② 에이전트가 제목을 알려주나 */
    const infos = a.notes.filter((u) => u && u.sessionUpdate === "session_info_update");
    console.log(`   받은 알림 종류: ${[...new Set(a.notes.filter(Boolean).map((u) => u.sessionUpdate))].join(", ")}`);
    if (infos.length) {
      for (const i of infos) console.log(`   session_info_update → title ${JSON.stringify(i.title)}`);
    }
    out.push(mark(infos.length > 0,
      "★ **에이전트가 `session_info_update` 로 제목을 알려준다** — 오면 설정은 못 해도 표시는 맞출 수 있다"));

    const told = infos.length ? infos[infos.length - 1].title : undefined;
    out.push(mark(told === WANT,
      `★ 그 제목이 **우리가 보낸 것**이다 (${JSON.stringify(told)} vs ${JSON.stringify(WANT)})`));

    await after(sid, out);

    /* 뒷정리 — 재느라 만든 세션을 남기지 않는다 */
    try { await a.call("session/delete", { sessionId: sid }); } catch { /* 없으면 말고 */ }
    a.proc.kill();
    await NAP(1200);
    if (label.includes("Codex")) {
      try { execFileSync("codex", ["delete", "--force", sid], { encoding: "utf8", timeout: 120000, shell: true }); }
      catch { /* 이미 없으면 말고 */ }
    }
  } catch (e) {
    console.log("   터졌다:", String(e.message).slice(0, 200));
    console.log("   stderr:", a.stderr().slice(-400));
    out.push(false);
    try { a.proc.kill(); } catch { /* 이미 죽었으면 말고 */ }
  }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 잠겼으면 다음에 */ }
  return out;
}

(async () => {
  const out = [];

  out.push(...await one("① Codex", argsOf("codex"), async (sid, o) => {
    /*
     * ③ **목록의 제목은 결국 어디서 오나.**
     *
     * 사용자가 본 *"hi"* 가 답을 미리 말해준다 — 첫 프롬프트로 보인다. 그게
     * 맞다면 우리가 할 수 있는 것은 하나뿐이다: **첫 프롬프트를 우리가 고른다.**
     */
    await NAP(2500);
    const t = codexTitles(sid);
    for (const [k, v] of Object.entries(t)) console.log(`   ${k} = ${v}`);
    o.push(mark(!String(t["threads.title"]).includes(WANT),
      "★ 목록 제목은 **우리가 보낸 것이 아니다** — `_meta` 로는 못 정한다"));
  }));

  out.push(...await one("② Claude", ["-y", "@agentclientprotocol/claude-agent-acp@0.84.0"],
    async () => { /* Claude 엔 목록이 없다 — 파일이 곧 목록이다 */ }));

  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
})();
