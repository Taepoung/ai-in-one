/**
 * **봇끼리 말을 걸게 해주는 MCP 서버** (v3.0 2-F).
 *
 * 막는 것이 둘 겹친다 — 둘 다 재야 한다:
 *
 * ```
 * 127.0.0.1   기계 **밖**을 막는다     ← listen(0) 은 0.0.0.0 이다. 한 글자가 가른다
 * 헤더 비밀    기계 **안**의 남을 막는다 ← 그리고 «누가 부르나»를 알려준다
 * ```
 *
 * 🔴 비밀이 **세션마다 달라야** 하는 이유가 뒤쪽이다. 하나로 돌려쓰면
 * **봇이 자기 권한 요청을 스스로 승인할 수 있다** — 큐에서 남의 항목을
 * 꺼내는 것을 막을 근거가 사라진다(2-H 의 소유자 검사).
 *
 * 그리고 **«묶였다» ≠ «닿는다»**. 보안 소프트웨어가 루프백을 막는 일이 있고,
 * 묶이기만 한 것을 «준비 완료»로 읽으면 **봇이 도구를 부를 때가 되어서야**
 * 조용히 실패한다.
 */
import { McpServer, type McpResult } from "../src/core/mcpServer.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);

const TOOLS = [
  { name: "say", description: "말을 건다", inputSchema: { type: "object", properties: {} } },
  { name: "check_queue", description: "이번 몫을 꺼낸다", inputSchema: { type: "object", properties: {} } },
];

function make(call?: (owner: string, tool: string, args: unknown) => Promise<McpResult>) {
  const seen: Array<{ owner: string; tool: string; args: unknown }> = [];
  const server = new McpServer({ log: () => {} });
  /*
   * 도구는 **늦게 묶는다** — 서버는 통로일 뿐이고, 무엇을 하는지는
   * 방 매니저가 안다. 생성자에서 서로를 알게 하면 고리가 생긴다.
   */
  server.setHandlers(TOOLS, async (owner, tool, args) => {
    seen.push({ owner, tool, args });
    return call ? await call(owner, tool, args) : { text: `${owner} 가 ${tool} 를 불렀다` };
  });
  return { server, seen };
}

/** JSON-RPC 한 번 */
async function rpc(
  url: string, secret: string | undefined, method: string, params?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-aio-secret": secret } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 본문이 없을 수 있다 */ }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`${NL}[★ 묶고 · 닿는지 확인하고 · 준비 완료]`);
  const { server, seen } = make();
  const state = await server.start();
  ok(state.at === "ready", `★ 섰다 (${JSON.stringify(state)})`);
  const url = state.at === "ready" ? state.url : "";

  /*
   * 🔴 `listen(0)` 은 `0.0.0.0` 이라 같은 네트워크의 남이 닿는다. 한 글자
   * 빠뜨리면 **조용히 열리므로** 주소로 못을 박는다.
   */
  ok(url.startsWith("http://127.0.0.1:"), `★ **루프백에만 묶인다** (${url})`);

  console.log(`${NL}[★ 자기 주소를 쳐본 흔적이 안 남는다]`);
  ok(server.issued() === 0,
     `★ **확인용 비밀은 거둔다** (${server.issued()}개) — 안 거두면 주인 없는 열쇠가 남는다`);

  console.log(`${NL}[★ 비밀이 없으면 안 받는다]`);
  {
    const none = await rpc(url, undefined, "initialize");
    ok(none.status === 401, `★ **헤더가 없으면 401** (${none.status})`);
    // 헤더는 ASCII 만 실린다 — 한글을 넣으면 fetch 가 먼저 터진다
    const wrong = await rpc(url, "aio-nope", "initialize");
    ok(wrong.status === 401, `★ **틀린 값도 401** (${wrong.status}) — 루프백이어도 같은 기계의 남은 닿는다`);
  }

  console.log(`${NL}[★ 비밀은 세션마다 다르고, 누가 부르는지를 말해준다]`);
  {
    const a = server.issue("알파");
    const b = server.issue("베타");
    ok(a !== b, "★ **값이 다르다** — 같으면 누가 불렀는지 못 가른다");

    await rpc(url, a, "tools/call", { name: "say", arguments: { to: "베타" } });
    await rpc(url, b, "tools/call", { name: "check_queue", arguments: {} });
    console.log(`   본 것: ${JSON.stringify(seen)}`);
    ok(seen[0]?.owner === "알파" && seen[0].tool === "say", "★ 알파의 호출은 알파 것으로");
    ok(seen[1]?.owner === "베타", "★ 베타의 호출은 베타 것으로 — 이게 소유자 검사의 뿌리다");
    ok(JSON.stringify(seen[0]?.args) === JSON.stringify({ to: "베타" }), "★ 인자도 그대로 간다");
  }

  console.log(`${NL}[★ 폐기하면 그 열쇠는 안 먹는다]`);
  {
    const dead = server.issue("감마");
    ok((await rpc(url, dead, "initialize")).status === 200, "발급 직후엔 먹는다");
    server.revoke("감마");
    ok((await rpc(url, dead, "initialize")).status === 401,
       "★ **폐기하면 막힌다** — 죽은 세션의 열쇠가 계속 먹으면 안 된다");
  }

  console.log(`${NL}[🔴 다시 발급해도 **앞 열쇠가 살아있다** (사용자, 2026-10-15)]`);
  {
    /*
     * 사용자가 받은 것: *"The MCP server 'ai-in-one' failed to initialize:
     * … Unauthorized."* — Antigravity 는 **한 프로세스가 세션 여럿을 품고**
     * MCP 서버를 이름당 한 번 붙인다. 새 세션을 여느라 열쇠를 바꿔 끼우면
     * **아직 쓰이는 붙임**이 통째로 도구를 잃었다.
     *
     * ★ 안전은 안 물러진다 — 열쇠는 «누구인가»만 가리키므로 같은 임자의
     * 열쇠가 둘이어도 할 수 있는 일은 똑같다. 좌비는 **최근 몇 개만** 남겨 막는다.
     */
    const first = server.issue("덱타");
    const second = server.issue("덱타");
    ok((await rpc(url, second, "initialize")).status === 200, "새 열쇠는 당연히 먹는다");
    ok((await rpc(url, first, "initialize")).status === 200,
       "★ **앞 열쇠도 그대로 먹는다** — 살아 있는 붙임을 끊지 않는다");

    /* 다만 끝없이 쌓이지는 않는다 — 최근 네 개까지다 */
    for (let i = 0; i < 5; i++) server.issue("덱타");
    ok((await rpc(url, first, "initialize")).status === 401,
       "★ **오래된 것부터 걷힌다** — 맵이 무한히 커지면 안 된다");
    server.revoke("덱타");
  }

  console.log(`${NL}[★ 세션이 바뀜면 **그 세션 열쇠만** 거둔다 (2026-10-15)]`);
  {
    /*
     * 임자 단위로 거두면 **같은 봇의 새 세션까지** 죽는다 — 그게
     * Antigravity 가 *"Unauthorized"* 를 뱉던 자리다. 세션 단위면 **좌비만**
     * 골라 죽고, 살아 있는 붙임은 그대로 둔다.
     */
    const oldKey = server.issue("엡스");
    server.tie("엡스", "sess-1");
    const newKey = server.issue("엡스");
    server.tie("엡스", "sess-2");

    server.untie("sess-1");
    ok((await rpc(url, oldKey, "initialize")).status === 401,
       "★ **끝난 세션의 열쇠는 죽는다** — 좌비가 그 봇으로 말할 수 없게");
    ok((await rpc(url, newKey, "initialize")).status === 200,
       "★ **살아 있는 세션은 멀줦하다** — 같은 봇이라고 같이 죽이지 않는다");
    server.revoke("엡스");
  }

  console.log(`${NL}[★ 할 줄 아는 말 셋]`);
  {
    const key = server.issue("알파");
    const init = await rpc(url, key, "initialize");
    ok((init.body?.["result"] as { serverInfo?: { name?: string } })?.serverInfo?.name === "ai-in-one",
       "★ initialize — 우리 이름을 댄다. **자동 승인이 이 이름에 걸려 있다**");

    const list = await rpc(url, key, "tools/list");
    const names = ((list.body?.["result"] as { tools?: Array<{ name: string }> })?.tools ?? [])
      .map((t) => t.name);
    ok(names.join() === "say,check_queue", `★ tools/list — 도구를 보여준다 (${names.join(" · ")})`);
  }

  console.log(`${NL}[★ 도구가 터져도 «도구 결과»로 돌려준다]`);
  {
    const boom = make(async () => { throw new Error("감자가 없습니다"); });
    const st = await boom.server.start();
    const u = st.at === "ready" ? st.url : "";
    const key = boom.server.issue("알파");
    const out = await rpc(u, key, "tools/call", { name: "say", arguments: {} });
    const result = out.body?.["result"] as { isError?: boolean; content?: Array<{ text: string }> };
    /*
     * 🔴 JSON-RPC 오류로 보내면 어댑터가 삼키는 경우가 있어 **모델이 왜 안
     * 됐는지 영영 모른다.** 글로 주면 되묻거나 다른 길을 찾는다.
     */
    ok(out.status === 200 && result?.isError === true,
       `★ **오류가 아니라 결과다** (${JSON.stringify(result?.isError)})`);
    ok((result?.content?.[0]?.text ?? "").includes("감자가 없습니다"),
       `★ 이유도 그대로 (${result?.content?.[0]?.text})`);
    boom.server.close();
  }

  console.log(`${NL}[★ 내리면 다 거둔다]`);
  {
    server.issue("델타");
    server.close();
    ok(server.issued() === 0, "★ 열쇠를 다 거둔다");
    ok(server.current().at === "off", `★ 칸도 내려간다 (${server.current().at})`);
  }

  console.log(`${NL}전부 통과`);
}

/*
 * 닫는 도중에 나가면 libuv 가 터진다(Windows) — 한 바퀴 두고 나간다.
 * 서버를 다 닫았으면 루프가 비어 **그냥 끝나기도 한다.**
 */
main()
  .then(() => new Promise((r) => setTimeout(r, 50)))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
