/**
 * **Codex 를 깨끗이 지우는 안전한 길이 있나** (2026-10-01).
 *
 * 사용자 물음: *"그냥 둬야지 어쩌겠어... 안전한 방법은 없을까"*.
 *
 * 앞서 잰 것: 우리 앱에서 방을 나가면 ACP `session/delete` 가 돌고, **파일은
 * 사라지는데 sqlite 인덱스 행은 남는다**(`leavereal.mts`). 그래서 확장 목록엔
 * 뜨고 열면 «파일이 없다» 가 난다.
 *
 * 고칠 길이 셋인데 둘은 마음에 안 든다:
 *
 * ```
 * ㉠ 우리가 DB 행을 지운다      남의 제품 스키마에 손을 넣는다. 바뀌면 깨진다
 * ㉡ 그냥 둔다                  쓸수록 목록이 지저분해진다
 * ㉢ **Codex 가 제 손으로**     `codex delete <id>` 가 있다  ← 이걸 잰다
 * ```
 *
 * ㉢이 되면 우리는 **남의 저장소를 안 만지고도** 깨끗이 끝낼 수 있다. 재는 것:
 *
 * ```
 * ① 파일이 사라지나
 * ② **인덱스 행도 사라지나**   ← ACP delete 가 못 한 바로 그것
 * ③ 이미 파일이 없는 행도 걷히나 (우리가 이미 반만 지운 것들)
 * ```
 *
 * ③이 중요하다. 우리 앱이 ACP 로 먼저 지워 파일이 없어진 뒤라면, `codex
 * delete` 가 «그런 세션 없다» 며 거절할 수도 있다 — 그러면 뒤처리로는 못 쓴다.
 */
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const CX = path.join(os.homedir(), ".codex");

/** 그 세션이 지금 파일·인덱스에 남아 있나 */
function left(id: string): { file: boolean; row: boolean } {
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
    const r = db.prepare("select count(*) c from threads where id = ?").get(id) as { c: number };
    row = r.c > 0;
    db.close();
  } catch { /* 못 읽으면 모르는 것으로 둔다 */ }
  return { file, row };
}

/** `codex delete <id>` 를 돌리고 무슨 말을 했는지 돌려준다 */
function codexDelete(id: string): { ok: boolean; say: string } {
  try {
    /*
     * 🔴 `shell: true` 가 있어야 한다. Windows 에서 `codex` 는 `.cmd` 라
     * 그냥 spawn 하면 `ENOENT` 다 — 명령이 없는 것으로 읽혀서 «지우기가
     * 안 된다» 로 거꾸로 읽을 뻔했다. 우리 어댑터를 띄울 때와 같은 이유다.
     */
    /*
     * `--force` 가 있어야 한다. 없으면 «터미널이 아니라 확인을 받을 수
     * 없다» 고 거절한다 — 사람이 아닌 것이 부를 때를 위해 둔 문이다.
     */
    const out = execFileSync("codex", ["delete", "--force", id],
      { encoding: "utf8", timeout: 120000, shell: true });
    return { ok: true, say: out.trim().split("\n").slice(-2).join(" ").slice(0, 120) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const say = `${err.stdout ?? ""} ${err.stderr ?? ""} ${err.message ?? ""}`;
    return { ok: false, say: say.trim().replace(/\s+/g, " ").slice(0, 160) };
  }
}

function hostAt(dir: string): WorkspaceHost {
  return {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
}

const settle = async (mgr: RoomManager, id: string) => {
  for (let i = 0; i < 2400; i++) {
    if (["idle", "error"].includes(mgr.statusOf(id))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Codex 방을 하나 만들고 한 마디 시킨 뒤 세션 id 를 돌려준다 */
async function makeRoom(): Promise<{ id: string; close: () => void }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-cxdel-"));
  const store = new RoomStore(dir); await store.init();
  const agent = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
  const mgr = new RoomManager({ host: hostAt(dir), store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("   roomError:", e));
  const room = await mgr.createRoom({ agentId: "codex", title: "지우기" });
  await mgr.send(room.id, "«봤다» 라고만 답해. 도구 쓰지 마.");
  await settle(mgr, room.id);
  const id = room.participants[0]?.sessionId ?? "";
  return {
    id,
    close: () => {
      mgr.dispose();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 잠겼으면 다음에 */ }
    },
  };
}

/**
 * ★ **제품이 실제로 밟을 순서** (2026-10-01).
 *
 * ①②는 «어댑터를 끈 뒤» 불렀다. 그런데 제품에서는 `leaveRoom` 안에서 부르게
 * 되므로 **어댑터가 아직 살아 있다.** 붙잡고 있는 세션은 못 지운다는 걸
 * ①에서 봤으니, 이 순서로도 되는지는 따로 재야 한다.
 *
 * ```
 * leaveRoom  →  ACP session/delete   (파일이 사라진다)
 *            →  codex delete --force (행을 걷는다)   ← 이게 여기서 되나?
 * ```
 *
 * 안 되면 설계를 바꿔야 한다 — 연결을 놓은 뒤로 미루거나, 나중에 모아서
 * 치우거나.
 */
async function liveOrder(): Promise<boolean[]> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-cxlive-"));
  const store = new RoomStore(dir); await store.init();
  const agent = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
  const mgr = new RoomManager({ host: hostAt(dir), store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("   roomError:", e));

  console.log("\n[③ 제품 순서 — leaveRoom 직후, 어댑터가 **살아 있는 채로**]");
  const room = await mgr.createRoom({ agentId: "codex", title: "살아있는채로" });
  await mgr.send(room.id, "«봤다» 라고만 답해. 도구 쓰지 마.");
  await settle(mgr, room.id);
  const id = room.participants[0]?.sessionId ?? "";

  await mgr.leaveRoom(room.id);
  const mid = left(id);
  console.log(`   나간 직후 · 파일 ${mid.file ? "있다" : "없다"} · 행 ${mid.row ? "있다" : "없다"}`);

  /*
   * ★ **이제 제품이 스스로 한다** (2026-10-01).
   *
   * `AgentDef.purgeSession` 에 적어두고 `deleteSession` 이 부른다. 그래서
   * 여기서는 **우리가 따로 안 부른다** — 나간 것만으로 행이 걷혀야 한다.
   *
   * 🔴 한 번 여기서 `codexDelete` 를 또 불렀다가 «failed to delete session»
   * 을 받았다. **제품이 먼저 지워버린 뒤**라 지울 것이 없었던 것이다 —
   * 기능이 도는 증거였는데 실패로 읽을 뻔했다.
   *
   * 뒷정리는 기다리지 않고 띄우므로(나가기를 막으면 안 된다) 잠시 기다린다.
   */
  for (let i = 0; i < 60 && left(id).row; i++) {
    await new Promise((x) => setTimeout(x, 250));
  }
  const after = left(id);
  console.log(`   잠시 뒤 · 행 ${after.row ? "있다" : "없다"}`);

  const out = [
    mark(!mid.file, "★ ACP delete 가 파일을 지웠다"),
    mark(!after.row,
         "★ **나가기만 했는데 행까지 걷혔다** — `purgeSession` 이 제품에서 돌았다"),
  ];
  mgr.dispose();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 잠겼으면 다음에 */ }
  return out;
}

async function main(): Promise<void> {
  const out: boolean[] = [];

  console.log("\n[① 멀쩡한 세션을 `codex delete` 로]");
  {
    const r = await makeRoom();
    const before = left(r.id);
    console.log(`   ${r.id.slice(0, 18)}… · 파일 ${before.file ? "있다" : "없다"} · 행 ${before.row ? "있다" : "없다"}`);
    out.push(mark(before.file && before.row, "★ 지우기 전엔 둘 다 있었다"));

    /*
     * 🔴 **붙잡고 있는 세션은 못 지운다.** 처음엔 방을 열어둔 채로 불렀다가
     * «failed to delete session» 을 받고 **«codex delete 는 안 된다»** 로 읽을
     * 뻔했다. 어댑터가 그 세션을 열어두고 있었을 뿐이다. 닫고 잰다 — 우리 앱도
     * 나간 뒤에 부를 테니 그쪽이 진짜 상황이다.
     */
    r.close();
    await new Promise((x) => setTimeout(x, 2000));

    const said = codexDelete(r.id);
    console.log(`   codex delete → ${said.ok ? "성공" : "실패"} ${said.say ? `«${said.say}»` : ""}`);
    const after = left(r.id);
    console.log(`   지운 뒤 · 파일 ${after.file ? "있다" : "없다"} · 행 ${after.row ? "있다" : "없다"}`);
    out.push(mark(!after.file, "★ 파일이 사라진다"));
    out.push(mark(!after.row, "★ **인덱스 행도 사라진다** — ACP delete 가 못 하던 바로 그것"));
  }

  console.log("\n[② 우리 앱이 먼저 반만 지운 뒤에도 뒤처리가 되나]");
  {
    /*
     * 🔴 **이쪽이 진짜 쓰임새다.** 우리 앱은 나갈 때 ACP `session/delete` 를
     * 부르고, 그러면 파일만 사라진다. 그 **뒤에** `codex delete` 를 불러서
     * 남은 행을 걷을 수 있어야 쓸모가 있다.
     *
     * 안 되면(«그런 세션 없다» 로 거절하면) 이 길은 **뒤처리로는 못 쓴다** —
     * 나가기 «전에» 불러야 한다는 뜻이고, 그건 순서를 바꾸는 일이다.
     */
    const r = await makeRoom();
    const id = r.id;
    r.close();                                   // 아직 안 지웠다. 방만 닫는다
    await new Promise((x) => setTimeout(x, 1500));

    // 우리 앱이 하는 것과 같은 일: 파일만 없앤다
    const walk = (dir: string): void => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name.includes(id)) fs.rmSync(full);
      }
    };
    walk(path.join(CX, "sessions"));

    const mid = left(id);
    console.log(`   파일만 지운 뒤 · 파일 ${mid.file ? "있다" : "없다"} · 행 ${mid.row ? "있다" : "없다"}`);
    out.push(mark(!mid.file && mid.row, "★ **붕 뜬 상태를 만들었다** — 우리 앱이 나갈 때 되는 그 모양"));

    const said = codexDelete(id);
    console.log(`   codex delete → ${said.ok ? "성공" : "실패"} ${said.say ? `«${said.say}»` : ""}`);
    const after = left(id);
    console.log(`   그 뒤 · 행 ${after.row ? "있다" : "없다"}`);
    out.push(mark(!after.row,
      "★ **파일이 없어도 행을 걷는다** — 되면 뒤처리로 쓸 수 있다"));
  }

  out.push(...(await liveOrder()));

  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
  process.exit(out.every(Boolean) ? 0 : 1);
}

void main().catch((e: unknown) => { console.error("실패:", e); process.exit(1); });
