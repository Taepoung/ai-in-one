/**
 * ★ **생성 중에 죽이면 저쪽은 그 턴을 기억하나** (2026-10-14) — WORK.md 4.5-S.
 *
 * 4.5-W(「이어서 하기」 단추)의 **모양이 여기에 걸려 있다**:
 *
 * ```
 * 저쪽이 그 턴을 기억한다   → 「이어서 하기」가 맞다
 * 저쪽도 못 기억한다        → 「다시 시켜」가 맞다 (로드맵: «보정할 게 없다»)
 * ```
 *
 * 추측으로 짓지 않는다. 그래서 잰다.
 *
 * ```
 * ① 짧은 말로 세션을 디스크에 남긴다 (첫 프롬프트가 있어야 남는다 — §13.1)
 * ② 긴 답을 시킨다
 * ③ 글자가 오기 시작하면 **CLI 를 SIGKILL** 한다
 * ④ 우리 쪽에 뭐가 남았나 — streaming · truncated · 상태
 * ⑤ **창을 껐다 켠 것처럼** 새 매니저로 같은 방을 열어 resume
 * ⑥ «방금 뭐라고 했지» 를 묻는다  ← 여기가 답이다
 * ⑦ 저쪽 세션 파일도 같이 본다 (우리 말이 아니라 저쪽 장부)
 * ```
 *
 * 손으로 돌린다 — **진짜 CLI 와 로그인이 필요하다.**
 *
 * ```
 * npx tsx tests/probes/killresume.mts          (claude)
 * npx tsx tests/probes/killresume.mts codex
 * npx tsx tests/probes/killresume.mts antigravity
 * ```
 *
 * ⚠️ **셋 다 봐야 한다** (P6). 세션을 적는 때가 저마다 다를 수 있다.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import { withInstalled } from "../../src/core/agentInstaller.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";
import type { Room } from "../../src/core/types.js";

const NL = "\n";
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(s);

const WANT = process.argv[2] ?? "claude";
/**
 * ★ **받아둔 자리를 알려줘야 한다** (2026-10-14).
 *
 * 🔴 안 알려주면 Antigravity 가 **안 뜬다** — `The argument 'file' cannot be
 * empty`. npx 로 도는 둘(claude·codex)과 달리 저쪽은 **내려받은 실행파일**이라
 * 카탈로그에는 자리가 비어 있고, `withInstalled` 가 그 자리를 채운다.
 * 확장이 `readAgents` 에서 하는 것과 같은 일이다.
 */
const AGENT_ROOT = path.join(
  os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "taein-yoon.ai-in-one",
);
/** 긴 답 — 중간에 죽일 틈이 있어야 한다. 짧으면 끝나버린다 */
const LONG = "1부터 40까지 한 줄에 하나씩, 숫자만 세어줘. 도구는 쓰지 마.";

function makeHost(dir: string): WorkspaceHost {
  return {
    readTextFile: async () => "",
    writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {},
    defaultCwd: () => dir,
    hasWorkspace: () => true,
  };
}

/** 그 방이 조용해질 때까지 — 안 되면 그냥 넘어간다(죽인 뒤엔 error 로 끝난다) */
async function settle(mgr: RoomManager, roomId: string, ms = 60000): Promise<void> {
  for (let i = 0; i < ms / 25; i++) {
    if (["idle", "error"].includes(mgr.statusOf(roomId))) return;
    await nap(25);
  }
}

async function main(): Promise<void> {
  const found = DEFAULT_AGENTS.find((a) => a.id === WANT);
  if (!found) { say(`그런 에이전트가 없다: ${WANT}`); process.exit(1); }
  const agent = withInstalled(found, AGENT_ROOT);
  say(`  명령: ${agent.command} ${agent.args.join(" ").slice(0, 80)}`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-kill-"));
  const store = new RoomStore(dir);
  await store.init();
  const host = makeHost(dir);

  say(`${NL}[${agent.label}] 작업폴더 ${dir}`);

  const mgr = new RoomManager({ host, store, agents: [agent], configProbeMs: 60000 });
  mgr.on("roomError", (_r, e) => say(`  roomError: ${e}`));
  mgr.on("notice", (_r, m) => say(`  notice: ${m}`));

  const room = await mgr.createRoom({ agentId: agent.id, title: "죽이고 잇기" });
  const bot = room.participants[0]!;

  // ── ① 세션을 디스크에 남긴다 — 첫 프롬프트가 있어야 남는다
  await mgr.send(room.id, "«준비» 라고만 답해.");
  await settle(mgr, room.id);
  const sessionId = bot.sessionId ?? "(없음)";
  say(`  세션: ${sessionId}`);
  say(`  첫 답: ${JSON.stringify(room.messages.at(-1)?.text?.slice(0, 40))}`);

  // ── ② 긴 답을 시킨다
  void mgr.send(room.id, LONG);

  // ── ③ 글자가 오기 시작하면 죽인다
  const inner = mgr as unknown as {
    connections: Map<string, { proc?: { pid?: number; kill(sig?: string): boolean } }>;
  };
  let killed = false;
  for (let i = 0; i < 1200; i++) {
    const live = room.messages.at(-1);
    const flowing = live?.role === "agent" && (live.text?.length ?? 0) > 10;
    if (flowing) {
      const proc = inner.connections.get(agent.id)?.proc;
      say(`  글자 ${live!.text.length}자에서 죽인다 — pid ${proc?.pid}`);
      proc?.kill("SIGKILL");
      killed = true;
      break;
    }
    await nap(25);
  }
  if (!killed) say("  🔴 전제가 안 섰다 — 글자가 안 왔다");
  await settle(mgr, room.id, 20000);

  // ── ④ 우리 쪽에 뭐가 남았나
  const cut = room.messages.at(-1)!;
  say(`${NL}  [우리 쪽]`);
  say(`    상태      ${mgr.statusOf(room.id)}`);
  say(`    streaming ${String(cut.streaming)}   truncated ${String(cut.truncated)}`);
  say(`    글자      ${cut.text?.length ?? 0}자 · 꼬리 ${JSON.stringify(cut.text?.slice(-24))}`);
  mgr.dispose();
  await nap(300);

  // ── ⑤ 창을 껐다 켠 것처럼 — 새 매니저로 같은 방을 연다
  const store2 = new RoomStore(dir);
  await store2.init();
  const again = new RoomManager({
    host: makeHost(dir), store: store2, agents: [agent], configProbeMs: 60000,
  });
  again.on("roomError", (_r, e) => say(`  roomError: ${e}`));
  again.on("notice", (_r, m) => say(`  notice: ${m}`));

  const back: Room = await again.openRoom(room.id);
  const healed = back.messages.at(-1)!;
  say(`${NL}  [다시 열었다 — 디스크에서]`);
  say(`    streaming ${String(healed.streaming)}   truncated ${String(healed.truncated)}`);
  say(`    error     ${JSON.stringify(healed.error)}`);
  say(`    contextLost ${String(back.contextLost)}`);

  // ── ⑥ «방금 뭐라고 했지» — 여기가 답이다
  await again.send(back.id, "방금 네가 하던 답을 어디까지 했는지 한 줄로 말해줘. 기억 안 나면 «모름» 이라고만 해.");
  await settle(again, back.id);
  const asked = back.messages.at(-1);
  say(`${NL}  ★ 저쪽의 답: ${JSON.stringify(asked?.text?.slice(0, 300))}`);
  say(`    세션 ${back.participants[0]!.sessionId === sessionId ? "그대로" : "새로 열렸다"}`);
  again.dispose();
  await nap(300);

  // ── ⑦ 저쪽 장부도 본다
  say(`${NL}  [저쪽 세션 파일]`);
  const roots = [
    path.join(os.homedir(), ".claude", "projects"),
    path.join(os.homedir(), ".codex", "sessions"),
  ];
  for (const root of sessionId === "(없음)" ? [] : roots) {
    const hit = await findSession(root, sessionId);
    if (!hit) continue;
    const lines = (await fs.readFile(hit, "utf8")).trim().split(NL);
    say(`    ${hit}`);
    say(`    ${lines.length}줄 · 마지막 2줄:`);
    for (const l of lines.slice(-2)) say(`      ${l.slice(0, 220)}`);
  }

  say(`${NL}  (작업폴더는 남겨둔다 — 손으로 더 볼 수 있게: ${dir})`);
}

/** 세션 id 나 작업폴더 이름으로 저쪽 기록을 찾는다 */
async function findSession(root: string, sessionId: string): Promise<string | undefined> {
  let names: string[];
  try { names = await fs.readdir(root); } catch { return undefined; }
  for (const name of names) {
    const full = path.join(root, name);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    if (stat.isDirectory()) {
      const deeper = await findSession(full, sessionId);
      if (deeper) return deeper;
      continue;
    }
    if (!name.endsWith(".jsonl")) continue;
    if (name.includes(sessionId)) return full;
    /*
     * Codex 는 이름에 날짜가 끼어 있어 안을 봐야 한다.
     *
     * 🔴 **큰 파일은 안 연다.** 한 번 사용자의 **지금 이 대화 기록**(62194줄)을
     * 통째로 읽었다 — 거기 프로브 출력이 적혀 있어서 작업폴더 이름이 걸렸다.
     * 남의 기록을 뒤지는 셈이고, 느리기까지 하다.
     */
    if (stat.size > 4_000_000) continue;
    try {
      const text = await fs.readFile(full, "utf8");
      if (text.includes(sessionId)) return full;
    } catch { /* 못 읽으면 넘어간다 */ }
  }
  return undefined;
}

main().catch((e) => { console.error(e); process.exit(1); });
