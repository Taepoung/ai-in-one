import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * **봇끼리 말을 걸게 해주는 MCP 서버** (v3.0 2-F).
 *
 * ACP 에는 «다른 에이전트에게 말을 건다» 가 없다. 그래서 길을 하나 내는데,
 * 에이전트가 **이미 할 줄 아는 것**으로 낸다 — MCP 도구다. 봇은 평소처럼
 * 도구를 부르고, 그 도구가 우리 큐를 만진다.
 *
 * ★ **«띄운다»는 말이 실제보다 무겁다.** 프로세스를 띄우는 것이 아니라
 * **이미 도는 확장 호스트 안에서 포트 하나를 여는 것**이다. 창 셋이면
 * 리스너 셋, 메모리 수십 KB.
 *
 * ★ **창마다 하나인 것은 제약이 아니라 전제다.** VSCode 는 창마다 확장
 * 호스트가 따로 돌고, 창을 가로질러 하나만 띄우면 **큐가 프로세스 경계를
 * 넘는다** — 그러면 경합 규칙(꺼내기를 먼저 · 세서 쓴다 · 락 없음)이 전부
 * 무너진다. **별도 프로세스로 안 띄우는 이유가 그것이다.**
 *
 * 막는 것이 둘 겹친다:
 *
 * ```
 * 127.0.0.1   기계 **밖**을 막는다
 * 헤더 비밀    기계 **안**의 남을 막는다 — 그리고 «누가 부르나»를 알려준다
 * ```
 */

/** 봇에게 보여줄 도구 하나 */
export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema. 에이전트가 이걸 보고 인자를 만든다 */
  inputSchema: unknown;
}

/** 도구가 돌려주는 것 — MCP 의 `content` 한 덩어리 */
export interface McpResult {
  text: string;
  /** 도구가 실패했다는 표시. 모델이 그대로 읽는다 */
  isError?: boolean;
}

export interface McpServerOptions {
  log(message: string): void;
}

/**
 * 도구를 부른다.
 *
 * `owner` 는 **헤더 비밀이 가리키는 봇**이다 — 이게 있어야 «남의 큐를
 * 들여다보는 것»을 거절할 수 있다(2-H 의 소유자 검사).
 */
export type McpCall = (owner: string, tool: string, args: unknown) => Promise<McpResult>;

/** 서버가 어느 칸에 있나 — 화면이 이 값으로 «봇끼리 부르기»를 켜고 끈다 */
export type McpState =
  | { at: "off" }
  | { at: "ready"; url: string }
  /** 🔴 **왜 안 되는지 같이 준다.** 이유 없는 «안 됩니다»는 고칠 길이 없다 */
  | { at: "failed"; why: string };

/** MCP 판. 프로브로 이 값이 오가는 것을 확인했다 */
const PROTOCOL = "2025-06-18";

/** 한 임자에게 살려두는 열쇠 수 — 다시 붙는 연결이 살아남을 만큼만 */
const KEEP_KEYS = 4;

export class McpServer {
  private server?: http.Server;
  private state: McpState = { at: "off" };
  /**
   * 비밀 → 주인.
   *
   * 🔴 **세션마다 다른 값**이어야 한다. 하나로 돌려쓰면 **봇이 자기 권한
   * 요청을 스스로 승인할 수 있다** — 큐에서 남의 항목을 꺼내는 것을 막을
   * 근거가 사라진다.
   */
  private readonly owners = new Map<string, string>();
  /** 열쇠 → 그 열쇠가 매인 세션 (아직 안 매였으면 없다) */
  private readonly ties = new Map<string, string>();
  /** 임자 → 마지막으로 내준 열쇠 — `tie` 가 이걸 매다 */
  private readonly lastKey = new Map<string, string>();

  private tools: McpTool[] = [];
  private call: McpCall = async () => ({ text: "아직 아무 도구도 없습니다.", isError: true });

  constructor(private readonly opts: McpServerOptions) {}

  /**
   * **도구를 건다** — 서버가 선 뒤에 늦게 묶어도 된다.
   *
   * 🔴 서버는 **통로일 뿐**이다. 도구가 무엇인지도, 부르면 무엇을 하는지도
   * 방 매니저가 안다 — 큐도 방도 저쪽에 있다. 서로를 생성자에서 알게 하면
   * **둘이 서로를 먼저 필요로 하는 고리**가 생긴다.
   */
  setHandlers(tools: McpTool[], call: McpCall): void {
    this.tools = tools;
    this.call = call;
  }

  current(): McpState {
    return this.state;
  }

  /**
   * **묶고, 닿는지 확인하고, 준비 완료.**
   *
   * 🔴 **«묶였다» ≠ «닿는다».** 보안 소프트웨어가 루프백을 막는 일이 있다.
   * 묶이기만 한 것을 «준비 완료»로 읽으면, 봇이 도구를 부를 때가 되어서야
   * 조용히 실패한다 — 그때는 **어느 방의 어느 턴**에서 깨졌는지 알기 어렵다.
   * 그래서 **여기서 한 번 쳐본다.**
   *
   * 실패해도 **던지지 않는다** — 화면이 «봇끼리 부르기»를 비활성으로 두고
   * 이유와 [다시 시도] 를 보여주면 된다. 확장이 안 뜨는 일은 아니다.
   */
  async start(): Promise<McpState> {
    if (this.state.at === "ready") return this.state;
    try {
      const url = await this.listen();
      await this.knock(url);
      this.state = { at: "ready", url };
      this.opts.log(`MCP 서버가 섰습니다 — ${url}`);
    } catch (err) {
      this.close();
      const why = err instanceof Error ? err.message : String(err);
      this.state = { at: "failed", why };
      this.opts.log(`MCP 서버를 못 세웠습니다 — ${why}`);
    }
    return this.state;
  }

  /**
   * **비밀을 발급한다** — 세션 하나에 하나.
   *
   * 세션이 생길 때 부르고, 그 값을 `McpServerHttp.headers` 에 실어 보낸다.
   * 돌아온 도구 호출의 헤더가 그 값이면 **부른 것이 그 봇**이다.
   */
  issue(owner: string): string {
    const secret = `aio-${randomBytes(18).toString("base64url")}`;
    this.owners.set(secret, owner);
    this.lastKey.set(owner, secret);
    /*
     * ★ **같은 임자의 열쇠를 몇 개 살려둔다** (사용자, 2026-10-15).
     *
     * 🔴 사용자가 받은 것: *"The MCP server 'ai-in-one' failed to
     * initialize: … Unauthorized."* — 발급할 때마다 옆에 **옮 열쇠를
     * 거두고** 있었는데(`revoke`), Antigravity 는 **한 프로세스가 세션
     * 여럿을 품고** MCP 서버를 이름당 한 번 붙인다. 그러면 거둔 그
     * 열쇠가 **아직 살아 있는 연결의 것**이라, 방이 통째로 도구를 잃는다.
     *
     * ★ **안전은 안 물러진다.** 열쇠는 «누구인가»만 가리킨다 — 같은
     * 임자의 열쇠가 둘이어도 **할 수 있는 일은 똑같다.** 거두는 일은
     * 맵이 무한히 커지는 것을 막는 것이었고, 그건 **최근 몇 개만
     * 남기면** 같이 해결된다.
     */
    const mine = [...this.owners].filter(([, who]) => who === owner).map(([key]) => key);
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_KEYS))) {
      this.owners.delete(old);
      this.ties.delete(old);
    }
    return secret;
  }

  /**
   * **폐기한다** — 그 봇의 세션이 죽을 때.
   *
   * 안 지우면 죽은 세션의 비밀이 계속 먹힌다. 쓸 상대가 없으니 당장 해롭진
   * 않지만, **맵이 끝없이 자라고** «지금 살아 있는 것»을 셀 수 없게 된다.
   */
  /**
   * ⚠️ **다시 발급할 때는 안 부른다** (2026-10-15) — 그때 거두면 같은
   * 프로세스에서 **아직 쓰이는 열쇠**까지 죽는다(`issue` 의 주석).
   * 방을 나가거나 봇이 없어질 때처럼 **임자가 사라질 때** 부른다.
   */
  revoke(owner: string): void {
    for (const [secret, who] of [...this.owners]) {
      if (who === owner) { this.owners.delete(secret); this.ties.delete(secret); }
    }
    this.lastKey.delete(owner);
  }

  /**
   * ★ **그 임자에게 마지막으로 내준 열쇠를 이 세션에 맨다** (2026-10-15).
   *
   * 열쇠를 내줄 때는 세션 id 가 없다 — `session/new` 의 **인자로** 나가므로
   * 그 답이 와야 알 수 있다. 그래서 나중에 맨다.
   */
  tie(owner: string, sessionId: string): void {
    const secret = this.lastKey.get(owner);
    if (secret) this.ties.set(secret, sessionId);
  }

  /**
   * ★ **그 세션이 끝났다 — 거기 매인 열쇠만 거둔다** (2026-10-15).
   *
   * 🔴 임자 단위로 거두면 **같은 봇의 새 세션까지** 죽는다(그게
   * Antigravity 에서 터졌던 자리다). 세션 단위면 좌비만 골라 죽는다.
   */
  untie(sessionId: string): void {
    for (const [secret, sid] of [...this.ties]) {
      if (sid !== sessionId) continue;
      this.ties.delete(secret);
      this.owners.delete(secret);
    }
  }

  /** 지금 이 창이 들고 있는 비밀 수 — 진단용 */
  issued(): number {
    return this.owners.size;
  }

  close(): void {
    /*
     * 🔴 **살아 있는 연결을 같이 끊는다.** 에이전트 쪽 HTTP 클라이언트는
     * 보통 연결을 **재사용하려고 열어둔다**(keep-alive). `close()` 만 부르면
     * 그 연결들이 끝나기를 기다리느라 **서버가 안 닫히고**, 창을 닫는 길이
     * 거기서 멎는다.
     *
     * 검사에서 먼저 드러났다 — 닫는 도중에 프로세스가 끝나면서 libuv 가
     * 터졌다(`UV_HANDLE_CLOSING`).
     */
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.owners.clear();
    if (this.state.at === "ready") this.state = { at: "off" };
  }

  // ── 안쪽 ──────────────────────────────────────────────────────────────

  private listen(): Promise<string> {
    return new Promise((done, fail) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.on("error", fail);
      /*
       * 🔴 **둘째 인자를 빠뜨리면 `0.0.0.0` 이다** — 같은 네트워크의 남이
       * 닿고, 방화벽도 묻는다. 한 글자가 가르는 자리라 상수로 안 빼고
       * 여기 그대로 둔다.
       */
      server.listen(0, "127.0.0.1", () => {
        const at = server.address() as AddressInfo | null;
        if (!at) { fail(new Error("포트를 못 받았습니다")); return; }
        this.server = server;
        done(`http://127.0.0.1:${at.port}/mcp`);
      });
    });
  }

  /** 자기 주소로 한 번 쳐본다 — 닿아야 준비 완료다 */
  private async knock(url: string): Promise<void> {
    const probe = this.issue("__knock__");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aio-secret": probe },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
      });
      if (!res.ok) throw new Error(`자기 주소가 ${res.status} 로 답합니다`);
      await res.json();
    } catch (err) {
      throw new Error(
        `묶이긴 했는데 닿지 않습니다 (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      this.owners.delete(probe);
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    /*
     * 🔴 **비밀부터 본다.** 루프백이라도 **같은 기계의 다른 프로그램**은 닿는다.
     * 그리고 이 검사가 «누가 부르나»도 같이 정해준다 — 뒤의 소유자 검사가
     * 여기서 나온 이름 하나에 걸려 있다.
     */
    const secret = req.headers["x-aio-secret"];
    const owner = typeof secret === "string" ? this.owners.get(secret) : undefined;
    if (!owner) { res.writeHead(401).end("no"); return; }

    // 스트리밍(SSE)은 안 연다 — **서버가 먼저 말할 일이 없다**(V3 2.1 실측)
    if (req.method !== "POST") { res.writeHead(405).end("no"); return; }

    const body = await read(req);
    let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
    try {
      msg = JSON.parse(body) as typeof msg;
    } catch {
      res.writeHead(400).end("bad");
      return;
    }

    const reply = (result: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
    };

    switch (msg.method) {
      case "initialize":
        reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "ai-in-one", version: "0.1.0" },
        });
        return;

      case "tools/list":
        reply({ tools: this.tools });
        return;

      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        try {
          const out = await this.call(owner, name, msg.params?.arguments);
          reply({
            content: [{ type: "text", text: out.text }],
            ...(out.isError ? { isError: true } : {}),
          });
        } catch (err) {
          /*
           * 🔴 **터진 것도 도구 결과로 돌려준다.** JSON-RPC 오류로 보내면
           * 어댑터가 삼키는 경우가 있어 **모델이 왜 안 됐는지 영영 모른다.**
           * `isError` 면 모델이 글로 읽고 되묻거나 다른 길을 찾는다.
           */
          reply({
            content: [{
              type: "text",
              text: `도구가 실패했습니다: ${err instanceof Error ? err.message : String(err)}`,
            }],
            isError: true,
          });
        }
        return;
      }

      default:
        // 알림(id 없음)은 답할 곳이 없다
        if (msg.id === undefined) { res.writeHead(202).end(); return; }
        reply({});
    }
  }
}

function read(req: http.IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", () => done(body));
  });
}
