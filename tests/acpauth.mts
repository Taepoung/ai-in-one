/**
 * **로그인을 ACP 로 한다** (2026-10-07).
 *
 * 터미널로 띄울 CLI 가 없거나, 있어도 **엉뚱한 집을 보는** 에이전트가
 * 있다. Antigravity 가 그렇다 — 사용자가 봉착했다:
 *
 * ```
 * agy (CLI)       ~/.gemini/antigravity-cli/
 * agy_acp_server  ~/.gemini/antigravity-acp/     ← 여기를 본다
 * ```
 *
 * `agy` 로 아무리 로그인해도 `session/new` 는 *"Authentication required"*
 * 로 막혔다. 저쪽이 직접 시킨 길은 ACP 의 `authenticate` 다.
 *
 * 재는 것:
 *
 * ```
 * ① 광고하는 로그인 길들을 그대로 가져온다
 * ② 고른 길로 authenticate 가 **저쪽까지 간다**
 * ③ **주소를 잡아낸다** — 답이 아니라 stderr 로 나온다
 * ④ 광고했으면 로그아웃도 거기로, 안 했으면 false
 * ```
 *
 * ③가 중요하다. 저쪽이 브라우저를 제 손으로 열지만 **원격·컨테이너처럼
 * 안 열리는 자리가 있고**, 그때 주소가 stderr 에만 있으면 사람은
 * «멈컴다» 고만 본다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-acpauth-"));
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mk = (id: string, acpAuth: boolean) => ({
    ...DEFAULT_AGENTS[0]!, id, label: id,
    command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: {
      AIO_FAKE_STATE: path.join(dir, id + ".jsonl"),
      ...(acpAuth ? { AIO_FAKE_ACP_AUTH: "1" } : {}),
    },
  });
  const mgr = new RoomManager({
    host, store, agents: [mk("withacp", true), mk("plain", false)], configProbeMs: 20000,
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  console.log("\n[★ 저쪽이 내놓는 로그인 길들]");
  {
    const ways = await mgr.authOptionsOf("withacp");
    console.log("   " + JSON.stringify(ways));
    ok(ways.length === 2, "★ 광고한 둘을 그대로 가져온다");
    ok(ways[0]!.id === "oauth-personal", "★ id 가 살아 있다 — 이걸로 골라 부른다");
    ok(ways[0]!.description === "개인 계정", "설명도 같이 — 골라 물으려면 필요하다");

    const none = await mgr.authOptionsOf("plain");
    ok(none.length === 0, "광고 안 한 쪽은 비어 있다");
  }

  console.log("\n[★ 로그인이 저쪽까지 가고, 주소를 잡아낸다]");
  {
    const saw: string[] = [];
    await mgr.authenticateAs("withacp", "oauth-personal", (line) => { saw.push(line); });
    const log = (await fs.readFile(path.join(dir, "withacp.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; methodId?: string });
    const hit = log.find((e) => e.t === "authenticate");
    console.log(`   저쪽이 받은 것: ${JSON.stringify(hit)}`);
    console.log(`   잡은 줄: ${saw.join(" | ") || "(없음)"}`);
    ok(hit !== undefined, "★ **authenticate 가 저쪽까지 간다**");
    ok(hit?.methodId === "oauth-personal", "★ 고른 길이 그대로 실린다");
    ok(saw.some((l) => l.includes("https://example.invalid")),
       "★ **주소를 잡아낸다** — 답이 아니라 stderr 로 나온다");
  }

  console.log("\n[★ 로그아웃은 광고한 쪽만]");
  {
    ok(await mgr.logOutOf("withacp") === true, "★ 광고했으면 로그아웃한다");
    ok(await mgr.logOutOf("plain") === false,
       "★ **안 했으면 false** — 안 먹는 단추를 띄우지 않기 위해 화면이 이걸 본다");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
