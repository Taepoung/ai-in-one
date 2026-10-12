/**
 * **Antigravity 는 지우면 지워지나** (2026-10-12).
 *
 * `delsess.cjs`·`delsess2.cjs` 는 **Claude 에 박혀 있다**(`~/.claude/projects`·
 * `claude.exe`). 그래서 «방을 나가면 CLI 에 아무것도 안 남아야 한다»(§0 P4)가
 * Antigravity 에서도 참인지는 **한 번도 안 봤다.**
 *
 * 안 보고 있는 사이에 쌓인다. Codex 가 그랬다 — ACP `session/delete` 가 파일만
 * 지우고 **sqlite 인덱스를 안 건드려서** 유령 행이 12개 쌓였고, 사용자가
 * «codex에도 세션이 쌓인거 같은데» 로 알려줬다. 그래서 `codex delete --force`
 * 를 따로 부른다(`AgentDef.purgeSession`). **Antigravity 에는 그 폴백이 없다** —
 * 어떤 길인지 안 재봤기 때문이고, 지어내면 엉뚱한 걸 부른다.
 *
 * Antigravity 는 세션을 **두 군데**에 둔다:
 *
 * ```
 * ~/.gemini/antigravity-acp/brain/<id>/              폴더
 * ~/.gemini/antigravity-acp/conversations/<id>.db    sqlite
 *                                        <id>.meta
 * ```
 *
 * 넷을 본다:
 *
 * ```
 * ① sessionCapabilities 에 delete·close 가 있나   없으면 우리는 close 로 떨어진다
 * ② delete 뒤에 **무엇이 남나**                    Claude 는 제목과 마지막 말이 남았다
 * ③ session/list 에서 빠지나                      Codex 는 안 빠져서 유령이 됐다
 * ④ close 만 했을 때는                            우리 코드의 또 한 갈래다
 * ```
 *
 *   node tests/probes/agydelete.cjs
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const EXE = path.join(
  process.env.APPDATA || "", "Code", "User", "globalStorage",
  "taein-yoon.ai-in-one", "agents", "antigravity", "agy_acp_server.exe",
);
if (!fs.existsSync(EXE)) { console.log("설치된 Antigravity 가 없다"); process.exit(1); }

const HOME = path.join(os.homedir(), ".gemini", "antigravity-acp");
const BRAIN = path.join(HOME, "brain");
const CONV = path.join(HOME, "conversations");

/** 지금 저 두 자리에 무엇이 있나 */
function snap() {
  const ls = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  return { brain: new Set(ls(BRAIN)), conv: new Set(ls(CONV)) };
}
const added = (before, after) => [...after].filter((x) => !before.has(x));
const gone = (before, after) => [...before].filter((x) => !after.has(x));

/** 그 세션이 남긴 것들의 크기 — «줄었나» 를 보려면 숫자가 필요하다 */
function sizesOf(id) {
  const out = {};
  for (const f of [`${id}.db`, `${id}.meta`]) {
    try { out[f] = fs.statSync(path.join(CONV, f)).size; } catch { /* 없다 */ }
  }
  try {
    const dir = path.join(BRAIN, id);
    out[`brain/${id}/`] = fs.readdirSync(dir).length + "개";
  } catch { /* 없다 */ }
  return out;
}

const SECRET = "라벤더 스물셋";

function agent() {
  const proc = spawn(EXE, [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          said.push(u.content.text);
        }
      } else if (m.method === "session/request_permission") {
        const o = (m.params?.options ?? []).find((x) => x.kind === "allow_once")
          ?? m.params?.options?.[0];
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
    try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { /* 이미 죽었다 */ }
  };
  return { call, said, bye, err: () => err };
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-agydel-"));
const CAPS = { fs: { readTextFile: false, writeTextFile: false } };

/** 세션 하나를 만들고 **말까지 건다** — 내용이 있어야 지울 것이 있다 */
async function born(a, what) {
  const s = await a.call("session/new", { cwd, mcpServers: [] });
  await a.call("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: `${what} — 내 비밀 암호는 «${SECRET}» 이야. 한 줄로만 답해.` }],
  });
  return s.sessionId;
}

/** 남은 파일 속에 비밀이 들어 있나 — 있으면 **지운 게 아니다** */
function leaks(id) {
  const hits = [];
  const look = (p) => {
    let raw;
    try { raw = fs.readFileSync(p); } catch { return; }
    if (raw.includes(SECRET)) hits.push(path.relative(HOME, p));
  };
  for (const f of [`${id}.db`, `${id}.meta`]) look(path.join(CONV, f));
  const walk = (dir) => {
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) walk(p); else look(p);
    }
  };
  walk(path.join(BRAIN, id));
  return hits;
}

(async () => {
  const out = [];
  console.log(`집: ${HOME}`);
  console.log(`시작 전 — brain ${snap().brain.size}개 · conversations ${snap().conv.size}개\n`);

  const a = agent();
  const init = await a.call("initialize", { protocolVersion: 1, clientCapabilities: CAPS });

  // ── ① 무엇을 할 줄 아나
  const caps = init?.agentCapabilities?.sessionCapabilities ?? {};
  console.log("① sessionCapabilities:", JSON.stringify(caps));
  console.log("   loadSession:", init?.agentCapabilities?.loadSession);
  out.push(["① delete 를 광고하나", caps.delete ? "예" : "**아니다** → 우리는 close 로 떨어진다"]);
  out.push(["   close 를 광고하나", caps.close ? "예" : "아니다"]);
  out.push(["   list 를 광고하나", caps.list ? "예" : "아니다"]);

  // ── ② delete 뒤에 무엇이 남나
  console.log("\n② delete — 세션을 만들고 말을 건 뒤 지운다");
  const before = snap();
  const id = await born(a, "지울 세션");
  const afterBorn = snap();
  console.log(`   생겼다: brain ${JSON.stringify(added(before.brain, afterBorn.brain))}`);
  console.log(`           conv  ${JSON.stringify(added(before.conv, afterBorn.conv))}`);
  const sizesBefore = sizesOf(id);
  console.log(`   크기  : ${JSON.stringify(sizesBefore)}`);
  const leakedBefore = leaks(id);
  console.log(`   비밀이 든 파일: ${JSON.stringify(leakedBefore)}`);

  let delErr = null;
  try {
    await a.call("session/delete", { sessionId: id });
  } catch (e) {
    delErr = e.message.slice(0, 160);
    console.log(`   🔴 delete 실패: ${delErr}`);
  }
  // 디스크에 반영될 틈을 준다
  await new Promise((r) => setTimeout(r, 1500));
  const afterDel = snap();
  console.log(`   지워진 것: brain ${JSON.stringify(gone(afterBorn.brain, afterDel.brain))}`);
  console.log(`              conv  ${JSON.stringify(gone(afterBorn.conv, afterDel.conv))}`);
  console.log(`   남은 크기: ${JSON.stringify(sizesOf(id))}`);
  const leakedAfter = leaks(id);
  console.log(`   비밀이 아직 든 파일: ${JSON.stringify(leakedAfter)}`);

  out.push(["② delete 가 되나", delErr ? `**실패** — ${delErr}` : "응답은 왔다"]);
  out.push(["   brain 폴더가 사라지나", afterDel.brain.has(id) ? "**남는다**" : "사라진다"]);
  out.push(["   conversations 가 사라지나",
            afterDel.conv.has(`${id}.db`) ? "**남는다**" : "사라진다"]);
  out.push(["   비밀이 남나", leakedAfter.length > 0 ? `**남는다** (${leakedAfter.join(", ")})` : "안 남는다"]);

  // ── ③ 목록에서 빠지나
  if (caps.list) {
    try {
      const list = await a.call("session/list", { cwd });
      const still = (list?.sessions ?? []).some((x) => x.sessionId === id);
      console.log(`\n③ session/list — ${(list?.sessions ?? []).length}개 중 그 세션이 ${still ? "**아직 있다**" : "없다"}`);
      out.push(["③ 목록에서 빠지나", still ? "**안 빠진다** — 유령이 된다" : "빠진다"]);
    } catch (e) {
      console.log(`\n③ session/list 실패: ${e.message.slice(0, 120)}`);
      out.push(["③ 목록에서 빠지나", `못 물어봤다 — ${e.message.slice(0, 60)}`]);
    }
  } else {
    out.push(["③ 목록에서 빠지나", "list 를 안 광고한다"]);
  }

  // ── ④ close 만 했을 때 — 우리 코드의 또 한 갈래
  console.log("\n④ close — 지우지 않고 떼기만 한다");
  const b4 = snap();
  const id2 = await born(a, "닫을 세션");
  const afterBorn2 = snap();
  try {
    await a.call("session/close", { sessionId: id2 });
  } catch (e) {
    console.log(`   close 실패: ${e.message.slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
  const afterClose = snap();
  console.log(`   생겼다: ${JSON.stringify(added(b4.brain, afterBorn2.brain))}`);
  console.log(`   지워진 것: ${JSON.stringify(gone(afterBorn2.brain, afterClose.brain))}`);
  out.push(["④ close 뒤에 남나", afterClose.brain.has(id2) ? "**남는다** (당연 — 떼기일 뿐)" : "사라진다"]);

  console.log(`\n끝난 뒤 — brain ${snap().brain.size}개 · conversations ${snap().conv.size}개`);
  a.bye();

  console.log("\n── 결과 ──────────────────────────────");
  for (const [k, v] of out) console.log("  " + k.padEnd(26) + " " + v);
  console.log(`\n⚠️ 이 프로브가 세션 **둘**을 만든다. 안 지워지면 손으로 치워야 한다:`);
  console.log(`   ${path.join(BRAIN, "<id>")} · ${path.join(CONV, "<id>.db|.meta")}`);
  console.log(`   이번 것: ${id} · ${id2}`);
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.log("🔴 " + e.message); process.exit(1); });
