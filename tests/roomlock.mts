/**
 * **같은 방은 한 창에서만 연다** (v3.0 2-G · 4-12-1).
 *
 * 🔴 **왜 막나.** `ensureSession` 은 「세션이 사라졌다」와 「남이 쓰는 중이다」를
 * **안 가린다** — 둘 다 «못 붙었다»로 읽고 새 세션을 열어 `bot.sessionId` 를
 * 덮는다. 그러면 **먼저 쓰던 창의 세션이 고아가 된다**: 그쪽 화면은 멀쩡해
 * 보이는데 다음 말이 엉뚱한 세션으로 가고, 옛 세션은 아무도 안 닫는다.
 *
 * 실제로 Codex 가 그대로 보여줬다 —
 * *"This Codex session is in use by another Codex client"*.
 * 🔴 **그 문구로 가리는 길은 안 쓴다** — 에이전트마다 말이 다르고 판이 올라가면
 * 또 달라진다. 우리가 아는 사실(«내가 열었다»)로 가른다.
 *
 * ★ **빠져나갈 단추를 안 둔다.** «그래도 열기» 를 주면 그 순간 고아 세션이
 * 생기고, 사용자는 **무엇이 잘못됐는지 모른 채** 두 화면이 어긋나는 것만 본다.
 * 대신 **껐다 켜면 저절로 풀린다** — 그게 막힌 사람의 출구다.
 */
import * as os from "node:os"; import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RoomLocks } from "../src/core/roomLock.js";
import { fileURLToPath } from "node:url";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-lock-"));

  console.log(`${NL}[★ 잡고 · 놓는다]`);
  {
    const a = new RoomLocks(dir, "창 1", () => {});
    ok(a.take("r1").ok, "★ 빈 자리는 잡힌다");
    ok(a.holds("r1"), "들고 있다고 말한다");
    ok(a.take("r1").ok, "★ **내 것을 또 잡아도 된다** — 방을 다시 그릴 때마다 막히면 안 된다");

    const left = await fs.readdir(dir);
    ok(left.includes("r1.open"), `★ 자국이 파일로 남는다 (${left.join(", ")})`);

    a.release("r1");
    ok(!a.holds("r1"), "놓았다");
    ok(!(await fs.readdir(dir)).includes("r1.open"), "★ 파일도 사라진다");
  }

  console.log(`${NL}[★ 산 창이 들고 있으면 막는다 — 빠져나갈 단추 없음]`);
  {
    const a = new RoomLocks(dir, "창 1", () => {});
    a.take("r2");

    // 같은 프로세스지만 **다른 창인 척** 한다 — 파일을 남의 pid 로 바꿔 쓴다
    const other = new RoomLocks(dir, "창 2", () => {});
    const got = other.take("r2");
    /*
     * 🔴 같은 pid 라 «내 것»으로 읽힌다 — 진짜 다른 창이라면 pid 가 다르다.
     * 아래 블록이 **죽은 pid** 와 **산 pid** 를 손으로 심어 둘 다 잰다.
     */
    ok(got.ok, "같은 프로세스끼리는 안 막는다 — 창이 하나라는 뜻이다");
    a.release("r2");
    other.release("r2");
  }

  console.log(`${NL}[★ 남의 pid — 살아 있으면 막고, 죽었으면 빼앗는다]`);
  {
    const locks = new RoomLocks(dir, "내 창", () => {});

    // ① **살아 있는** 남 — 이 테스트를 돌리는 부모 프로세스를 쓴다
    const livePid = process.ppid;
    await fs.writeFile(
      path.join(dir, "r3.open"),
      JSON.stringify({ pid: livePid, window: "옆 창", at: Date.now() }),
      "utf8",
    );
    const blocked = locks.take("r3");
    ok(!blocked.ok, "★ **막힌다** — 산 창이 들고 있다");
    ok(blocked.ok === false && blocked.held.window === "옆 창",
       `★ **어디서 열려 있는지 말해준다** (${blocked.ok === false ? blocked.held.window : ""})`);
    ok(!locks.holds("r3"), "못 잡았으면 들고 있다고 하지 않는다");

    /*
     * ② **죽은** 남 — 껐다 켜면 저절로 풀려야 한다. 그게 막힌 사람의 출구다.
     * 쓰이지 않을 pid 를 쓴다 (PID 1 은 OS 것이라 살아 있다).
     */
    const deadPid = 0x7ffffff0;
    await fs.writeFile(
      path.join(dir, "r4.open"),
      JSON.stringify({ pid: deadPid, window: "죽은 창", at: 1 }),
      "utf8",
    );
    ok(locks.take("r4").ok, "★ **죽은 창의 자리는 넘겨받는다** — 껐다 켜면 풀린다");
    locks.release("r4");
  }

  console.log(`${NL}[★ 깨진 파일은 «아무도 안 들고 있다»]`);
  {
    await fs.writeFile(path.join(dir, "r5.open"), "{{쓰다 만", "utf8");
    const locks = new RoomLocks(dir, "창", () => {});
    ok(locks.take("r5").ok,
       "★ **깨진 자국 때문에 방이 안 열리면 안 된다** — 락은 사고를 줄이는 것이지 조건이 아니다");
    locks.release("r5");
  }

  console.log(`${NL}[★ 내려갈 때 들고 있던 것을 다 놓는다]`);
  {
    const locks = new RoomLocks(dir, "창", () => {});
    locks.take("r6");
    locks.take("r7");
    locks.releaseAll();
    // 위에서 심어둔 «산 남의 자리»(r3)는 내 것이 아니다 — 내 것만 본다
    const left = (await fs.readdir(dir)).filter((f) => f === "r6.open" || f === "r7.open");
    ok(left.length === 0, `★ 내가 들고 있던 것은 다 놓았다 (${left.join(", ") || "없음"})`);
  }

  console.log(`${NL}[★ 남의 것은 안 지운다]`);
  {
    /*
     * 🔴 빼앗긴 뒤에 내가 놓으면 **남의 자리를 지우게 된다.** 그러면 셋째
     * 창이 들어와 **둘이 같이** 열린다 — 막으려던 바로 그 상황이다.
     */
    const locks = new RoomLocks(dir, "창", () => {});
    locks.take("r8");
    await fs.writeFile(
      path.join(dir, "r8.open"),
      JSON.stringify({ pid: process.ppid, window: "빼앗은 창", at: Date.now() }),
      "utf8",
    );
    locks.release("r8");
    ok((await fs.readdir(dir)).includes("r8.open"),
       "★ **빼앗긴 자리는 안 지운다** — 지우면 셋째 창이 들어온다");
  }

  console.log(`${NL}[★ 끝단 — 막히면 방이 안 열린다]`);
  {
    /*
     * 🔴 락 파일만 맞아서는 뜻이 없다. **방을 여는 길이 실제로 막히는가**를
     * 재야 한다 — `ensureSession` 이 「세션이 사라졌다」와 「남이 쓰는 중이다」를
     * 안 가려서, 열려버리면 **먼저 쓰던 창의 세션이 고아가 된다.**
     */
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aio-locke2e-"));
    const store = new RoomStore(home); await store.init();
    const host: WorkspaceHost = {
      readTextFile: async () => "", writeTextFile: async () => {},
      requestPermission: async () => ({ outcome: "cancelled" }),
      log: () => {}, defaultCwd: () => home, hasWorkspace: () => true,
    };
    const locks = new RoomLocks(path.join(home, "rooms"), "내 창", () => {});
    const mgr = new RoomManager({
      host, store, configProbeMs: 20000, locks,
      agents: [{
        ...DEFAULT_AGENTS[0]!, id: "fake", label: "가짜",
        command: "node", args: [path.join(here, "fakeagent.cjs")],
      }],
    });
    mgr.on("roomError", () => {}); mgr.on("notice", () => {});

    const room = await mgr.createRoom({ agentId: "fake", title: "한 창만" });
    ok((await mgr.enterRoom(room.id)).ok, "★ 빈 자리면 들어간다");

    // **산 남의 창**이 들고 있는 꼴로 바꿔 둔다
    await fs.writeFile(
      path.join(home, "rooms", `${room.id}.open`),
      JSON.stringify({ pid: process.ppid, window: "옆 폴더", at: Date.now() }),
      "utf8",
    );
    const mgr2 = new RoomManager({
      host, store, configProbeMs: 20000, agents: [],
      locks: new RoomLocks(path.join(home, "rooms"), "둘째 창", () => {}),
    });
    mgr2.on("roomError", () => {}); mgr2.on("notice", () => {});

    const blocked = await mgr2.enterRoom(room.id);
    ok(!blocked.ok, "★ **둘째 창은 막힌다**");
    ok(blocked.ok === false && blocked.why.includes("옆 폴더"),
       `★ **어디서 열려 있는지 말해준다** (${blocked.ok === false ? blocked.why : ""})`);
    ok(blocked.ok === false && blocked.why.includes("닫고"),
       "★ **무엇을 하면 되는지도** — 막기만 하면 길이 없다");

    mgr.dispose();
    mgr2.dispose();
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
