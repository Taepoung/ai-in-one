/**
 * **잔량 조회가 «빈손» 이 되는 자리** (사용자, 2026-10-20: *"빈손으로 왔습니다의 기준이 뭐야"*).
 *
 * 팝업의 「빈손으로 왔습니다」 는 **오류 없이 턴이 끝났는데 받은 글이 0자**일 때 떴다.
 * 그런데 턴의 응답과 그 턴의 글 조각은 **도착 순서가 보장되지 않는다**(A11 — 턴을 놓을 때
 * 1.5초 유예를 두는 까닭). `probeUsage` 는 응답이 오자마자 글을 읽고 세션을 닫아서,
 * 글이 응답보다 늦으면 **멀쩡히 온 답을 버리고** 빈손이라고 했다.
 *
 * ```
 * ok      글 → 응답            받는다 (예전에도)
 * late    응답 → 글(0.4초 뒤)  🔴 예전엔 버렸다 — 이제 조용해질 때까지 조금 더 듣는다
 * empty   응답, 글 없음        빈손이 맞다 — 그런데 **무엇이 비었는지** 말한다
 * ```
 *
 * 그리고 팝업은 에이전트 하나만 다시 받을 수 있어야 한다 — 그건 `quotaui.mjs` 가 잰다.
 * 여기서는 호스트 쪽 `quotaOf` 가 **부른 에이전트만** 묻는지를 본다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

async function make() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-quotaprobe-"));
  const store = new RoomStore(dir); await store.init();
  const logs: string[] = [];
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: (m) => logs.push(m), defaultCwd: () => dir, hasWorkspace: () => true,
  };
  // 바탕은 Claude 애드온 — `/usage` 로 묻고 Claude 꼴로 뜯는다. 가짜도 그 꼴로 답한다
  const base = { ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")] };
  const agent = (id: string, slash: string) => ({ ...base, id, label: id, env: { AIO_FAKE_SLASH: slash } });
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [agent("ok", "ok"), agent("late", "late"), agent("empty", "empty")],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});
  return { dir, mgr, logs };
}

async function main(): Promise<void> {
  const t = await make();
  const all = await t.mgr.quotaOf(["ok", "late", "empty"]);
  const of = (id: string) => all.find((q) => q.agentId === id)!;

  console.log(`${NL}[★ 글이 응답보다 먼저 — 받는다]`);
  ok((of("ok").text ?? "").includes("5-hour limit"), `★ 글이 왔다 (${of("ok").text})`);
  ok(of("ok").lines?.[0]?.left === 93, `★ 뜯었다 — 7% 썼으니 93% 남음 (${of("ok").lines?.[0]?.left})`);

  console.log(`${NL}[★ 🔴 글이 응답보다 늦게 — 버리지 않는다]`);
  ok((of("late").text ?? "").includes("5-hour limit"),
     `★ **늦게 온 글도 받는다** (${of("late").text || "빈손"} · ${of("late").why ?? ""})`);
  ok(of("late").lines?.length === 1, "★ 막대도 선다");

  console.log(`${NL}[★ 정말 글이 없으면 — 무엇이 비었는지 말한다]`);
  ok(!of("empty").text, "★ 받은 글은 없다");
  ok((of("empty").why ?? "").includes("/usage"),
     `★ **보낸 명령과 «비었다» 를 말한다** (${of("empty").why})`);
  const trace = t.logs.find((l) => l.startsWith("[empty] 잔량:")) ?? "";
  ok(/받은 것 .*commands×/.test(trace),
     `★ **출력 창에 무엇이 왔었나를 남긴다** — 다음에 뜨면 까닭이 보인다 (${trace})`);
  ok(!t.logs.some((l) => l.startsWith("[ok] 잔량:") || l.startsWith("[late] 잔량:")),
     "★ 멀쩡한 것은 안 남긴다");

  console.log(`${NL}[★ 하나만 다시 묻는다]`);
  const one = await t.mgr.quotaOf(["late"]);
  ok(one.length === 1 && one[0]!.agentId === "late", `★ 부른 에이전트만 (${one.map((q) => q.agentId).join(",")})`);

  t.mgr.dispose();
  await fs.rm(t.dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
