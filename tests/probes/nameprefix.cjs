/**
 * **접두어를 첫 프롬프트로 밀어 넣으면 목록에 뜨나** (2026-10-01).
 *
 * 사용자가 바란 것: *"우리에서 나온 세션은 prefix를 넣어서 구분하고 싶었는데"* —
 * `<<AI-in-one>> [방이름] [봇이름]` 같은 꼴.
 *
 * 앞서 잰 것(`sessionname.cjs`): 제목을 **보낼 길이 없다.** 프로토콜에도 없고
 * `_meta` 도 무시된다. CLI 에도 `rename` 이 없고 만들 때 붙이는 플래그도 없다.
 *
 * 그런데 하나가 남았다 — **Codex 목록 제목은 첫 프롬프트 그대로다.** 그러면
 * 설정은 못 해도 **결과는 만들 수 있다.** 되는지, 그리고 값이 치러지는지 잰다:
 *
 * ```
 * ① 접두어가 목록 제목에 **그대로** 들어가나 (잘리나? 다듬어지나?)
 * ② **둘째 턴에 덮어쓰이나** — 나중에 요약 제목으로 바뀌면 헛일이다
 * ③ 그 대가: 모델이 **그 글을 읽는다.** 답이 달라지나
 * ```
 *
 * ③이 이 방법의 진짜 비용이다. 목록을 예쁘게 하자고 **사용자가 보내는 말에
 * 우리 글을 섬는** 것이라, 모델이 거기 반응하면 못 쓴다.
 *
 * ───── ❌ **다 됐는데도 안 넣기로 했다** (2026-10-01) ─────
 *
 * 넷이 다 통과했다. 접두어는 그대로 들어가고, 둘째 턴에도 안 바뀌고, 모델은
 * 그 글을 입에 올리지도 않았다. 그런데도 안 넣는다.
 *
 * 비용이 ③가 재는 «모델이 반응하나» 보다 **한 칸 앞**에 있었기 때문이다.
 * 접두어를 붙이려면 **보낸 것과 말풍선에 보이는 것이 달라진다** — 그대로
 * 보이면 내 말풍선에 우리 글이 붙고, 감추면 §0 P5 의 거울상이 된다.
 *
 * 사용자 판단: *"입력으로 섬어야되는거면 하지 말자"*.
 *
 * ⚠️ **다시 재지 마라.** 재기는 끝났고 답은 «된다» 였다 — 거절된 것은
 * 되느냐가 아니라 **값이다.** 길이 다시 열리는 건 ACP 가 제목을 받는
 * 메서드를 낼 때고, 그때는 입력을 안 건드리고도 된다.
 */
const { spawn, execFileSync } = require("node:child_process");
const { argsOf, pkgOf } = require("./pinned.cjs");
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } };
const NAP = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (c, m) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };

const PREFIX = "<<AI-in-one>> [연구실] [코덱스]";
const ASK = "1 더하기 1은?";

function start(args, cwd) {
  const proc = spawn(CMD, args, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(); const notes = []; const said = [];
  let seq = 0, buf = "";
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk; let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && waiting.has(m.id)) {
        const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) bad(new Error(JSON.stringify(m.error).slice(0, 250))); else ok(m.result);
      } else if (m.method === "session/update") {
        const u = m.params && m.params.update; notes.push(u);
        if (u && u.sessionUpdate === "agent_message_chunk" && u.content && u.content.text) said.push(u.content.text);
      } else if (m.id !== undefined) {
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } });
      }
    }
  });
  proc.stderr.resume();
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++seq; waiting.set(id, { ok, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`timeout ${method}`))), 180000);
  });
  return { proc, call, notes, said, titles: () => notes.filter((u) => u && u.sessionUpdate === "session_info_update").map((u) => u.title) };
}

function dbTitle(id) {
  try {
    const db = new DatabaseSync(path.join(os.homedir(), ".codex", "state_5.sqlite"), { readOnly: true });
    const r = db.prepare("select title, name, first_user_message, originator from threads where id = ?").get(id);
    db.close();
    return r || {};
  } catch (e) { return { title: "(못 읽음 " + String(e.message).slice(0, 30) + ")" }; }
}

(async () => {
  const out = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-pfx-"));
  const a = start(argsOf("codex"), cwd);
  let sid = "";
  try {
    await a.call("initialize", INIT);
    sid = (await a.call("session/new", { cwd, mcpServers: [] })).sessionId;

    console.log("\n[① 접두어를 첫 프롬프트 앞에 붙인다]");
    await a.call("session/prompt", {
      sessionId: sid, prompt: [{ type: "text", text: `${PREFIX} ${ASK}` }],
    });
    await NAP(2500);
    const one = dbTitle(sid);
    console.log(`   title     = ${JSON.stringify(one.title)}`);
    console.log(`   name      = ${JSON.stringify(one.name)}`);
    console.log(`   originator= ${JSON.stringify(one.originator)}`);
    out.push(mark(String(one.title || "").includes("AI-in-one"),
      "★ **접두어가 목록 제목에 들어간다** — 설정은 못 해도 결과는 만들 수 있다"));

    console.log("\n[③ 대가 — 모델이 그 글을 읽는다]");
    const first = a.said.join("").trim();
    console.log(`   답: ${JSON.stringify(first.slice(0, 160))}`);
    out.push(mark(/2/.test(first),
      "★ 물은 것에 답은 한다 (접두어가 질문을 가리지 않았다)"));
    out.push(mark(!/AI-in-one|연구실|코덱스/i.test(first),
      "★ **접두어를 입에 올리진 않는다** — 올리면 사용자 눈에 우리 글이 샌다"));

    console.log("\n[② 둘째 턴에 덮어쓰이나]");
    a.said.length = 0;
    await a.call("session/prompt", {
      sessionId: sid, prompt: [{ type: "text", text: "고마워. 이제 3 더하기 3은?" }],
    });
    await NAP(2500);
    const two = dbTitle(sid);
    console.log(`   title = ${JSON.stringify(two.title)}`);
    console.log(`   에이전트가 알려준 제목들: ${JSON.stringify(a.titles())}`);
    out.push(mark(two.title === one.title,
      "★ **안 바뀐다** — 첫 프롬프트가 정하고 거기서 굳는다"));
  } catch (e) {
    console.log("   터졌다:", String(e.message).slice(0, 200));
    out.push(false);
  }
  try { if (sid) await a.call("session/delete", { sessionId: sid }); } catch { /* 없으면 말고 */ }
  try { a.proc.kill(); } catch { /* 이미 죽었으면 말고 */ }
  await NAP(1200);
  if (sid) { try { execFileSync("codex", ["delete", "--force", sid], { encoding: "utf8", timeout: 120000, shell: true }); } catch { /* 이미 없으면 말고 */ } }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 잠겼으면 다음에 */ }

  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
})();
