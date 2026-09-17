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
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
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
  {
    id: "gemini",
    label: "Gemini",
    description: "Google Gemini CLI",
    command: npx(),
    args: ["-y", "@google/gemini-cli", "--experimental-acp"],
    color: "#4285f4",
    install: "터미널에서 `gemini` 를 실행해 설치·로그인하세요.",
  },
];

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
