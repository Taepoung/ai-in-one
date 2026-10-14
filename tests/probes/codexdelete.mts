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
import { withInstalled } from "../../src/core/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const CX = path.join(os.homedir(), ".codex");

/** 확장이 에이전트를 받아두는 자리 — 제품이 보는 그곳 */
const AGENTS_ROOT = path.join(
  process.env.APPDATA ?? os.homedir(), "Code", "User", "globalStorage",
  "taein-yoon.ai-in-one",
);

/** 그 세션이 지금 파일·인덱스에 남아 있나 */
function left(id: string): { file: boolean; row: boolean; cat: boolean } {
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

  const count = (file_: string, sql: string): boolean => {
    try {
      const db = new DatabaseSync(path.join(CX, file_), { readOnly: true });
      const r = db.prepare(sql).get(id) as { c: number };
      db.close();
      return r.c > 0;
    } catch { return false; }
  };

  return {
    file,
    row: count("state_5.sqlite", "select count(*) c from threads where id = ?"),
    /*
     * ★ **앱이 목록을 읽는 자리는 여기다** (2026-10-01).
     *
     * 🔴 `.codex` 바로 아래의 `*.sqlite` 만 보다가 **`sqlite/` 하위 폴더를
     * 놓쳤다.** 파일과 `threads` 를 다 비워놓고 «깨끗하다» 고 세 번 말했는데,
     * 앱은 계속 목록에 띄웠다 — 열면 *"no rollout found for thread id …"*.
     *
     * 증상이 가리키는 id 로 **전체를 뒤졌어야** 했다. 아는 자리를 하나씩
     * 확인하는 방식은 «내가 아는 자리» 밖을 못 본다.
     */
    cat: count(path.join("sqlite", "codex-dev.db"),
               "select count(*) c from local_thread_catalog where thread_id = ?"),
  };
}

/** 세 자리를 한 줄로 */
const show = (s: { file: boolean; row: boolean; cat: boolean }): string =>
  `파일 ${s.file ? "있다" : "없다"} · threads ${s.row ? "있다" : "없다"} · 목록 ${s.cat ? "있다" : "없다"}`;

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
  /*
   * 🔴 **받아둔 자리를 쓴다** (2026-10-14).
   *
   * 여기서 카탈로그의 `AgentDef` 를 그대로 넘기고 있었다. 그런데 뒷정리
   * 명령(`purgeSession`)은 **`withInstalled` 가 만들어 넣는 칸**이다 — 품은
   * exe 의 자리를 알아야 하므로. 그래서 이 프로브는 **뒷정리가 아예 안 걸린
   * 채로** 돌았고, ③ 의 NO 가 **판 탓인지 프로브 탓인지** 알 수 없었다.
   * 2026-10-14 에 핀을 올리다 걸렸다.
   *
   * ⚠️ 받아둔 것이 없으면 **NO 가 아니라 «전제가 안 섰다»** 다 — 없는 것을
   * 못 잰 것과, 있는데 안 되는 것은 다르다.
   */
  const agent = withInstalled(DEFAULT_AGENTS.find((a) => a.id === "codex")!, AGENTS_ROOT);
  if (!agent.purgeSession) {
    console.log("\n[③] 전제가 안 섰다 — 받아둔 Codex 가 없어 뒷정리 명령이 안 붙었다.");
    console.log("     로봇 화면에서 받은 뒤 다시 돌린다. `realinstall.mts` 가 같은 자리를 잰다.");
    return [];
  }
  const mgr = new RoomManager({ host: hostAt(dir), store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("   roomError:", e));

  console.log("\n[③ 제품 순서 — leaveRoom 직후, 어댑터가 **살아 있는 채로**]");
  const room = await mgr.createRoom({ agentId: "codex", title: "살아있는채로" });
  await mgr.send(room.id, "«봤다» 라고만 답해. 도구 쓰지 마.");
  await settle(mgr, room.id);
  const id = room.participants[0]?.sessionId ?? "";

  await mgr.leaveRoom(room.id);
  const mid = left(id);
  console.log(`   나간 직후 · ${show(mid)}`);

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
  for (let i = 0; i < 60 && (left(id).row || left(id).cat); i++) {
    await new Promise((x) => setTimeout(x, 250));
  }
  const after = left(id);
  console.log(`   잠시 뒤 · ${show(after)}`);

  const out = [
    mark(!mid.file, "★ ACP delete 가 파일을 지웠다"),
    mark(!after.row && !after.cat,
         "★ **나가기만 했는데 threads 와 앱 목록까지 걷혔다** — `purgeSession` 이 돌았다"),
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
    console.log(`   ${r.id.slice(0, 18)}… · ${show(before)}`);
    /*
     * ★ **앱 목록은 «쓰는 자리» 가 아니라 «긁는 자리» 다** (2026-10-01).
     *
     * 여기서 `before.cat` 까지 있을 거라 둘었다가 NO 를 받았다. 눈금이
     * 틀렸다 — `local_thread_catalog` 은 세션을 만들 때 써지는 게 아니다.
     * 옆에 `…_scan_checkpoints` 와 `…_scan_entries` 가 같이 있는 것이
     * 답이다: **앱이 `sessions/` 를 돌면서 채운다.**
     *
     * 그래서 우리가 내는 세션은 «들어갔다 나오는» 게 아니라 **아예 안
     * 들어간다** — 긁기 전에 파일이 없어지니까. 사용자가 본 유령들은
     * `purgeSession` 이 없던 시절에 **긁힐 만큼 오래 남아있던** 것들이다.
     *
     * 그래서 여기선 파일과 `threads` 만 본다. `cat` 은 **지운 뒤에도 없어야
     * 한다**는 쪽으로만 재고, 그건 아래에서 따진다.
     */
    out.push(mark(before.file && before.row, "★ 지우기 전엔 파일과 threads 가 있었다"));
    out.push(mark(!before.cat, "★ 앱 목록엔 애초 안 들어간다 — 거길 채우는 건 앱의 긁기다"));

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
    console.log(`   지운 뒤 · ${show(after)}`);
    out.push(mark(!after.file, "★ 파일이 사라진다"));
    out.push(mark(!after.row, "★ **인덱스 행도 사라진다** — ACP delete 가 못 하던 바로 그것"));
    out.push(mark(!after.cat, "★ **앱 목록에서도 빠진다** — 여기가 남으면 «열 수 없는 세션» 이 된다"));
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
    console.log(`   파일만 지운 뒤 · ${show(mid)}`);
    out.push(mark(!mid.file && mid.row, "★ **붕 뜬 상태를 만들었다** — 우리 앱이 나갈 때 되는 그 모양"));

    const said = codexDelete(id);
    console.log(`   codex delete → ${said.ok ? "성공" : "실패"} ${said.say ? `«${said.say}»` : ""}`);
    const after = left(id);
    console.log(`   그 뒤 · ${show(after)}`);
    out.push(mark(!after.row,
      "★ **파일이 없어도 행을 걷는다** — 되면 뒤처리로 쓸 수 있다"));
  }

  out.push(...(await liveOrder()));

  console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
  process.exit(out.every(Boolean) ? 0 : 1);
}

void main().catch((e: unknown) => { console.error("실패:", e); process.exit(1); });
