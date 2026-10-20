/**
 * **에이전트 목록** — 애드온을 한 줄로 세우는 자리 (리팩토링 ①, 2026-10-20).
 *
 * 각 애드온은 서로를 모른다. 셋을 아는 것은 **이 파일 하나**고, 이걸 import 하는
 * 쪽은 `vscode/` 뿐이다(core 는 못 한다 — `src/agents/README.md`).
 */
import type { AgentDef } from "../core/agent-api.js";
import { claude } from "./claude/index.js";
import { codex } from "./codex/index.js";
import { antigravity } from "./antigravity/index.js";
import { standardMcpIdentity, standardQuota } from "./standard/index.js";

/**
 * 기본 에이전트 목록.
 *
 * 전부 사용자 기기에서 **공식 CLI를 그대로** 실행한다. 인증은 각 CLI가
 * 사용자 계정으로 처리하므로 우리는 토큰을 만지지 않는다 — 이게 구독을
 * 그대로 쓰면서 ToS를 지키는 유일한 경로다.
 *
 * CLI 플래그는 도구 버전에 따라 바뀐다. `aiInOne.agents` 설정으로 덮어쓸 수 있다.
 */
export const DEFAULT_AGENTS: AgentDef[] = [claude, codex, antigravity];

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
        ...(patch.env ? { env: patch.env } : {}),
      });
    }
  }

  /*
   * ★ **비운 칸은 standard 로 채운다** (2026-10-20). 설정으로 넣은 낯선 에이전트는
   * 잔량을 뜯는 법을 모른다 — 코어가 짐작하지 않게, 짐작하는 어댑터를 여기서 끼운다.
   */
  return [...byId.values()].map((a) => ({
    ...a,
    quota: a.quota ?? standardQuota,
    mcpIdentity: a.mcpIdentity ?? standardMcpIdentity,
  }));
}
