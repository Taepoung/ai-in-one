/**
 * **나간 뒤 «한 번 더 치우기»가 돌아가나** (2026-10-01).
 *
 * 🔴 Codex 는 세션을 **파일과 sqlite 인덱스 둘**에 두는데 ACP 의
 * `session/delete` 는 **파일만 지운다**(`probes/leavereal.mts` 실측). 그래서
 * 방을 나갈 때마다 붕 뜬 행이 쌓이고 *"failed to resolve rollout path"* 가 난다.
 *
 * 우리가 그 sqlite 를 직접 만지는 대신 **그 CLI 가 제 손으로 치우게** 한다 —
 * `AgentDef.purgeSession` 에 적어두면 `deleteSession` 이 부른다.
 *
 * 진짜 CLI 로는 `probes/codexdelete.mts` 가 잰다. 여기서는 **가짜 에이전트**로
 * 그 배선만 본다 — 로그인도 할당량도 없이 매번 돌아야 하는 것들이다:
 *
 * ```
 * ① 적어둔 에이전트는 나갈 때 그 명령이 돈다
 * ② `{id}` 자리에 **그 세션 id** 가 들어간다
 * ③ 안 적어둔 에이전트는 **아무것도 안 띄운다** (Claude 가 그렇다)
 * ④ 명령이 없어도 나가기가 안 막힌다 — 뒷정리지 조건이 아니다
 * ⑤ **돌았는데 1 로 죽으면 로그에 남는다** — 삼키는 것과 못 보는 것은 다르다
 * ```
 *
 * ④가 제일 중요하다. `codex` 가 PATH 에 없는 사람에게 **방이 안 닫히면**
 * 그건 고치려던 것보다 훨씬 나쁜 일이다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

const logs: string[] = [];
function hostAt(dir: string): WorkspaceHost {
  return {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: (m: string) => { logs.push(m); }, defaultCwd: () => dir, hasWorkspace: () => true,
  };
}

/**
 * 뒷정리 명령 대신 **자국을 남기는 스크립트**를 물린다.
 *
 * 진짜 `codex delete` 를 부를 수는 없으므로(로그인·할당량), «무엇이 어떤
 * 인자로 불렸나» 만 파일에 적게 한다. 재려는 것이 바로 그것이다.
 */
function markerScript(dir: string): string {
  const js = path.join(dir, "mark.cjs");
  fs.writeFileSync(js, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.AIO_MARK, process.argv.slice(2).join(' ') + '\\n');",
  ].join("\n"), "utf8");
  return js;
}

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-purge-"));
  const store = new RoomStore(dir); await store.init();
  const mark = path.join(dir, "mark.txt");
  const js = markerScript(dir);

  const fake = {
    ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_MARK: mark },
  };
  /** 적어둔 쪽 — 나가면 이 명령이 돌아야 한다 */
  const withPurge = {
    ...fake, id: "purger", label: "치우개",
    purgeSession: { command: "node", args: [js, "delete", "--force", "{id}"] },
  };
  /** 아무 데도 없는 명령 — 실패해도 나가기가 막히면 안 된다 */
  const broken = {
    ...fake, id: "broken", label: "깨진것",
    purgeSession: { command: "이런-명령은-없다", args: ["{id}"] },
  };

  const mgr = new RoomManager({
    host: hostAt(dir), store, agents: [fake, withPurge, broken], configProbeMs: 20000,
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  const settle = async (id: string) => {
    for (let i = 0; i < 800 && !["idle", "error"].includes(mgr.statusOf(id)); i++) await nap(25);
  };
  const said = () => (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").trim() : "");

  console.log("\n[★ 적어둔 에이전트는 나갈 때 그 명령이 돈다]");
  {
    const room = await mgr.createRoom({ agentId: "purger", title: "치운다" });
    await mgr.send(room.id, "안녕");
    await settle(room.id);
    const sid = room.participants[0]?.sessionId ?? "";
    ok(sid.length > 0, `★ 세션이 붙었다 (${sid.slice(0, 12)}…)`);
    ok(said() === "", "★ 나가기 전엔 아무것도 안 돈다");

    await mgr.leaveRoom(room.id);
    for (let i = 0; i < 80 && !said(); i++) await nap(50);
    console.log(`   불린 것: «${said()}»`);
    ok(said().length > 0, "★ **나가면 돈다**");
    ok(said().includes(sid),
       `★ **{id} 자리에 그 세션 id** — 엉뚱한 세션을 지우면 남의 기록이 날아간다`);
    ok(said().includes("--force"),
       "★ 적어둔 인자가 그대로 간다 — `--force` 가 없으면 CLI 가 확인을 요구하며 거절한다");
  }

  console.log("\n[★ 안 적어둔 에이전트는 아무것도 안 띄운다]");
  {
    /*
     * Claude 가 이 경우다 — 거기선 **파일이 곧 목록**이라 ACP delete 하나로
     * 끝난다. 할 일이 없는데 명령을 띄우면 나가기만 느려진다.
     */
    fs.rmSync(mark, { force: true });
    const room = await mgr.createRoom({ agentId: "fake", title: "조용" });
    await mgr.send(room.id, "안녕");
    await settle(room.id);
    await mgr.leaveRoom(room.id);
    await nap(800);
    ok(said() === "", `★ 조용하다 (${JSON.stringify(said())})`);
  }

  console.log("\n[★ 뒷정리가 실패해도 나가기는 끝난다]");
  {
    /*
     * 🔴 **여기가 제일 중요하다.** `codex` 가 PATH 에 없는 사람에게 방이 안
     * 닫히면, 고치려던 것(목록이 지저분함)보다 훨씬 나쁜 일이 된다.
     * 뒷정리는 **기다리지 않고 띄우고 실패도 삼킨다.**
     */
    const room = await mgr.createRoom({ agentId: "broken", title: "깨진다" });
    await mgr.send(room.id, "안녕");
    await settle(room.id);

    const began = Date.now();
    await mgr.leaveRoom(room.id);
    const took = Date.now() - began;
    console.log(`   나가는 데 ${took}ms`);
    ok(took < 3000, `★ **안 막힌다** (${took}ms) — 없는 명령을 기다리면 안 된다`);

    const left = await store.loadRoom(room.id);
    ok(left === undefined || left === null, "★ 방도 제대로 지워졌다");
  }

  console.log("\n[★ 돌았는데 거절당하면 로그에 남는다]");
  {
    /*
     * 🔴 **삼키는 것과 못 보는 것은 다르다** (2026-10-01).
     *
     * 위의 «깨진것» 은 **띄우기 자체가** 안 된다 — `error` 가 온다. 그런데
     * 저쪽 CLI 가 `--force` 를 갈아끼우는 쪽이 **훨씬 있을법하고**, 그때는
     * 띄우기가 멀줦히 되고 **종료코드만 바뀜다.**
     *
     * 예전엔 `stdio: "ignore"` 에 `error` 만 들어서 그걸 통째로 못 봤다. 그러면
     * 세션이 다시 쌀이기 시작하는데 **아무 기록도 안 남고**, 사용자는 몇 달
     * 뒤 목록이 유령으로 차고나서 알게 된다. 이미 한 번 걷은 길이다.
     *
     * 막지는 않되 **남긴다.**
     */
    const bad = path.join(dir, "bad.cjs");
    fs.writeFileSync(bad, [
      "process.stderr.write('unknown option --force');",
      "process.exit(2);",
    ].join("\n"), "utf8");
    const refuses = {
      ...fake, id: "refuser", label: "거절하는것",
      purgeSession: { command: "node", args: [bad, "{id}"] },
    };
    const m2 = new RoomManager({
      host: hostAt(dir), store, agents: [refuses], configProbeMs: 20000,
    });
    m2.on("roomError", () => {}); m2.on("notice", () => {});

    const room = await m2.createRoom({ agentId: "refuser", title: "거절한다" });
    await m2.send(room.id, "안녕");
    for (let i = 0; i < 800 && !["idle", "error"].includes(m2.statusOf(room.id)); i++) await nap(25);

    logs.length = 0;
    const began = Date.now();
    await m2.leaveRoom(room.id);
    const took = Date.now() - began;
    ok(took < 3000, `★ 그래도 나가기는 안 막힌다 (${took}ms)`);

    /*
     * ⚠️ **«뒷정리» 가 든 줄은 둘이다** — «N 으로 끝났습니다»(저쪽이 거절)와
     * «못 했습니다»(아예 못 띄움). 재려는 것은 **앞엣것**인데, 스위트가 한꺼번에
     * 돌면 프로세스를 못 띄워 뒤엣것이 나올 수 있다(2026-10-12에 한 번 그랬다).
     *
     * 그때는 **재려던 것이 깨진 것이 아니라 전제가 안 선 것**이다 — 섞어서
     * «실패» 로 찍으면 읽는 사람이 엉뚱한 곳을 판다.
     */
    for (let i = 0; i < 80 && !logs.some((l) => l.includes("뒷정리")); i++) await nap(50);
    const note = logs.find((l) => l.includes("뒷정리")) ?? "";
    console.log(`   남은 말: «${note}»`);
    ok(note.length > 0, "★ **조용히 안 넘어간다** — 종료코드가 로그로 남는다");
    if (!note.includes("끝났습니다")) {
      throw new Error(`FAIL: 전제가 안 섰다 — 뒷정리 프로세스를 못 띄웠다: ${note}`);
    }
    ok(note.includes("2"), "★ 몇으로 죽었는지가 들어 있다");
    ok(note.includes("unknown option"),
       "★ **저쪽이 한 말이 들어 있다** — 없으면 «안 됐다» 만 알고 왜인지를 모른다");
    m2.dispose();
  }

  mgr.dispose();
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
