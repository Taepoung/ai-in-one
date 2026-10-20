/**
 * **`depth_left: null` 을 모델이 «못 보낸다»로 읽나** (사용자, 2026-10-15).
 *
 * 사용자 물음: *"depth_left null 대신 inf도 괜찮나?"* 그 자리에서 제가 적은
 * 걱정이 이것이었다 — **`null` 이 거짓으로 읽혀 `0` 쯤으로 뭉개지면**, 갈 수
 * 있는데 포기한다. 그게 실제로 나는지 **재보지 않고는 모른다.**
 *
 * ```
 * depth_left: 2      «두 다리 더»   → 보내야 한다 (대조군)
 * depth_left: null   «상한이 없다»  → 보내야 한다 (재려는 것)
 * depth_left: 0      «더 못 보낸다» → 안 보내야 한다 (반대쪽 대조군)
 * ```
 *
 * 🔴 **재는 것은 모델의 «행동»이지 말이 아니다** — 「보낼 수 있다고 생각한다」
 * 같은 산문은 안 본다. `say` 를 **실제로 불렀나**만 본다(§7.9 의 흉터: 글의
 * 모양을 맞히려 들면 계속 진다).
 *
 * ⚠️ **도구 설명은 제품 것을 그대로 쓴다** — `mcpTools()` 에서 꺼낸다. 여기서
 * 베껴 적으면 **제품이 아닌 것을 재게 된다.**
 *
 * ```
 * npx tsx tests/probes/depthnull.mts          세 판을 차례로
 * npx tsx tests/probes/depthnull.mts null     한 판만
 * ```
 */
import * as http from "node:http";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { RoomManager } from "../../src/core/roomManager.js";
import { RoomStore } from "../../src/core/store.js";
import { DEFAULT_AGENTS } from "../../src/agents/index.js";
import type { WorkspaceHost } from "../../src/core/workspaceHost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { argsOf } = require_("./pinned.cjs") as { argsOf(id: string): string[] };

/** 제품이 쓰는 그 설명 그대로 가져온다 */
async function realTools(): Promise<unknown[]> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-dn-tools-"));
  const store = new RoomStore(dir);
  await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const mgr = new RoomManager({ host, store, agents: [DEFAULT_AGENTS[0]!] });
  const tools = mgr.mcpTools();
  mgr.dispose();
  await store.flush();
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return tools as unknown[];
}

/**
 * 한 판 — `depth_left` 하나를 걸고 **봇에게 보내나**를 본다.
 *
 * 🔴 **«say 를 불렀나»로 재면 안 된다** (2026-10-15, 첫 판에서 밟았다).
 * 상한에 닿은 봇은 `say(to: null)` 로 **사용자에게 돌린다** — 그게 설계대로고
 * (4-L: «더 가려면 사용자가 말을 걸어야 한다»), 그걸 «실패»로 찍으면 모델이
 * 맞게 한 것을 틀렸다고 적는 꼴이다. 가르는 것은 **받는 이**다.
 */
async function round(depthLeft: number | null, tools: unknown[]): Promise<{
  toBot: boolean; toUser: boolean; args: unknown; words: string;
}> {
  const SECRET = "aio-" + Math.random().toString(36).slice(2);
  const calls: Array<{ name?: string; arguments?: unknown }> = [];
  let pulled = false;

  const server = http.createServer((req, res) => {
    if (req.headers["x-aio-secret"] !== SECRET) { res.writeHead(401).end("no"); return; }
    if (req.method === "GET") { res.writeHead(405).end("no"); return; }
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      let m: { id?: number; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
      try { m = JSON.parse(body) as typeof m; } catch { res.writeHead(400).end("bad"); return; }
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      };
      if (m.method === "initialize") {
        return reply({
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "ai-in-one", version: "0.1.0" },
        });
      }
      if (m.method === "tools/list") return reply({ tools });
      if (m.method === "tools/call") {
        const name = m.params?.name;
        calls.push({ name, arguments: m.params?.arguments });
        if (name === "check_queue") {
          pulled = true;
          /*
           * 제품이 내보내는 봉투 그대로 — 다른 것은 **한 칸만** 바꾼다.
           * 큐에 하나 남겨두면(`queue_left: 0`) «이것 말고 없다» 가 된다.
           */
          return reply({
            content: [{
              type: "text",
              text: JSON.stringify({
                kind: "message",
                use: "say",
                item: {
                  id: "x1", from: "알파", also_got: [],
                  text: "이 숫자 좀 봐줄래? 1+1 이 2 가 맞는지 한 줄로 답해줘.",
                },
                queue_left: 0,
                depth_left: depthLeft,
              }),
            }],
          });
        }
        /*
         * 🔴 **`to: null` 에 «알파에게 갔다» 고 답하면 안 된다** — 첫 판에서
         * 그렇게 해놓고 모델이 *"사용자에게만 보이게 보냈는데 알파에게도
         * 전달됐네요"* 라고 했다. **우리가 거짓을 돌려준 것**이다.
         */
        const to = (m.params?.arguments as { to?: unknown } | undefined)?.to;
        return reply({
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, to: to ?? null, queue_left: 0 }),
          }],
        });
      }
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      return reply({});
    });
  });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-dn-"));
  const port = await new Promise<number>((ok) => {
    server.listen(0, "127.0.0.1", () => ok((server.address() as { port: number }).port));
  });
  const url = `http://127.0.0.1:${port}/mcp`;

  const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
  const proc = spawn(CMD, argsOf("claude"), { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 0, buf = "", words = "";
  const waiting = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>();
  const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n");
  const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>((ok, bad) => {
    const id = ++seq;
    waiting.set(id, { ok: ok as (v: unknown) => void, bad });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); bad(new Error("timeout " + method)); }
    }, 240000);
  });

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let at: number;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
      try { m = JSON.parse(line) as typeof m; } catch { continue; }
      if (m.id !== undefined && waiting.has(m.id)) {
        const w = waiting.get(m.id)!;
        waiting.delete(m.id);
        if (m.error) w.bad(new Error(JSON.stringify(m.error)));
        else w.ok(m.result);
      } else if (m.method === "session/update") {
        const u = (m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })?.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          words += u.content.text ?? "";
        }
      } else if (m.method === "session/request_permission") {
        // 우리 도구는 제품에서 자동 승인된다 — 여기서도 그대로 흉낸다
        const opts = (m.params as { options?: Array<{ optionId?: string; kind?: string }> })?.options ?? [];
        const pick = opts.find((o) => o.kind === "allow_once") ?? opts[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: pick?.optionId } } });
      } else if (m.id !== undefined) {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
    }
  });
  proc.stderr.resume();

  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const sess = await call("session/new", {
      cwd,
      mcpServers: [{ type: "http", name: "ai-in-one", url, headers: [{ name: "x-aio-secret", value: SECRET }] }],
    });
    /*
     * ★ **제품이 깨울 때 보내는 그 줄 그대로** — 산문을 덧붙이면 그 산문이
     * 행동을 끌어낸 것인지 `depth_left` 가 끌어낸 것인지 안 갈린다.
     */
    await call("session/prompt", {
      sessionId: (sess as { sessionId?: string }).sessionId,
      prompt: [{
        type: "text",
        text: '[ai-in-one] {"you":"베타","bots":[{"name":"알파","does":"묻고 정리한다"}],"user":{"sees":"모든 메세지"}}\n\n'
          + '[ai-in-one] {"null_id":"invalid","also_got":[],"queue_left":1,"do":"check_queue"}',
      }],
    });
  } catch (e) {
    words += `\n[오류] ${e instanceof Error ? e.message : String(e)}`;
  }

  try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 리눅스 */ }
  proc.kill();
  server.close();
  await fsp.rm(cwd, { recursive: true, force: true }).catch(() => undefined);

  const sayCall = calls.find((c) => c.name === "say");
  if (!pulled) words += "\n[전제] check_queue 를 안 불렀다 — 이 판은 못 쓴다";
  const to = (sayCall?.arguments as { to?: unknown } | undefined)?.to;
  return {
    toBot: Boolean(sayCall) && to !== null && to !== undefined,
    toUser: Boolean(sayCall) && to === null,
    args: sayCall?.arguments,
    words: words.trim(),
  };
}

const WANT = process.argv[2];
const ROUNDS: Array<{ label: string; value: number | null; expect: boolean }> = [
  { label: "2", value: 2, expect: true },
  { label: "null", value: null, expect: true },
  { label: "0", value: 0, expect: false },
].filter((r) => !WANT || r.label === WANT);

const tools = await realTools();
console.log(`\n=== depth_left 를 어떻게 읽나 · 어댑터 ${argsOf("claude").at(-1)} ===\n`);

let bad = 0;
for (const r of ROUNDS) {
  process.stdout.write(`  depth_left: ${String(r.value).padEnd(5)} … `);
  const got = await round(r.value, tools);
  const mark = got.toBot === r.expect ? "OK " : "NO ";
  if (got.toBot !== r.expect) bad++;
  const where = got.toBot ? "봇에게 보냈다" : got.toUser ? "사용자에게 돌렸다" : "아무것도 안 보냈다";
  console.log(`${mark} ${where}`
    + (got.args ? `  ${JSON.stringify(got.args).slice(0, 110)}` : ""));
  const say = got.words.replace(/\s+/g, " ").slice(0, 220);
  if (say) console.log(`        말: «${say}»`);
}

console.log(`\n=== 판정 ===`);
console.log(bad === 0
  ? "  ★ **`null` 은 «상한 없음»으로 읽힌다** — 2 와 같이 봇에게 보내고,\n"
    + "    0 에서는 사용자에게 돌린다(설계대로). **`null` 을 0 쯤으로 뭉개지 않는다.**"
  : `  🔴 어긋난 판 ${bad}개 — 위 줄을 본다`);
process.exit(0);
