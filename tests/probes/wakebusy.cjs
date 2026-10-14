/**
 * **백그라운드가 «턴이 도는 중»에 끝나면 어디로 오나** (2026-09-28).
 *
 * 앞서 잰 것은 한쪽뿐이다 — 끝날 때 봇이 **놀고 있던** 경우(`selfwake.cjs`).
 * 그때는 혼자 깨어나서 말했다. 그런데 일하는 중에 끝나면?
 *
 * 우리한테는 이쪽이 더 위험해 보였다. `watchIdle` 은 **턴이 있으면 그 턴의
 * 말풍선에 넣는다** — 그러니 엉뚱한 답변 한가운데에 결과가 섞일 수 있다.
 *
 *   ① 도는 턴 **안에** 섞여 온다   → ★ **이쪽이다** (아래 참조)
 *   ② 턴이 **끝난 뒤**로 밀린다    → 어댑터가 줄을 세운다
 *   ③ 아예 안 온다                → 놓친다. 그게 제일 나쁘다
 *
 * ★ **답은 ①인데, 걱정은 빗나갔다.** «오염»이 아니라 **합류**다 — 에이전트가
 * 알림을 받고 **제 답변에 녹여서** 말한다:
 *
 *   «두 명령을 차례로 실행했고 … 아까 백그라운드로 띄운 그것도 그 사이
 *    정상 종료됐어요(exit code 0).»
 *
 * 그러니 우리 쪽은 그대로 두면 된다. 그 말풍선은 **어차피 그 턴의 답**이고,
 * «무엇이 끝나서» 표시가 안 붙는 것도 맞다 — 붙일 자리가 아니다.
 *
 * ★ **핀을 올리며 다시 쟀다** (2026-10-15, `0.84.0` ↔ `0.90.0`). **같다 — 둘 다 ①**,
 * 그것도 **출력 내용까지** 들어온다(«bg.txt 내용은 해바라기54092였어»). 오는 길은
 * 도구결과 + 산문이다 — 알림을 받고 **제 손으로 로그를 읽어** 말한다. `bgnotify.cjs`
 * 가 본 것과 같다: 건너오는 것은 알림이 아니라 에이전트의 **반응**이다.
 *
 * 🔴 **여기까지 오는 데 자를 두 번 고쳤다. 둘 다 «재는 쪽»이 틀린 것이었다.**
 *
 * ```
 * ① 낱말을 프롬프트에 적었다   echo 해바라기열둘 → 모델이 **제가 친 명령을 되뇌면**
 *                            그만이다. 0.84.0 의 ✅ 도 그거였고, 0.90.0 이 같은 말을
 *                            안 옮겼다는 이유로 🔴 가 됐다 — **판 차이가 아니었다**
 * ② «열어보지 마» 라고 했다    1턴의 금지가 **2턴까지 남아서** *"열어보지 말라고
 *                            했으니 출력은 확인 안 했어"* 가 됐다. 안 가져온 까닭이
 *                            «안 와서»인지 «하지 말래서»인지 안 갈린다
 * ```
 *
 * 그래서 지금은 **낱말을 파일 안에만 두고**(`cat bg.txt`), **아무것도 금지하지
 * 않고**, 미리 읽어버린 판은 **무효로 친다**. 말의 모양을 맞히려 들면 계속 진다.
 *
 * ── 실험 ────────────────────────────────────────────────────────
 * 1턴: 15초짜리를 백그라운드로 띄우고 곧바로 끝낸다
 * 2턴: **오래 걸리는 일**을 시킨다 (sleep 을 여러 번 — 도구는 진짜로 기다린다)
 *      → 백그라운드는 2턴 **한가운데**에서 끝난다
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-busy-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@" + (process.env.AIO_ACP_VERSION || "0.81.2")], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

/**
 * **백그라운드 결과에만 나오는 말** — 그래서 **프롬프트에 안 적는다.**
 *
 * 🔴 **여기서 두 번 속았다** (2026-10-15).
 *
 * 처음엔 조각마다 `includes` 를 해서 «해바라» + «기열둘» 로 갈린 것을 «안
 * 왔다» 고 찍었다(아래 §결론). 그건 이어 붙여서 고쳤는데, **더 고약한 쪽이
 * 남아 있었다** — 낱말을 `echo 해바라기열둘` 로 **프롬프트에 적어 보냈다.**
 *
 * 그러면 에이전트는 그 낱말을 **제가 친 명령에서 그대로 기억**한다. 답변에
 * 나왔다고 해서 **백그라운드 결과를 받은 증거가 못 된다** — 0.84.0 의 ✅ 도
 * 실은 그 명령을 통째로 되뇐 것이었다(*"`sleep 15 && echo 해바라기열둘` 도
 * 정상 종료됐어"*).
 *
 * 그래서 낱말은 **파일 안에만** 둔다. 띄우는 명령은 `cat` 이라 프롬프트에
 * 낱말이 없고, 모델이 그 낱말을 말하는 길은 **출력을 실제로 받는 것**뿐이다.
 */
const TOKEN = "해바라기" + Math.floor(Math.random() * 1e6);
const BG_FILE = "bg.txt";
fs.writeFileSync(path.join(cwd, BG_FILE), TOKEN + os.EOL, "utf8");
const BG_SLEEP = 15;

let seq = 0, buf = "", err = "";
const waiting = new Map();
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
/** 지금 어느 턴이 도는가 — 0 이면 턴 밖 */
let inTurn = 0;
const line = [];
/** 턴 안에서 온 말 · 턴 밖에서 온 말 */
const said = { 1: [], 2: [], 0: [] };

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
    if (!raw) continue;
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { ok, bad, label } = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) { line.push(`${ms()}  x ${label}`); bad(m.error); }
      else { line.push(`${ms()}  = ${label} (${m.result?.stopReason})`); ok(m.result); }
      continue;
    }
    if (m.method === "session/update") {
      const u = m.params?.update;
      const where = inTurn === 0 ? "*턴밖" : `${inTurn}턴 `;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const t = u.content.text.replace(/\s+/g, " ").trim();
        if (t) { said[inTurn].push(t); line.push(`${ms()} ${where} 말 «${t.slice(0, 54)}»`); }
      } else if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        const title = String(u.title ?? "").replace(/\s+/g, " ");
        const out = JSON.stringify(u.content ?? "");
        if (title || out.includes(TOKEN)) {
          line.push(`${ms()} ${where} 도구 «${title.slice(0, 54)}»${out.includes(TOKEN) ? "  ★결과에 토큰" : ""}`);
        }
        if (out.includes(TOKEN)) said[inTurn].push(`[도구결과]${TOKEN}`);
      }
      continue;
    }
    if (m.method === "session/request_permission") {
      const opt = m.params?.options?.find((o) => /allow/i.test(o.kind ?? o.optionId)) ?? m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
      continue;
    }
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => { err += c; });
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params, label) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad, label: label ?? method });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 300000);
});
const nap = (t) => new Promise((r) => setTimeout(r, t));
const mark = (c, m) => console.log(`  ${c ? "OK" : "NO"} - ${m}`);
const bye = (code) => {
  try { proc.kill(); } catch { /* 이미 죽었을 수 있다 */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
  process.exit(code);
};

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await call("session/new", { cwd, mcpServers: [] });
  console.log(`세션 : ${sessionId}\n`);

  inTurn = 1;
  const r1 = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      `Bash 를 **백그라운드(run_in_background)** 로 써서 "sleep ${BG_SLEEP} && cat ${BG_FILE}" 를 ` +
      /*
       * 🔴 **«열어보지 마» 라고 하면 안 된다** (2026-10-15).
       *
       * 1턴에 파일을 미리 읽으면 낱말을 알아버리니 막고 싶지만, 그 금지는
       * **2턴까지 남는다** — 실제로 이렇게 답했다: *"그 파일은 열어보지
       * 말라고 했으니 출력은 확인하지 않았어."* 그러면 안 가져온 까닭이
       * «안 와서»인지 «하지 말래서»인지 **안 갈린다.**
       *
       * 막는 대신 **무효로 친다** — 1턴에 낱말이 보이면 그 판은 안 쓴다
       * (아래 전제조건).
       */
      "" +
      `띄우자마자 "띄웠어" 라고만 하고 **기다리지 말고 턴을 끝내.**` }],
  }, "1턴");
  const t1 = Date.now() - began;
  console.log(`1턴 종료 ${(t1 / 1000).toFixed(1)}초 · ${r1?.stopReason}`);

  /*
   * ★ **2턴은 백그라운드보다 오래 걸려야 한다.** 말은 빨라도 도구는 진짜로
   * 기다리므로 `sleep` 으로 잡는다 — «천천히 써줘» 는 안 통한다(실측).
   */
  inTurn = 2;
  console.log(`2턴 시작 — 백그라운드는 ${((BG_SLEEP * 1000 - t1) / 1000).toFixed(1)}초 뒤에 끝난다\n`);
  const r2 = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "bash 로 `sleep 12 && echo 하나` 를 돌리고, 끝나면 `sleep 12 && echo 둘` 을 " +
      "**차례로** 돌려줘. 그 다음 둘을 합쳐서 한 문장으로 알려줘. " +
      /*
       * ★ **묻는 것과 안 묻는 것은 다른 물음이다** (2026-10-15).
       *
       *   묻는다    «출력이 **닿을 수** 있나» — 시켰더니 가져오면 ✅
       *   안 묻는다  «출력이 **저절로 오나**» — 원래 재려던 것이 이쪽이다
       *
       * 기본은 묻는 쪽이다(한 낱말로 또렷이 갈린다). `AIO_BG_NOASK=1` 이면
       * 아무 말도 안 하고, 그래도 낱말이 나오면 **저절로 온 것**이다.
       */
      (process.env.AIO_BG_NOASK
        ? ""
        : "그리고 **마지막 줄에**, 아까 백그라운드로 띄운 명령이 **출력한 낱말**을 " +
          "그대로 한 낱말만 적어줘. 아직 못 받았으면 «못받음» 이라고 적어.") }],
  }, "2턴");
  console.log(`2턴 종료 ${((Date.now() - began) / 1000).toFixed(1)}초 · ${r2?.stopReason}`);

  inTurn = 0;
  console.log("\n이제 아무것도 안 보내고 25초 기다린다…\n");
  await nap(25000);

  console.log("-- 흐름 ------------------------------");
  for (const l of line) console.log("  " + l);

  console.log("\n-- 전제조건 ------------------------------");
  const bgAt = BG_SLEEP * 1000;
  console.log(`  백그라운드가 끝날 시각 : ${(bgAt / 1000).toFixed(1)}초`);
  console.log(`  1턴 종료 ${(t1 / 1000).toFixed(1)}초 · 2턴 종료 ${((Date.now() - began - 25000) / 1000).toFixed(1)}초`);
  const overlapped = t1 < bgAt && (Date.now() - began - 25000) > bgAt;
  mark(overlapped, overlapped
    ? "★ **2턴 한가운데에서 끝났다** — 재려던 상황이 맞다"
    : "🔴 [무효] 2턴과 안 겹쳤다 — 길이를 다시 잡아야 한다");
  if (!overlapped) bye(0);

  /*
   * ★ **1턴에 미리 읽었으면 이 판은 못 쓴다.** 띄우기만 시켰는데 친절하게
   * 파일까지 열어보는 수가 있다 — 그러면 2턴의 낱말이 «받은 것»인지
   * «아까 본 것»인지 안 갈린다. 금지하는 대신 여기서 가른다.
   */
  const peeked = said[1].join("").includes(TOKEN);
  mark(!peeked, peeked
    ? "🔴 [무효] 1턴에 벌써 파일을 읽었다 — 낱말을 미리 알아버렸다"
    : "★ 1턴에는 낱말이 안 보인다 — 미리 읽지 않았다");
  if (peeked) bye(0);

  console.log("\n-- 결론 ------------------------------");
  /*
   * 🔴 **조각 하나씩 보다 속았다.** 스트리밍은 글자를 임의로 쪼개서 보내므로
   * 토큰이 «해바라» + «기열둘» 로 갈린다. 조각마다 `includes` 를 하면 **분명히
   * 온 것을 «안 왔다»고 찍는다** — 실제로 그렇게 «③ 아예 안 온다»가 나왔는데,
   * 기록에는 답변이 그 명령을 또렷이 말하고 있었다.
   *
   * **이어 붙이고 나서** 본다.
   */
  /*
   * ★ **어디로 들어왔는지까지 가른다** — 산문에 녹아 온 것과 **제가 도구로
   * 집어 온 것**은 다른 이야기다. 둘 다 «그 턴 말풍선에 결과가 선다» 는
   * 같지만, «알림이 온다» 는 앞쪽만이다.
   */
  const joined = (n) => said[n].join("");
  const toolGot = said[2].some((t) => t.startsWith("[도구결과]"));
  const proseGot = said[2].filter((t) => !t.startsWith("[도구결과]")).join("").includes(TOKEN);
  console.log(`  낱말이 온 길 : ${proseGot ? "산문" : ""}${proseGot && toolGot ? " + " : ""}${toolGot ? "도구결과" : ""}${!proseGot && !toolGot ? "없음" : ""}`);
  const inside = joined(2).includes(TOKEN);
  const outside = joined(0).includes(TOKEN);
  console.log(`  2턴 안에서 토큰(«${TOKEN}») : ${inside}`);
  console.log(`  턴 밖에서 토큰             : ${outside}`);
  console.log(`  2턴 답변 끝부분 : «${joined(2).replace(/\s+/g, " ").slice(-140)}»`);
  console.log(`  턴 밖 말 ${said[0].length}조각: «${joined(0).replace(/\s+/g, " ").slice(0, 120)}»`);
  console.log("");

  /*
   * ★ **판정도 물음을 따라 갈린다** (2026-10-15).
   *
   *   안 묻는다  «저절로 오나» — 2026-10-15 에는 **두 판 다 왔다**(①)
   *   묻는다     «닿을 수는 있나» — 안 와도 시키면 가져오는지
   *
   * 안 물었는데 안 오면 그건 **달라진 것**이라 눈에 걸어둔다. 다만 1턴에
   * 무엇을 **금지하지 않았는지** 먼저 본다 — 금지는 2턴까지 남고, 그러면
   * «안 와서»가 아니라 «하지 말래서» 안 가져온 것이다(위 ②).
   */
  const asked = !process.env.AIO_BG_NOASK;
  if (inside) {
    mark(true, asked
      ? "★ **물으면 가져온다** — 출력이 그 턴 안으로 닿는다"
      : "★ ① **출력까지 저절로 들어온다** — 알림을 받고 **답변에 녹여서** 말한다");
    console.log("     우리 쪽은 그대로 두면 된다 — 그 말풍선은 어차피 그 턴의 답이다.");
    console.log("     다만 «무엇이 끝나서» 표시는 안 붙는다(붙일 자리가 아니다).");
  } else if (outside) {
    mark(true, "★ ② **턴이 끝난 뒤로 밀린다** — 어댑터가 줄을 세운다. 우리는 그대로 두면 된다");
  } else if (asked) {
    mark(false, "🔴 **물어도 못 가져온다** — 백그라운드 결과를 통째로 놓친다");
  } else {
    mark(false, "🔴 ③ **출력이 안 온다** — 2026-10-15 에는 두 판 다 ① 이었다");
    console.log("     먼저 볼 것: 1턴 프롬프트에 **금지한 말이 없나**(«열어보지 마» 는 2턴까지 남는다).");
    console.log("     그래도 안 오면 «끝났다»만 건너온 것이다 — AIO_BG_NOASK 없이 돌려 물어서라도 오는지 본다.");
  }

  if (err.trim()) console.log("\n  stderr:", err.slice(-200));
  bye(0);
})().catch((e) => {
  console.log("오류:", e?.message ?? JSON.stringify(e));
  console.log("stderr:", err.slice(-400));
  bye(1);
});
