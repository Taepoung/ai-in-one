/**
 * **판이 안 맞으면 무슨 일이 벌어지나** (2026-10-01).
 *
 * 사용자 물음: *"우리가 배포하면 그 핀에 해당하는 cli들이 깔려 아니면 그
 * 버전에 해당하는 애들을 깔아놔야해? 버전이 안맞으면 어떻게 됨?"*.
 *
 * 앞의 절반은 글로 답할 수 있다 — `npx` 가 받으므로 **아무것도 미리 안 깔아도
 * 된다.** 뒤의 절반은 재야 한다. «안 맞는다» 가 한 가지가 아니라서다:
 *
 * ```
 * ㉠ 사용자 CLI 가 우리 엔진보다 낡다   ← 지금 이 기계가 그렇다 (0.155 vs 0.159)
 * ㉡ 사용자 CLI 가 우리 엔진보다 새롭다  ← 사용자가 `codex update` 하면
 * ㉢ 사용자 CLI 가 아예 없다            ← npx 로만 쓰는 사람
 * ```
 *
 * ㉠㉢ 은 이미 안다. 우리는 **제 엔진을 품고 다니므로**(§F5) 뒷정리까지
 * 우리 것으로 한다 — 사용자 CLI 는 이제 **로그인 자리를 만드는 일**만 한다.
 *
 * 그러면 남는 진짜 물음은 ㉡ 이다. **저장 자리는 하나인데 판이 둘**이면
 * 누가 누구의 기록을 못 읽나. 여기서는 그걸 **거꾸로** 재서 본다 — 옛 엔진에게
 * 새 엔진이 쓴 세션을 지우라고 시킨다. 그게 ㉡ 의 거울상이다.
 */
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const CX = path.join(os.homedir(), ".codex");
const NAP = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 옛 엔진 — 이 기계가 예전에 받아둔 것 */
const OLD = "0.153.4";

function alive(id: string): { file: boolean; row: boolean } {
  let file = false;
  const walk = (dir: string): void => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory()) { walk(path.join(dir, e.name)); continue; }
      if (e.name.includes(id)) file = true;
    }
  };
  walk(path.join(CX, "sessions"));
  let row = false;
  try {
    const db = new DatabaseSync(path.join(CX, "state_5.sqlite"), { readOnly: true });
    row = (db.prepare("select count(*) c from threads where id = ?").get(id) as { c: number }).c > 0;
    db.close();
  } catch { /* 없으면 없는 것 */ }
  return { file, row };
}

function run(args: string[]): { ok: boolean; say: string } {
  try {
    const out = execFileSync("npx", args, { encoding: "utf8", timeout: 300000, shell: true });
    return { ok: true, say: out.trim().split("\n").slice(-2).join(" ").slice(0, 160) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, say: `${err.stdout ?? ""} ${err.stderr ?? ""} ${err.message ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 200) };
  }
}

function hostAt(dir: string): WorkspaceHost {
  return {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
}

async function main(): Promise<void> {
  const out: boolean[] = [];
  const agent = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
  const PIN = agent.args.filter((a) => a.includes("@openai/codex@"))[0] ?? "(못 찾음)";
  console.log(`\n우리 핀: ${PIN}  ·  옛 엔진: @openai/codex@${OLD}`);
  console.log(`사용자 PATH 의 codex: ${(() => {
    try { return execFileSync("codex", ["--version"], { encoding: "utf8", shell: true }).trim(); }
    catch { return "(안 깔려 있다)"; }
  })()}`);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-mis-"));
  const store = new RoomStore(dir); await store.init();
  const mgr = new RoomManager({ host: hostAt(dir), store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("   roomError:", e));

  console.log("\n[① 우리 핀으로 세션을 하나 만든다]");
  const room = await mgr.createRoom({ agentId: "codex", title: "판맞춤" });
  await mgr.send(room.id, "«봤다» 라고만 답해. 도구 쓰지 마.");
  for (let i = 0; i < 2400 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await NAP(25);
  const id = room.participants[0]?.sessionId ?? "";
  console.log(`   세션 ${id.slice(0, 18)}…`);
  out.push(mark(alive(id).file && alive(id).row, "★ 새 엔진이 쓴 세션이 있다"));

  /*
   * 붙잡고 있으면 못 지운다(실측). 어댑터를 놓고 잰다 — 판 차이를 재려는
   * 것이지 잠김을 재려는 게 아니다.
   */
  mgr.dispose();
  await NAP(2500);

  console.log(`\n[② 옛 엔진(${OLD})에게 그걸 지우라고 시킨다 — ㉡ 의 거울상]`);
  const old = run(["-y", "-p", `@openai/codex@${OLD}`, "codex", "delete", "--force", id]);
  console.log(`   ${old.ok ? "성공" : "실패"} «${old.say}»`);
  const afterOld = alive(id);
  console.log(`   그 뒤 · 파일 ${afterOld.file ? "있다" : "없다"} · threads ${afterOld.row ? "있다" : "없다"}`);
  out.push(mark(true, `★ 옛 엔진이 ${!afterOld.file && !afterOld.row ? "**지웠다**" : "**못 지웠다**"} — 이게 답이다`));

  console.log("\n[③ 치운다 — 우리 핀으로]");
  if (afterOld.file || afterOld.row) {
    const mine = run(["-y", ...agent.args.slice(1, -1), "codex", "delete", "--force", id]);
    console.log(`   ${mine.ok ? "성공" : "실패"} «${mine.say}»`);
  }
  const end = alive(id);
  out.push(mark(!end.file && !end.row, "★ 재느라 만든 세션을 안 남긴다"));

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
