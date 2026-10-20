/**
 * ★ **창이 둘이어도 한 번만 받는다** (2026-10-14).
 *
 * 🔴 빗장이 **창 안에만** 있었다(`ChatPanel.busy`). 그런데 받아두는 자리는
 * `globalStorage` 라 **창끼리 공유**다 — 두 창에서 같은 에이전트의 [설치하기]
 * 를 누르면 **같은 폴더에 둘이 동시에 쓴다.**
 *
 * 방 자리(`roomLock.ts`)와 같은 모양으로 막는다. 여기서 재는 것은 셋이다:
 *
 * ```
 * 산 창이 들고 있으면   막는다 — 그리고 **어디서** 받는 중인지 말해준다
 * 죽은 창이 들고 있으면  빼앗는다 — 껐다 켜면 저절로 풀려야 한다
 * 풀면                 다음 사람이 잡는다
 * ```
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { holdInstall, freeInstall, ensureNode } from "../src/core/install/agentInstaller.js";

const NL = "\n";
const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

/**
 * ★ **Node 는 한 번만 받는다** (2026-10-14).
 *
 * 🔴 사용자가 밟았다 — *"코덱스랑 클로드랑 동시에 업데이트하면 permitted
 * deny가 둘중 하나에서 뜨네"*. 에이전트 자리는 저마다 빗장이 있는데
 * **Node 는 `<root>/node` 하나를 같이 쓴다.** 둘이 들어오면 한쪽이 다른
 * 쪽의 자리를 지우고, 같은 임시 이름에 쓰고, 이름 바꾸기에서 EPERM 이 난다.
 *
 * 여기서는 **받으러 가는 횟수**를 센다. 받는 것 자체(zip 을 푸는 것)는
 * `realinstall.mts` 가 진짜로 보므로, 이 검사는 **겹침만** 본다 — 해시가
 * 안 맞는 가짜 응답을 주면 파일을 건드리기 전에 끝난다.
 */
async function nodeOnce(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-node-"));
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    /* 해시가 안 맞는 몸통 — 자리를 건드리기 전에 돌아선다 */
    await new Promise((r) => setTimeout(r, 60));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;

  try {
    const said: string[] = [];
    const [a, b] = await Promise.all([
      ensureNode(root, (m) => said.push(m)),
      ensureNode(root, (m) => said.push(m)),
    ]);
    console.log(`   받으러 간 횟수 ${calls} · 답 ${String(a)}·${String(b)}`);
    ok(calls === 1, `★ **한 번만 받으러 간다** (${calls}번) — 둘이 같이 받으면 서로 지운다`);
    ok(a === false && b === false, "★ 둘 다 같은 답을 받는다 — 기다렸다가 그 결과를 쓴다");
    ok(said.some((m) => m.includes("기다립니다")),
       `★ 기다리는 쪽에 **뭘 기다리는지** 적는다 (${said.join(" / ")})`);
  } finally {
    globalThis.fetch = real;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-lock-"));
  const said: string[] = [];
  const log = (m: string) => said.push(m);

  console.log(`${NL}[★ Node 는 둘이 같이 받으려 해도 **한 번만**]`);
  await nodeOnce();

  console.log(`${NL}[★ 잡으면 남이 못 잡는다 — 그리고 어디서인지 말해준다]`);
  {
    const mine = holdInstall(dir, "내 창", log);
    ok(mine.ok, "처음은 잡힌다");

    /* 다른 창인 척 — **살아 있는** 다른 pid 로 적어둔다 */
    const other = { pid: aliveOther(), window: "옆 창", at: Date.now() };
    fs.writeFileSync(path.join(dir, ".busy"), JSON.stringify(other), "utf8");

    const again = holdInstall(dir, "내 창", log);
    ok(again.ok === false, "★ **산 창이 들고 있으면 막는다**");
    if (!again.ok) {
      ok(again.held.window === "옆 창",
         `★ **어디서인지 말해준다** (${again.held.window}) — 「다른 창에서 받는 중」 이라고 띄울 글이다`);
    }
  }

  console.log(`${NL}[★ 죽은 창의 자리는 빼앗는다 — 껐다 켜면 풀린다]`);
  {
    /*
     * 🔴 **안 빼앗으면 영영 못 받는다.** 받다가 창이 죽으면 `.busy` 가 남는데,
     * 그걸 존중하면 **그 폴더는 다시는 못 건드린다.** 방 자리와 같은 규칙이다.
     */
    fs.writeFileSync(
      path.join(dir, ".busy"),
      JSON.stringify({ pid: deadPid(), window: "죽은 창", at: Date.now() }),
      "utf8",
    );
    const taken = holdInstall(dir, "내 창", log);
    ok(taken.ok, "★ **죽은 창의 자리는 넘겨받는다**");
    ok(said.some((m) => m.includes("넘겨받습니다")),
       "★ 그리고 **출력 창에 적는다** — 조용히 빼앗지 않는다");
  }

  console.log(`${NL}[★ 풀면 다음 사람이 잡는다]`);
  {
    freeInstall(dir);
    ok(!fs.existsSync(path.join(dir, ".busy")), "★ 표시가 지워진다");
    const next = holdInstall(dir, "다음 창", log);
    ok(next.ok, "★ 다음 사람이 잡는다");
    freeInstall(dir);
  }

  console.log(`${NL}[★ 폴더가 없어도 잡힌다 — 받기 **전**에 거는 빗장이다]`);
  {
    const fresh = path.join(dir, "아직-없는-폴더");
    const got = holdInstall(fresh, "내 창", log);
    ok(got.ok && fs.existsSync(path.join(fresh, ".busy")),
       "★ **자리를 만들어서** 잡는다 — 안 그러면 받기 시작한 뒤에야 걸 수 있다");
  }

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과${NL}`);
}

/** **살아 있는** 다른 프로세스 — 우리 부모는 확실히 산다 */
function aliveOther(): number {
  return process.ppid !== process.pid ? process.ppid : 1;
}

/** 거의 확실히 **죽은** 번호 — 쓰이고 있으면 하나 더 간다 */
function deadPid(): number {
  for (let pid = 999999; pid > 900000; pid--) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as { code?: string }).code === "ESRCH") return pid;
    }
  }
  return 999999;
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
