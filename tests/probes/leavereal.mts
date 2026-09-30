/**
 * **방을 나가면 진짜 CLI 쪽에 무엇이 남나 — 우리 코드로** (2026-09-30).
 *
 * 사용자 짐작: *"아마 내가 테스트 하면서 생긴거 같아. 그때는 나가기에서
 * 제대로 지워지지 않았을 가능성이 있어."*
 *
 * `~/.claude/projects/<이 프로젝트>/` 에 **한 턴짜리 세션 73개**가 사흘에
 * 걸쳐 쌓여 있었다(9-20~22). 전부 `assistant` 한 줄에 `user` 줄은 0 —
 * 즉 **대화가 지워지다 만 모양**이다.
 *
 * `delsess.cjs` 는 ACP 를 **손으로 말해서** 잰다. 그런데 물어야 할 것은
 * «우리 앱에서 나가기를 누르면» 이다 — 그 사이에 `leaveRoom` 이 있고, 거기서
 * 봇마다 세션을 지울지 닫을지 가른다(`sessionPrompted`). 실제로 그 자리에
 * **참여자 하나만 지우던 버그**가 있었다(2026-09-28 고침).
 *
 * 그래서 **RoomManager 로** 끝까지 밟는다:
 *
 * ```
 * ① 방을 만들고 말을 건다        → 세션 파일이 생긴다
 * ② leaveRoom                    → 우리가 지운다고 한 그 동작
 * ③ 파일이 어떻게 됐나           → 사라졌나 · 껍데기만 남았나 · 그대로인가
 * ④ 단체방도 같은가              → 봇 둘일 때 **둘 다** 지워지나
 * ```
 *
 * ③이 핵심이다. 셋은 사용자에게 서로 다른 얘기다:
 *
 * ```
 * 사라졌다        CLI 목록에 안 뜬다                     제일 깨끗
 * 껍데기만        목록에는 뜨는데 열면 빈다              기록해둔 그것
 * 그대로          **대화가 남는다** — 나갔는데 안 지워진 것
 * ```
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };

/** `~/.claude/projects/` 의 슬러그 — 경로의 구분자가 `-` 가 된다 */
function slugOf(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-");
}

/** 그 세션 파일이 지금 어떤 상태인가 */
function stateOf(file: string): { kind: string; said: number; lines: number } {
  if (!fs.existsSync(file)) return { kind: "사라졌다", said: 0, lines: 0 };
  let said = 0, lines = 0;
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    lines++;
    try {
      const t = (JSON.parse(l) as { type?: string }).type;
      if (t === "user" || t === "assistant") said++;
    } catch { /* 깨진 줄은 안 센다 */ }
  }
  return { kind: said === 0 ? "껍데기만" : "그대로", said, lines };
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

async function run(label: string, bots: number): Promise<boolean[]> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-leave-"));
  const store = new RoomStore(dir); await store.init();
  const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
  const mgr = new RoomManager({ host: hostAt(dir), store, agents: [claude], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => console.log("   roomError:", e));

  console.log(`\n[${label}]`);
  const room = await mgr.createRoom({
    agentId: "claude", title: "나가기",
    ...(bots > 1 ? { bots: Array.from({ length: bots }, () => ({ agentId: "claude" })) } : {}),
  });
  /*
   * 🔴 **봇마다 한 마디씩 시켜야 한다.**
   *
   * 처음엔 한 번만 보냈다. 단체방에서는 지목 안 한 말이 모두에게 안 가므로
   * **둘째 봇은 한 마디도 안 했고, 그러면 세션 파일이 아예 안 생긴다.** 그런
   * 파일을 «사라졌다» 로 세면 지우기가 잘 된 것처럼 보인다 — 재려는 것이
   * 없는 상태를 통과로 읽는 것이다.
   */
  for (const bot of room.participants) {
    await mgr.send(room.id, "«봤다» 라고만 답해. 도구 쓰지 마.", undefined, bot.id);
    await settle(mgr, room.id);
  }

  const ids = room.participants.map((b) => b.sessionId).filter((x): x is string => !!x);
  const slug = slugOf(dir);
  const files = ids.map((id) => path.join(os.homedir(), ".claude", "projects", slug, `${id}.jsonl`));
  console.log(`   세션 ${ids.length}개 · 파일 ${files.filter((f) => fs.existsSync(f)).length}개 생김`);
  const before = files.map(stateOf);
  console.log(`   나가기 전: ${before.map((s) => `${s.kind}(대화 ${s.said}줄)`).join(" · ")}`);

  await mgr.leaveRoom(room.id);
  await new Promise((r) => setTimeout(r, 2500));

  const after = files.map(stateOf);
  console.log(`   나간 뒤  : ${after.map((s) => `${s.kind}(대화 ${s.said}줄)`).join(" · ")}`);

  const out = [
    mark(before.every((s) => s.said > 0), "★ 나가기 전엔 대화가 들어 있었다 (이 측정이 뜻을 가지려면)"),
    mark(after.every((s) => s.said === 0),
         `★ **나간 뒤 대화가 한 줄도 안 남는다** (${after.map((s) => s.said).join(",")}) — 남으면 «나갔는데 안 지워진 것»이다`),
    mark(after.length === ids.length && ids.length === bots,
         `★ 봇 수만큼 세션이 있었다 (${ids.length}/${bots})`),
  ];
  mgr.dispose();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 잠겼으면 다음에 */ }
  return out;
}

async function main(): Promise<void> {
  const r1 = await run("① 1:1 방", 1);
  const r2 = await run("② 단체방 (봇 둘) — 여기에 «하나만 지우던» 버그가 있었다", 2);
  const all = [...r1, ...r2];
  console.log(`\n  ${all.filter(Boolean).length}/${all.length}`);
  process.exit(all.every(Boolean) ? 0 : 1);
}

void main().catch((e: unknown) => { console.error("실패:", e); process.exit(1); });
