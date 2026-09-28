/**
 * **시작 실패 문구가 엉뚱한 곳을 안 가리키나** (2026-09-28).
 *
 * 🔴 실제로 이렇게 떴다:
 *
 * ```
 * Claude을(를) 시작하지 못했습니다. CLI가 설치되어 있고 로그인되어 있는지 확인하세요.
 * …
 * npm error 404 Not Found - GET …/claude-agent-acp-0.82.0.tgz
 * ```
 *
 * CLI 도 로그인도 멀쩡했다. **위쪽 npm 배포가 깨져** 어댑터를 못 받은 것이다.
 * 원인을 **모르면서 하나로 단정하는** 문구는 진단을 방해한다 — 사용자는
 * 멀쩡한 CLI 를 붙들고 한참을 헤맨다.
 *
 * ★ 그래서 stderr 에 **또렷한 자국이 있을 때만** 그쪽을 가리키고, 없으면
 * «확인해 보세요»로 열어 둔다. 어느 쪽이든 stderr 원문은 아래에 그대로 붙으므로
 * **정보를 숨기는 것이 아니라 단정을 거두는 것**이다.
 */
import { startupHint } from "../src/core/acpConnection.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

console.log("\n[★ 내려받기 실패 — 이게 실제로 난 것]");
{
  const real = [
    "npm error code E404",
    "npm error 404 Not Found - GET https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-0.82.0.tgz - Not found",
  ].join("\n");
  const hint = startupHint(real);
  console.log(`   ${hint}`);
  ok(hint.includes("내려받지 못했습니다"), "★ **패키지 문제라고 말한다**");
  ok(!hint.includes("로그인"), "★ **로그인을 안 탓한다** — 멀쩡한 것을 붙들고 헤매게 된다");
}

console.log("\n[네트워크]");
{
  const hint = startupHint("getaddrinfo EAI_AGAIN registry.npmjs.org");
  console.log(`   ${hint}`);
  ok(hint.includes("네트워크"), "★ 네트워크라고 말한다");
}

console.log("\n[로그인]");
{
  const hint = startupHint("Error: Not logged in. Run `claude` to authenticate.");
  console.log(`   ${hint}`);
  ok(hint.includes("로그인"), "★ 로그인이라고 말한다");
}

console.log("\n[★ 모르면 단정하지 않는다]");
{
  /*
   * 자국이 없을 때가 제일 흔하다. 그때는 «확인해 보세요»로 **열어 둔다** —
   * 아래에 stderr 원문이 그대로 붙으므로 정보가 줄지 않는다.
   */
  for (const s of ["", "Segmentation fault", "알 수 없는 오류"]) {
    const hint = startupHint(s);
    ok(hint.includes("확인해 보세요"), `★ «${s || "(빈 stderr)"}» → 열어 둔다`);
    ok(!hint.startsWith("로그인이"), "★ 하나로 단정하지 않는다");
  }
}

console.log("\n전부 통과");
