/**
 * **원격(SSH)에서 브라우저 로그인이 되돌아온다** (사용자, 2026-11-22).
 *
 * 사용자: *"안티그래비티 로그인시 127.0.0.1에서 연결을 거부했습니다. ssh연결하고서는
 * 안되는건가"*. 에이전트는 원격의 127.0.0.1 에서 기다리고 브라우저는 내 PC 로
 * 되돌아간다. 거부된 페이지의 주소를 붙여 넣으면 **확장(=원격)이 대신 연다.**
 *
 * 여기서는 진짜로 기다리는 «에이전트» 를 하나 세우고 그 주소를 넘겨 본다.
 */
import * as http from "node:http";
import { checkPasted, loopbackPortOf, relayCallback } from "../src/vscode/loopback.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

async function main(): Promise<void> {
  console.log("[되돌아올 포트를 로그인 주소에서 읽는다]");
  const auth = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=" +
    encodeURIComponent("http://127.0.0.1:53682/oauth2callback") + "&scope=a";
  ok(loopbackPortOf(auth) === 53682, "redirect_uri 의 포트");
  ok(loopbackPortOf("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=" +
    encodeURIComponent("http://localhost:8085/")) === 8085, "localhost 도");
  ok(loopbackPortOf("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=" +
    encodeURIComponent("https://codeassist.google.com/authcode")) === undefined, "★ 이 기계로 안 오는 주소는 건드리지 않는다");
  ok(loopbackPortOf("아무거나") === undefined, "주소가 아니면 없다");

  console.log("\n[붙여 넣은 것을 가린다]");
  ok(checkPasted("http://127.0.0.1:53682/oauth2callback?code=abc") === undefined, "되돌아오는 주소는 받는다");
  ok(checkPasted("https://accounts.google.com/x") !== undefined, "★ 엉뚱한 주소는 안 받는다");
  ok(checkPasted("abc") !== undefined, "주소가 아니면 안 받는다");

  console.log("\n[★ 붙여 넣은 주소를 대신 열면 기다리던 쪽이 받는다]");
  let got = "";
  const agent = http.createServer((req, res) => { got = req.url ?? ""; res.end("ok"); });
  await new Promise<void>((r) => agent.listen(0, "127.0.0.1", () => r()));
  const port = (agent.address() as { port: number }).port;
  const r = await relayCallback(`  http://127.0.0.1:${port}/oauth2callback?state=s1&code=4%2Fabc  `);
  ok(r.ok, `넘겼다 (${r.say})`);
  ok(got === "/oauth2callback?state=s1&code=4%2Fabc", `★ 경로와 코드가 그대로 간다 (${got})`);
  agent.closeAllConnections();
  await new Promise((r) => agent.close(r));

  const gone = await relayCallback(`http://127.0.0.1:${port}/oauth2callback?code=x`);
  ok(!gone.ok && gone.say.includes("처음부터"), `★ 기다리던 쪽이 내려갔으면 다시 하라고 한다 (${gone.say})`);

  console.log("\n원격 로그인 — 다 통과");
}

main().catch((e) => { console.error(e); process.exit(1); });
