/**
 * **심사는 줄을 선다 — 끼어들지 않고, 보이고, 가로챌 수 있다** (§4.2.2 · §4.3).
 *
 * 심사 봇의 세션은 하나라 직렬이다(B1). 그 봇이 자기 일을 하는 중이면 심사는
 * 기다려야 한다 — **끊은 일은 자동으로 다시 이어지지 않기** 때문이다.
 *
 * 🔴 한때 «바쁘면 사람에게»로 막았다. 그건 **급할 때마다 위임이 꺼지는** 것이라
 * 맡긴 보람이 없다. 기다리되, **기다리는 동안 요청한 봇의 턴은 얼어 있으므로**
 * 보이게 하고 빠져나올 길을 준다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { PermissionRequest, PermissionDecision, ReviewWait } from "../src/core/types.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

const REQ = (title = "파일 고치기"): PermissionRequest => ({
  title, readOnly: false, kind: "edit", paths: ["src/a.ts"],
  options: [
    { optionId: "y", name: "이번만 허용", kind: "allow_once" },
    { optionId: "n", name: "이번만 거절", kind: "reject_once" },
  ],
});

async function make(hold: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-jq-"));
  const store = new RoomStore(dir); await store.init();
  let askedUser = 0;
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => { askedUser++; return { outcome: "cancelled" }; },
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파", env: {} },
      { ...base, id: "beta", label: "베타",
        env: { AIO_FAKE_SAY: "ALLOW" + NL + "ok", AIO_FAKE_HOLD: String(hold) } },
      { ...base, id: "gamma", label: "감마", env: {} },
    ],
  });
  const seen: ReviewWait[][] = [];
  mgr.on("roomError", () => {});
  mgr.on("notice", () => {});
  mgr.on("reviews", (_id: string, list: ReviewWait[]) => { seen.push(list); });

  const inner = mgr as unknown as {
    askApprover(sessionId: string, req: PermissionRequest): Promise<PermissionDecision>;
  };
  const room = await mgr.createRoom({
    title: "줄", bots: [{ agentId: "alpha" }, { agentId: "beta" }, { agentId: "gamma" }],
  });
  const settle = async () => {
    for (let i = 0; i < 800; i++) {
      if (["idle", "error"].includes(mgr.statusOf(room.id))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { dir, mgr, room, inner, seen, settle,
           asker: room.participants[0]!, judge: room.participants[1]!,
           other: room.participants[2]!, userAsks: () => askedUser };
}

async function main(): Promise<void> {
  const dirs: string[] = [];

  console.log(`${NL}[★ 하던 일이 끝나기를 기다렸다가 심사한다]`);
  {
    const t = await make(1200); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const busy = t.mgr.send(t.room.id, "긴 일 좀 해줘", undefined, t.judge.id);
    await new Promise((r) => setTimeout(r, 300));
    ok(t.mgr.statusOf(t.room.id, t.judge.id) !== "idle", "심사 봇은 자기 일 하는 중");

    const out = await t.inner.askApprover(t.asker.sessionId!, REQ());
    await busy.catch(() => undefined);
    await t.settle();

    ok(out.outcome === "selected" && out.optionId === "y",
       `★ **기다렸다가 심사했다** (${JSON.stringify(out)}) — 바쁘다고 위임이 꺼지지 않는다`);
    ok(t.userAsks() === 0, "★ 사람을 안 깨웠다");

    const mine = t.room.messages.find((m) => m.text === "긴 일 좀 해줘")!;
    const reply = t.room.messages.find(
      (m) => m.role === "agent" && (m.replyToIds ?? []).includes(mine.id),
    );
    ok((reply?.text ?? "").length > 0 && !reply!.streaming,
       "★ **하던 일도 멀쩡히 끝났다** — 끊으면 자동으로 안 이어진다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 기다리는 동안 화면에 보인다]`);
  {
    const t = await make(1200); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const busy = t.mgr.send(t.room.id, "긴 일", undefined, t.judge.id);
    await new Promise((r) => setTimeout(r, 300));
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("보이나"));
    await new Promise((r) => setTimeout(r, 200));

    const now = t.mgr.reviewsIn(t.room.id);
    ok(now.length === 1, `★ 줄에 하나 (${now.length})`);
    ok(now[0]!.state === "waiting", "★ **«기다리는 중»으로 구분된다** — «물어보는 중»과 다른 화면이어야 한다");
    ok(now[0]!.askerBotId === t.asker.id && now[0]!.judgeBotId === t.judge.id,
       "★ 누가 누구를 기다리는지 적힌다");
    ok(now[0]!.title === "보이나", "무엇을 승인하려는지도");

    await pending; await busy.catch(() => undefined); await t.settle();
    ok(t.mgr.reviewsIn(t.room.id).length === 0, "★ 끝나면 줄에서 빠진다");
    ok(t.seen.some((l) => l.length === 1) && t.seen.at(-1)!.length === 0,
       "★ **바뀔 때마다 알린다** — 빈 것도 보내야 표시가 걷힌다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 사람이 가로챌 수 있다]`);
  {
    const t = await make(2000); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const busy = t.mgr.send(t.room.id, "긴 일", undefined, t.judge.id);
    await new Promise((r) => setTimeout(r, 300));
    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("가로채기"));
    await new Promise((r) => setTimeout(r, 200));

    const id = t.mgr.reviewsIn(t.room.id)[0]!.id;
    ok(t.mgr.takeOverReview(id), "★ 가로챈다");
    const out = await pending;
    ok(t.userAsks() === 1, "★ **승인 카드가 사람에게 떴다** — 기다림에서 빠져나올 길");
    ok(out.outcome === "cancelled", "사람이 답한 대로 (여기선 취소)");
    ok(t.mgr.reviewsIn(t.room.id).length === 0, "★ 줄에서도 빠진다");

    await busy.catch(() => undefined); await t.settle();
    const mine = t.room.messages.find((m) => m.text === "긴 일")!;
    const reply = t.room.messages.find(
      (m) => m.role === "agent" && (m.replyToIds ?? []).includes(mine.id),
    );
    ok((reply?.text ?? "").length > 0,
       "★ **가로채도 심사 봇이 하던 일은 안 건드린다**");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 이미 물어본 뒤에는 못 가로챈다 — 그 턴은 되돌아오지 않는다]`);
  {
    const t = await make(1500); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);

    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("이미 물어봄"));
    await new Promise((r) => setTimeout(r, 400));

    const now = t.mgr.reviewsIn(t.room.id);
    ok(now[0]?.state === "asking", `★ 이미 «물어보는 중» (${now[0]?.state})`);
    ok(t.mgr.takeOverReview(now[0]!.id) === false,
       "★ **거절한다** — 돌고 있는 턴을 끊어도 자동으로 안 이어진다");
    await pending; await t.settle();
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 둘이 쌓이면 차례로 — 둘 다 심사된다]`);
  {
    const t = await make(500); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.other.id);

    const [a, b] = await Promise.all([
      t.inner.askApprover(t.asker.sessionId!, REQ("알파 것")),
      t.inner.askApprover(t.other.sessionId!, REQ("감마 것")),
    ]);
    await t.settle();
    ok(a.outcome === "selected" && b.outcome === "selected",
       `★ **둘 다 봇이 판단했다** (${JSON.stringify([a, b])}) — 예전에는 둘째가 사람에게 떨어졌다`);
    ok(t.userAsks() === 0, "★ 사람을 한 번도 안 깨웠다");
    ok(t.mgr.reviewsIn(t.room.id).length === 0, "줄이 비었다");
    t.mgr.dispose();
  }

  console.log(`${NL}[★ 심사를 맡고 있는 봇의 요청은 사람에게 — 재귀 금지]`);
  {
    const t = await make(1500); dirs.push(t.dir);
    await t.mgr.send(t.room.id, "안녕", undefined, t.judge.id);
    await t.settle();
    // 알파가 베타에게 맡기고, 베타는 감마에게 맡긴다
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.judge.id } }, t.asker.id);
    await t.mgr.setPolicy(t.room.id, { approver: { kind: "bot", botId: t.other.id } }, t.judge.id);

    const pending = t.inner.askApprover(t.asker.sessionId!, REQ("알파 것"));
    await new Promise((r) => setTimeout(r, 400));
    // 심사 중인 베타가 스스로 권한을 요청하면
    await t.inner.askApprover(t.judge.sessionId!, REQ("베타 것"));
    ok(t.userAsks() === 1,
       "★ **사람에게 간다** — 기다려서 풀릴 일이 아니라 줄도 안 세운다");
    await pending; await t.settle();
    t.mgr.dispose();
  }

  for (const d of dirs) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(d, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
