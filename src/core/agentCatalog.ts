import type { AgentDef } from "./types.js";

/**
 * 기본 에이전트 목록.
 *
 * 전부 사용자 기기에서 **공식 CLI를 그대로** 실행한다. 인증은 각 CLI가
 * 사용자 계정으로 처리하므로 우리는 토큰을 만지지 않는다 — 이게 구독을
 * 그대로 쓰면서 ToS를 지키는 유일한 경로다.
 *
 * CLI 플래그는 도구 버전에 따라 바뀐다. `aiInOne.agents` 설정으로 덮어쓸 수 있다.
 */
export const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "claude",
    label: "Claude",
    description: "Claude Code",
    command: npx(),
    /*
     * 🔴 **버전을 고정한다** (2026-09-28).
     *
     * `latest` 로 두었더니 어느 날 앱이 통째로 안 떴다: `0.82.0` 이 레지스트리
     * 목록에는 있는데 **tarball 이 404** 였다. 우리가 고칠 수 있는 것이 하나도
     * 없는데 사용자는 «CLI를 확인하라»는 말만 본다.
     *
     * ⏪ **«깨진 배포» 라고 적었던 것을 고친다** (2026-09-30 확인).
     *
     * 지금 그 tarball 은 **200 이다.** 즉 판이 깨진 것이 아니라 **우리가 배포
     * 직후를 때린 것**이다 — 0.82.0 은 게시 당일에 받으려 했다. 메타데이터가
     * 먼저 퍼지고 tarball 이 뒤따르는 창이 있다.
     *
     * 그래도 결론은 같다. 오히려 더 나쁘다 — **깨진 판 하나를 피하면 되는 게
     * 아니라, 아무 판이나 게시 직후에 걸릴 수 있다는 뜻**이기 때문이다. 이
     * 어댑터는 반년에 122 판을 냈고 하루에 여섯 판을 낸 날도 있다(2026-09-28).
     * `latest` 로 두면 **그 창을 사용자 기계에서 밟는다.**
     *
     * 뜨지 않는 앱보다 **한 발 뒤에 있는 앱**이 낫다. 올릴 때는 **일부러** 올린다.
     *
     * ─────────────────────────────────────────────────────────────
     * ⚠️ **이 줄은 «모델 판»이다. 묵혀두면 사용자가 옛 모델을 쓴다.**
     *
     * 2026-09-29 에 실측하고서야 알았다. 이 핀은 그냥 어댑터 번호가 아니다:
     *
     * ```
     * 이 핀  →  @anthropic-ai/claude-agent-sdk 를 못박고
     *        →  그 안에 `claude.exe` 가 통째로 들어 있고
     *        →  **모델 표가 그 바이너리 안에 박혀 있다**
     * ```
     *
     * 그래서 **사용자가 제 `claude` CLI 를 올려도 아무 소용이 없다.** 우리는
     * 그것을 안 쓴다(`tests/probes/whichcli.cjs` — 프로세스 나무로 확인).
     * 그리고 별명은 **클라이언트가 제 표로 풀어서** 보낸다
     * (`tests/probes/aliasreal.cjs`):
     *
     * ```
     * sonnet  →  0.81.2 가 보내는 것  claude-sonnet-5
     *            0.84.0 가 보내는 것  claude-sonnet-5-5
     * ```
     *
     * 즉 **이 줄을 안 올리면 사용자는 옛 모델에 묶인다.** 이름이 아니라
     * 모델이다. 가만 두는 것은 «안전하게 멈춰 있는 것» 이 아니다.
     *
     * **그러므로 주기적으로 올린다.** 새 모델 소식이 들리면, 적어도 달에 한 번.
     *
     * 올릴 때 할 일 (2026-09-29 에 실제로 밟은 순서):
     *
     * ```
     * 1. npm view @agentclientprotocol/claude-agent-acp version
     * 2. node tests/probes/sweep.mjs <지금핀>    ← **기준선 먼저**
     * 3. node tests/probes/sweep.mjs <새판>
     * 4. 둘을 맞춰본다. OK/NO 줄만 보면 절반을 놓친다 —
     *    글로만 적는 probe 가 여럿이라 **본문**도 맞춰야 한다
     * 5. node tests/probes/bumpsafe.cjs <새판>   ← 세션·되돌리기
     * 6. 이 줄을 고치고 `npm test`
     * ```
     *
     * ⚠️ tarball 이 실제로 받아지는지 확인할 것 — 레지스트리에 «있다»는 것과
     * «받아진다»는 것은 다르다. `sweep` 을 돌렸으면 이미 받아본 것이다.
     * ─────────────────────────────────────────────────────────────
     *
     * 0.81.2 → 0.84.0 (2026-09-29). 위 순서를 다 밟았다. probe 21개 판정
     * 차이 0, 세션·맥락·되돌리기 다 살아 있다. Sonnet 방만 모델이 올라간다.
     */
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.84.0"],
    color: "#d97757",
    install: "터미널에서 `claude` 를 실행해 설치·로그인하세요.",
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    command: npx(),
    args: ["-y", "@agentclientprotocol/codex-acp"],
    color: "#10a37f",
    install: "터미널에서 `codex` 를 실행해 설치·로그인하세요.",
  },
];

/**
 * **Gemini는 기본 목록에서 뺐다** (2026-09).
 *
 * CLI가 없어진 게 아니라 **구독으로 쓰는 길이 막혔다.** 개인 구글 계정
 * 로그인이 *"This client is no longer supported for Gemini Code Assist for
 * individuals"* 로 거절된다(§13.2 실측). 남은 인증은 전부 API 키다.
 *
 * 그러면 §0 P3 — *"구독을 합법적으로 쓰는 유일한 경로"* — 가 이 에이전트에서만
 * 성립하지 않는다. **«구독 그대로»라고 소개하는 목록에 키를 요구하는 것을
 * 끼워두면 그 소개가 거짓말이 된다.**
 *
 * 없앤 게 아니라 **기본에서 뺀 것**이다. 키가 있는 사람은 설정으로 되살린다:
 *
 * ```jsonc
 * "aiInOne.agents": {
 *   "gemini": {
 *     "label": "Gemini",
 *     "command": "npx",                                  // Windows는 "npx.cmd"
 *     "args": ["-y", "@google/gemini-cli", "--acp"],
 *     "env": { "GEMINI_API_KEY": "…" }
 *   }
 * }
 * ```
 *
 * ⚠️ `~/.gemini/settings.json`의 `security.auth.selectedType`도 `"gemini-api-key"`
 * 여야 한다 — `"oauth-personal"`로 남아 있으면 **키를 무시하고** 위 오류가 뜬다.
 *
 * 구글이 개인 계정 경로를 되돌리면 여기로 돌아온다.
 */

function npx(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function resolveAgents(
  overrides: Record<string, Partial<AgentDef>>,
): AgentDef[] {
  const byId = new Map(DEFAULT_AGENTS.map((a) => [a.id, { ...a }]));

  for (const [id, patch] of Object.entries(overrides ?? {})) {
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, { ...existing, ...patch, id });
    } else if (patch.command && patch.args) {
      byId.set(id, {
        id,
        label: patch.label ?? id,
        command: patch.command,
        args: patch.args,
        color: patch.color ?? "#888888",
        ...(patch.env ? { env: patch.env } : {}),
      });
    }
  }

  return [...byId.values()];
}
