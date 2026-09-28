/**
 * **Agent SDK 로는 도는 중에 끼어들 수 있나** — 마지막 남은 통로.
 *
 * 같은 실험을 세 번째 통로로 한다:
 *
 * ```
 * ACP 어댑터      ❌ 한 세션 안에서 줄을 섰다
 * CLI --print     ❌ 메시지마다 새 세션이었다
 * Claude Code TUI ✅ 도중에 받는다 (직접 겪음)
 * Agent SDK       ❓ ← 여기
 * ```
 *
 * ACP 어댑터가 **이 SDK 를 감싼 것**이다(`@anthropic-ai/claude-agent-sdk`).
 * 그러니 TUI 가 쓰는 길이 여기 있을 수 있다. SDK 의 `query()` 는 프롬프트로
 * **비동기 이터러블**을 받는데, 턴이 도는 중에 다음 것을 내밀면 어떻게 되나.
 *
 * 가르는 것은 **순서**다 (앞선 두 프로브가 각각 한 번씩 속은 자리):
 *
 * ```
 * 바나나가 첫 result **앞**  →  끼어들었다 — steering 이 된다
 * 바나나가 첫 result **뒤**  →  또 줄을 섰다
 * ```
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-sdk-"));
const began = Date.now();
const ms = () => String(Date.now() - began).padStart(6);
const log = [];
/** 판정용 — **안 자른** 원문. 자른 글로 판정하면 거짓이 나온다 */
const said = [];

const nap = (t) => new Promise((r) => setTimeout(r, t));

/** 첫째를 내밀고, **아직 도는 중에** 둘째를 내민다 */
async function* messages() {
  log.push(`${ms()}ms  → 내놓음: 첫째`);
  yield {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "1부터 40까지 한 줄에 하나씩, 천천히 세어줘. 숫자만." }] },
  };

  await nap(3000);
  log.push(`${ms()}ms  → 내놓음: 둘째 (첫 턴이 아직 도는 중)`);
  yield {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "그만 세고 '바나나'라고만 답해." }] },
  };

  // 둘 다 처리될 때까지 이터레이터를 안 닫는다 — 닫으면 SDK 가 끝낸다
  await nap(60000);
}

const run = query({
  prompt: messages(),
  options: { cwd, model: "sonnet", permissionMode: "bypassPermissions" },
});

for await (const m of run) {
  if (m.type === "assistant") {
    const text = (m.message?.content ?? [])
      .filter((c) => c.type === "text").map((c) => c.text).join(" ")
      .replace(/\s+/g, " ").trim();
    if (text) { said.push(text); log.push(`${ms()}ms    말: ${text.slice(0, 70)}`); }
  } else if (m.type === "result") {
    log.push(`${ms()}ms  ✓ result (${m.subtype ?? "?"}) turns=${m.num_turns ?? "?"}`);
  } else if (m.type === "system") {
    log.push(`${ms()}ms  · system/${m.subtype ?? "?"}`);
  } else {
    log.push(`${ms()}ms  · ${m.type}`);
  }
}

console.log("\n── 일어난 순서 ──────────────────────");
for (const l of log) console.log("  " + l);

console.log("\n── 결론 ──────────────────────");
const iFirstResult = log.findIndex((l) => l.includes("✓ result"));
const iBanana = log.findIndex((l) => l.includes("말:") && l.includes("바나나"));
const counted40 = said.some((t) => /\b40\b/.test(t));
const inits = log.filter((l) => l.includes("system/init")).length;

console.log(`  첫 일이 끝까지 갔나 (40까지): ${counted40 ? "예 — 안 끊겼다" : "아니오 — 끊겼다"}`);
console.log(`  system/init 횟수: ${inits}${inits > 1 ? "  ← 메시지마다 새 세션" : "  ← 한 세션"}`);
if (iBanana < 0) {
  console.log("  ❌ 바나나가 안 나왔다 — 둘째가 처리되지 않았다");
} else if (iFirstResult >= 0 && iBanana < iFirstResult) {
  console.log("  ✅ **도는 턴에 끼어들었다 — SDK 로는 steering 이 된다**");
} else if (iFirstResult < 0) {
  console.log("  ? result 가 없다 — 순서를 직접 읽어야 한다");
} else {
  console.log("  ❌ **또 줄을 섰다** — SDK 로도 안 된다");
}

try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 나중에 */ }
process.exit(0);
