/**
 * ★ **원격(SSH)에서 브라우저 로그인 되돌아오기** (사용자, 2026-11-22).
 *
 * 사용자: *"안티그래비티 로그인시 127.0.0.1에서 연결을 거부했습니다. ssh연결하고서는
 * 안되는건가"*.
 *
 * 브라우저 로그인은 끝나면 `http://127.0.0.1:<포트>/…?code=…` 로 **되돌아온다** — 그
 * 포트에서 에이전트가 기다린다. 그런데 원격에서는 에이전트가 **원격 기계**에서 기다리고
 * 브라우저는 **내 PC** 에 있다. 내 PC 의 127.0.0.1 에는 아무도 없으니 «연결 거부».
 *
 * 길은 둘이다:
 *
 * ```
 * ① 포트를 미리 넘겨 둔다   asExternalUri — 같은 번호로 넘겨지면 그대로 된다
 * ② 주소를 붙여 넣는다      거부된 페이지의 주소창 주소를 받아, 원격 쪽에서 대신 연다
 * ```
 *
 * ②는 언제나 된다 — 코드가 주소에 다 들어 있고, 원격의 127.0.0.1 은 우리가 닿는 자리다.
 */
import * as http from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 로그인 주소가 되돌아올 자리 — `redirect_uri` 가 이 기계의 포트면 그 번호 */
export function loopbackPortOf(authUrl: string): number | undefined {
  let u: URL;
  try { u = new URL(authUrl); } catch { return undefined; }
  const back = u.searchParams.get("redirect_uri");
  if (!back) return undefined;
  try {
    const r = new URL(back);
    if (!LOOPBACK.has(r.hostname) || !r.port) return undefined;
    return Number(r.port);
  } catch { return undefined; }
}

/** 붙여 넣은 것이 되돌아오는 주소인가 — 아니면 왜 아닌지 */
export function checkPasted(pasted: string): string | undefined {
  let u: URL;
  try { u = new URL(pasted.trim()); } catch { return "주소가 아닙니다 — 주소창의 글을 통째로 복사해 주세요."; }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || !u.port) {
    return "«127.0.0.1:포트» 로 시작하는 주소여야 합니다 — 연결이 거부된 페이지의 주소창 주소입니다.";
  }
  return undefined;
}

/**
 * ★ **되돌아오는 주소를 여기서 대신 연다.** 이 코드는 확장 호스트에서 돈다 — 원격이면
 * 원격 기계다. 그러니 그 127.0.0.1 은 에이전트가 기다리는 바로 그 자리다.
 */
export function relayCallback(pasted: string, timeoutMs = 15_000): Promise<{ ok: boolean; say: string }> {
  const bad = checkPasted(pasted);
  if (bad) return Promise.resolve({ ok: false, say: bad });
  const u = new URL(pasted.trim());
  return new Promise((done) => {
    const req = http.get(
      // agent:false — 연결 풀을 안 쓴다. 풀에 남은 닫힌 소켓을 다시 집으면 리눅스에서
      // «socket hang up» 이 난다(CI ubuntu, 2026-11-22). 한 번 넘기는 데 풀은 필요 없다.
      { host: "127.0.0.1", port: Number(u.port), path: u.pathname + u.search, timeout: timeoutMs, agent: false },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        done(code < 400
          ? { ok: true, say: "넘겼습니다." }
          : { ok: false, say: `에이전트가 받지 않았습니다(${code}) — 로그인을 처음부터 다시 해 보세요.` });
      },
    );
    req.on("timeout", () => { req.destroy(); done({ ok: false, say: "에이전트가 답하지 않습니다." }); });
    req.on("error", (e: NodeJS.ErrnoException) => {
      // 글자가 아니라 code 로 가린다 — 같은 끊김도 OS 마다 글은 다르다
      done({ ok: false, say: e.code === "ECONNREFUSED" || e.code === "ECONNRESET"
        ? "기다리던 에이전트가 이미 내려갔습니다 — 로그인을 처음부터 다시 해 보세요."
        : String(e) });
    });
  });
}
