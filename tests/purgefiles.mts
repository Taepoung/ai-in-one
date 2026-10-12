/**
 * **지울 명령이 없는 에이전트는 파일을 지운다** (2026-10-12 실측).
 *
 * 🔴 Antigravity 에는 세션을 지우는 길이 **아예 없다.** 여덟 이름을 두드려
 * 봤고(`probes/agymethods.cjs`) 되는 것은 `close`·`list`·`resume` 셋뿐이다.
 * `agy` CLI 에도 서브커맨드가 없고, 게다가 **다른 집**을 본다(PIN §G4-2).
 *
 * 안 지우면 **대화 전문이 평문으로 쌓인다** — 실측에서 세션에 심어둔 비밀이
 * 지운 뒤에도 `brain/<id>/.system_generated/logs/transcript.jsonl` 에 그대로
 * 있었다(`probes/agydelete.cjs`). §0 P4(«나가면 아무것도 안 남는다»)가
 * 통째로 거짓이 된다.
 *
 * ⚠️ Codex 때 sqlite 를 안 건드린 것과 **다르다** — 그건 남의 스키마 **안**
 * 이었고 이건 **파일 통째**다.
 *
 * 그리고 **세션 id 는 저쪽이 준 값**이다. 경로에 꽂기 전에 봐야 한다 —
 * 그게 이 파일에서 제일 중요한 검사다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { AcpConnection } from "../src/core/acpConnection.js";
import { purgeOnce, sweepBacklog } from "../src/core/purgeBacklog.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { AgentDef } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

/** 그 세션이 남긴 꼴을 흉내낸다 — 폴더 하나와 sqlite 넷 */
async function plant(home: string, id: string): Promise<void> {
  await fs.mkdir(path.join(home, "brain", id, ".system_generated", "logs"), { recursive: true });
  await fs.writeFile(
    path.join(home, "brain", id, ".system_generated", "logs", "transcript.jsonl"),
    `{"text":"내 비밀 암호는 «라벤더 스물셋»"}`, "utf8",
  );
  await fs.mkdir(path.join(home, "conversations"), { recursive: true });
  for (const ext of [".db", ".db-shm", ".db-wal", ".meta"]) {
    await fs.writeFile(path.join(home, "conversations", id + ext), "x", "utf8");
  }
}

const left = async (home: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, at: string): Promise<void> => {
    let names;
    try { names = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const rel = at ? `${at}/${n.name}` : n.name;
      if (n.isDirectory()) await walk(path.join(dir, n.name), rel);
      else out.push(rel);
    }
  };
  await walk(home, "");
  return out.sort();
};

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-purge-"));
  const home = path.join(dir, "home");
  const logs: string[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: (m) => { logs.push(m); }, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const agent: AgentDef = {
    ...DEFAULT_AGENTS[0]!, id: "agy", label: "가짜 Antigravity",
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    purgeFiles: {
      home,
      paths: [
        "brain/{id}",
        "conversations/{id}.db",
        "conversations/{id}.db-shm",
        "conversations/{id}.db-wal",
        "conversations/{id}.meta",
      ],
    },
  };
  const conn = new AcpConnection(agent, host, () => {}, () => {}, async () => ({ outcome: "cancelled" }));
  const inner = conn as unknown as { purgeFiles(id: string): void };

  console.log(`${NL}[★ 다섯을 다 지운다]`);
  {
    await plant(home, "sess-1");
    ok((await left(home)).length === 5, `심어뒀다 (${(await left(home)).length}개)`);
    inner.purgeFiles("sess-1");
    const rest = await left(home);
    console.log(`   남은 것: ${JSON.stringify(rest)}`);
    ok(rest.length === 0, "★ **하나도 안 남는다** — 대화 전문이 평문으로 쌓이던 자리다");
  }

  console.log(`${NL}[★ 남의 세션은 안 건드린다]`);
  {
    await plant(home, "mine");
    await plant(home, "yours");
    inner.purgeFiles("mine");
    const rest = await left(home);
    ok(rest.every((f) => f.includes("yours")), `★ 그 세션만 (${rest.length}개 남음)`);
    ok(rest.length === 5, "★ 남의 것은 그대로 다섯");
    await fs.rm(home, { recursive: true, force: true });
  }

  console.log(`${NL}[★ 세션 id 로 홈 밖을 못 나간다]`);
  {
    /*
     * 🔴 **세션 id 는 저쪽이 준 값이다.** `..` 나 구분자가 섞이면 홈 밖을
     * 지우게 된다 — 쓰는 쪽이 우리라고 안전한 것이 아니다.
     */
    const outside = path.join(dir, "건드리면-안-되는-것.txt");
    await fs.writeFile(outside, "소중한 것", "utf8");
    await plant(home, "ok-1");

    for (const bad of ["../..", "..\\..", "a/../../b", "sess 1", ""]) {
      logs.length = 0;
      inner.purgeFiles(bad);
      ok(logs.some((l) => l.includes("낯설어")),
         `★ «${bad}» 는 거절하고 **말해준다**`);
    }
    ok((await fs.readFile(outside, "utf8")) === "소중한 것",
       "★ **홈 밖은 그대로다**");
    ok((await left(home)).length === 5, "★ 멀쩡한 세션도 그대로다");
  }

  console.log(`${NL}[★ 하나도 못 찾으면 말한다 — 자리가 바뀌었을 수 있다]`);
  {
    /*
     * 🔴 문서에 없는 내부 구조라, 저쪽이 자리를 옮기면 **조용히 안 지우게
     * 된다.** 사용자는 몇 달 뒤 디스크가 차고 나서 알게 된다.
     */
    logs.length = 0;
    // 진짜 세션 id 는 UUID 꼴이다 — 굴자만 맞고 **없는** 것을 부른다
    inner.purgeFiles("deadbeef-0000-0000-0000-000000000000");
    console.log(`   ${logs.join(" / ")}`);
    ok(logs.some((l) => l.includes("하나도 못 찾았습니다")),
       "★ **조용히 안 넘어간다**");
  }

  console.log(`${NL}[★ 잠겨서 못 지운 것 — 밀린 목록으로 간다]`);
  {
    /*
     * 🔴 방을 나가는 그 순간에는 **저쪽 프로세스가 아직 들고 있다** — 재봤더니
     * `close` 뒤에도, 우리가 내린 뒤에도 `EPERM` 이었다. 까닭은 알고 있던
     * 것이다: **Antigravity 의 파이썬 서버는 안 끝난다**(`sweepStrays`).
     *
     * 여기서는 **진짜로 손잡이를 열어** 같은 상황을 만든다 — 흉내가 아니라
     * 같은 고장이어야 «밀린 목록으로 가는가» 를 잴 수 있다.
     */
    await plant(home, "locked");
    /*
     * ⚠️ **진짜로 막히는 모양을 써야 한다.** 파일을 열어두는 것으로는 안
     * 막힌다 — Node 는 «삭제 공유» 로 열어서 열려 있어도 지워진다(재봤다).
     * **현재 작업 폴더로 잡힌 폴더**는 Windows 가 진짜로 거절한다.
     */
    const lockMe = path.join(home, "brain", "locked");
    const was = process.cwd();
    process.chdir(lockMe);
    const got = purgeOnce(agent, "locked", (m) => logs.push(m));
    console.log(`   지운 ${got.wiped}개 · 못 지운 ${got.left}개`);
    ok(got.left > 0, "★ **못 지운 것이 세어진다** — 이게 밀린 목록으로 간다");
    ok(got.wiped > 0, "★ 되는 것은 그래도 지운다 — 하나 막혔다고 다 멈추지 않는다");
    process.chdir(was);

    // 놓으면 그 다음엔 지워진다 — 다음에 켤 때가 그 순간이다
    const again = purgeOnce(agent, "locked", () => {});
    ok(again.left === 0, "★ **놓으면 지워진다** — 그래서 다음에 켤 때 치우면 된다");
    await fs.rm(home, { recursive: true, force: true });
  }

  console.log(`${NL}[★ 밀린 목록을 치운다]`);
  {
    await plant(home, "later-1");
    await plant(home, "later-2");
    const backlog = [
      { agentId: "agy", sessionId: "later-1", at: Date.now() },
      { agentId: "agy", sessionId: "later-2", at: Date.now() },
    ];
    const { done, keep } = sweepBacklog(backlog, [agent], (m) => logs.push(m));
    ok(done === 2, `★ 둘 다 치웠다 (${done})`);
    ok(keep.length === 0, "★ 목록이 빈다 — 다음에 또 안 훑는다");
    ok((await left(home)).length === 0, "★ 파일도 없다");
  }

  console.log(`${NL}[★ 아직 잠겨 있으면 들고 있는다]`);
  {
    await plant(home, "still");
    const was = process.cwd();
    process.chdir(path.join(home, "brain", "still"));
    const { done, keep } = sweepBacklog(
      [{ agentId: "agy", sessionId: "still", at: Date.now() }], [agent], () => {},
    );
    ok(done === 0 && keep.length === 1, "★ **다음에 또 해본다** — 한 번 실패했다고 버리지 않는다");
    process.chdir(was);
    await fs.rm(home, { recursive: true, force: true });
  }

  console.log(`${NL}[★ 모르는 에이전트는 들고 있지 않는다]`);
  {
    const { done, keep } = sweepBacklog(
      [{ agentId: "없어진-에이전트", sessionId: "x", at: Date.now() }], [agent], () => {},
    );
    ok(done === 0 && keep.length === 0,
       "★ **버린다** — 지울 길을 모르는 것을 영영 들고 있을 이유가 없다");
  }

  console.log(`${NL}[★ 오래 밀린 것은 — 말하고 포기한다]`);
  {
    /*
     * 🔴 **조용히 버리면 안 된다.** 사용자는 **남아 있는 줄도 모른다** —
     * 지웠다고 믿은 대화가 디스크에 그대로다.
     */
    await plant(home, "ancient");
    const was = process.cwd();
    process.chdir(path.join(home, "brain", "ancient"));
    logs.length = 0;
    const { keep } = sweepBacklog(
      [{ agentId: "agy", sessionId: "ancient", at: Date.now() - 40 * 24 * 3600 * 1000 }],
      [agent], (m) => logs.push(m),
    );
    console.log(`   ${logs.join(" / ")}`);
    ok(keep.length === 0, "★ 더 안 들고 있는다 — 켤 때마다 헛일하면 안 된다");
    ok(logs.some((l) => l.includes("손으로")),
       "★ **손으로 치우라고 말한다** — 조용히 버리면 남아 있는 줄도 모른다");
    process.chdir(was);
    await fs.rm(home, { recursive: true, force: true });
  }

  console.log(`${NL}[★ 안 적은 에이전트는 아무것도 안 한다]`);
  {
    const plain: AgentDef = { ...agent, id: "plain" };
    delete plain.purgeFiles;
    const c2 = new AcpConnection(plain, host, () => {}, () => {}, async () => ({ outcome: "cancelled" }));
    const i2 = c2 as unknown as { purgeFiles(id: string): void };
    logs.length = 0;
    i2.purgeFiles("sess-1");
    ok(logs.length === 0, "★ 말도 안 하고 지우지도 않는다 — 적은 것만 한다");
    c2.dispose();
  }

  conn.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
