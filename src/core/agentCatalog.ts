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
     * `latest` 로 두었더니 어느 날 **위쪽 배포가 깨져서** 앱이 통째로 안 떴다:
     * `0.82.0` 이 레지스트리 목록에는 있는데 **tarball 이 404** 였다. 우리가
     * 고칠 수 있는 것이 하나도 없는데 사용자는 «CLI를 확인하라»는 말만 본다.
     *
     * ```
     * 0.82.0  메타데이터 O · tarball 404   ← 깨진 배포
     * 0.81.2  둘 다 O                      ← 마지막 정상
     * ```
     *
     * 뜨지 않는 앱보다 **한 발 뒤에 있는 앱**이 낫다. 올릴 때는 **일부러** 올린다.
     *
     * ⚠️ 올리기 전에 tarball 이 실제로 받아지는지 확인할 것 —
     * 레지스트리에 «있다»는 것과 «받아진다»는 것은 다르다.
     */
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"],
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
