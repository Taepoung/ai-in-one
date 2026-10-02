import * as path from "node:path";
import type { AgentDef } from "./types.js";

/** 품은 `claude.exe` — `.bin` 에 안 나오므로 꺼리 안을 찾는다. 플랫폼마다 이름이 다르다 */
const CLAUDE_EXE = "node_modules/@anthropic-ai/claude-agent-sdk-*/claude*";

/**
 * 기본 에이전트 목록.
 *
 * 전부 사용자 기기에서 **공식 CLI를 그대로** 실행한다. 인증은 각 CLI가
 * 사용자 계정으로 처리하므로 우리는 토큰을 만지지 않는다 — 이게 구독을
 * 그대로 쓰면서 ToS를 지키는 유일한 경로다.
 *
 * CLI 플래그는 도구 버전에 따라 바뀐다. `aiInOne.agents` 설정으로 덮어쓸 수 있다.
 */
/**
 * ★ **Codex 쪽 핀 — 어댑터와 엔진을 한 자리에서** (2026-10-01).
 *
 * 사용자 물음: *"codex는 핀을 못박아? 범위로만 박을 수 있어?"*
 *
 * 박을 수 있다. 어댑터만 지명하면 엔진은 저쪽 package.json 의 `^0.159.1`
 * 을 따라 움직이지만, **엔진도 같이 지명하면 그걸 쓴다.** npm 이 둘을
 * 호이스팅해 한 본만 두고, 어댑터의 범위는 그 한 본으로 충족된다.
 * 중첩된 복사본이 안 생기는 것까지 확인했다.
 *
 * ```
 * 지명 안 함                     0.159.3 이기도 0.159.2 이기도 했다
 * -p @openai/codex@0.159.2    그걸 쓴다 (일부러 낮춰서 확인)
 * ```
 *
 * 첫 줄이 글이 아니라 **이 기계에 실물로 있었다** — 같은 2.1.0 을 받아둔
 * 자리 둘의 엔진이 각각 0.159.2 와 0.159.3 이었다.
 *
 * ⚠️ **둘은 반드시 같은 줄에서 나와야 한다.** npx 는 «지명한 글자열»
 * 로 받아둔 자리를 가른다. 한 글자라도 다르면 **다른 자리를 새로 만들고**,
 * 그건 방을 나가는 도중에 445MB 를 받는다는 뜻이다. 그래서 상수로 두었다.
 *
 * 자리당 **445MB** 이고 조합마다 새로 쌓인다. 핀을 올리면 옆에 하나 더
 * 생긴다 — 없애려면 `~/AppData/Local/npm-cache/_npx` 의 낡은 자리를 지운다.
 */
const CODEX_PIN = [
  "-p", "@agentclientprotocol/codex-acp@2.1.0",
  "-p", "@openai/codex@0.159.3",
];

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
     * 7. npx tsx tests/probes/codexdelete.mts  ← **세션 뒷정리**
     * ```
     *
     * 7번은 이 핀과 상관이 없어 보이지만 **그래서** 같이 볼 일이다. 나갈 때 도는
     * 뒷정리는 ACP 가 아니라 **사용자 기계에 깔린 `codex` CLI** 라 핀 밖에서
     * 아무 때나 바뀜고, 깨져도 나가기를 안 막으므로 **볼 일을 정해두지 않으면
     * 아무도 모른다.** 핀을 올리는 날이 정해진 유일한 «다 같이 보는 날» 이라
     * 여기 붙였다. 자세한 건 `docs/PIN.md` §F.
     *
     * ⚠️ tarball 이 실제로 받아지는지 확인할 것 — 레지스트리에 «있다»는 것과
     * «받아진다»는 것은 다르다. `sweep` 을 돌렸으면 이미 받아본 것이다.
     * ─────────────────────────────────────────────────────────────
     *
     * 0.81.2 → 0.84.0 (2026-09-29). 위 순서를 다 밟았다. probe 21개 판정
     * 차이 0, 세션·맥락·되돌리기 다 살아 있다. Sonnet 방만 모델이 올라간다.
     */
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.84.0"],
    install: "Node 20+ 가 필요합니다. 그리고 Claude Code 로 한 번 로그인해 두셔야 합니다 — 어댑터는 우리가 받지만 **로그인 자리는 사용자 것**입니다. CLI 판은 안 맞춰도 됩니다.",
    /*
     * ★ **우리 자리에 받아둔다** (2026-10-01) — `docs/INSTALL.md`.
     *
     * `exeEnv` 가 없다. Claude 어댑터는 내버려두면 **제가 품은 exe** 를
     * 쓰므로 건드릴 일이 없다. Codex 는 그렇지 않다(아래).
     *
     * 로그인은 `find` 로 찾아 터미널에 띄운다. 🔴 `.bin` 에 `claude` 가
     * **안 나온다** — `claude-agent-acp`·`anthropic-ai-sdk`·`node-which` 뿐이라
     * 꺼리 안에 놓인 exe 를 직접 찾는 수밖에 없다. 플랫폼별로 꺼리 이름이
     * 갈리므로(`-win32-x64` · `-darwin-arm64` …) `*` 로 두고 받은 것을 찾는다.
     */
    pkg: {
      spec: "@agentclientprotocol/claude-agent-acp@0.84.0",
      bin: "claude-agent-acp",
      auth: {
        file: path.join(".claude", ".credentials.json"),
        login: { find: CLAUDE_EXE, args: ["auth", "login"] },
        logout: { find: CLAUDE_EXE, args: ["auth", "logout"] },
      },
    },
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    command: npx(),
    /*
     * 🔴 **여기도 핀을 박는다** (2026-10-01).
     *
     * Claude 쪽은 데고 나서 박았는데(위 주석) 이쪽은 `latest` 로 두고
     * 있었다. 같은 위험을 한쪽에만 치우고 있었던 것이다 — 이 어댑터도
     * **65판을 냈고 하루에 여러 판을 낸 날이 있다**(2026-10-01 에만 셋).
     *
     * 2.1.0 은 **오늘 나왔고 `latest` 가 그것**이다. 즉 박아도 사용자가 지금
     * 받는 것과 같다 — 뒤로 물리는 게 아니라 **지금을 고정하는** 것이다.
     * tarball 은 받아봤다(200, 269KB) — «레지스트리에 있다» 와 «받아진다»
     * 는 다르다(`docs/PIN.md` §D1).
     *
     * ⚠️ **이 핀은 모델까지 고정하진 않는다.** Claude 쪽과 다른 점이다:
     *
     * ```
     * claude-agent-acp  "@anthropic-ai/claude-agent-sdk": "0.3.284"   ← 못
     * codex-acp         "@openai/codex":                  "^0.159.1"  ← 범위
     * ```
     *
     * 엔진이 범위라 `npx -y` 는 **받을 때마다 0.159.x 안에서 고른다.**
     * 그래서 여기서 얻는 것은 «어댑터가 안 움직임» 이지 «모델이 안 움직임»
     * 이 아니다. 반대로 어댑터가 범위를 올리면(`^0.160`) 그건 우리가 이
     * 줄을 올려야 따라온다.
     *
     * 올릴 때는 Claude 와 같은 순서이고, **`codexdelete.mts` 를 꼭 돌린다**
     * — 나가기 뒷정리가 저쪽 CLI 에 달려 있어서다(`docs/PIN.md` §F).
     */
    args: ["-y", ...CODEX_PIN, "codex-acp"],
    install: "Node 20+ 만 있으면 됩니다. CLI 를 안 깔았으면 터미널에서 `npx @openai/codex login` 으로 로그인하세요 (설치 불필요).",
    /*
     * ★ **우리 자리에 받아둔다** (2026-10-01) — `docs/INSTALL.md`.
     *
     * 🔴 **`exeEnv` 가 빠지면 조용히 딸 판이 돈다.** 어댑터 안은 이렇다:
     *
     * ```js
     * const codexPath = process.env["CODEX_PATH"] ?? "codex";
     * ```
     *
     * 기본값이 **PATH 의 `codex`** 다. 지금까지 핀 판이 돌았던 것은 `npx` 가
     * 제 `.bin` 을 PATH 앞에 끼워줬기 때문이고, 우리 자리에서 직접 띄우면
     * 그 도움이 없어 **사용자가 깔아둔 codex** 가 걸린다(이 기계: 0.155.0).
     * 오류도 안 나고 그냥 다른 판이 돌기 때문에 더 나쁘다.
     *
     * `overrides` 는 엔진 범위(`^0.159.1`)를 한 판으로 눌러 박는다 — npx 로는
     * `-p` 를 둘 주는 꺼미를 썼는데, 우리 `package.json` 이 생기니 정식 길이 열렸다.
     */
    pkg: {
      spec: "@agentclientprotocol/codex-acp@2.1.0",
      bin: "codex-acp",
      overrides: { "@openai/codex": "0.159.3" },
      exeEnv: { name: "CODEX_PATH", bin: "codex" },
      auth: {
        file: path.join(".codex", "auth.json"),
        /* ACP 가 `chat-gpt` 를 광고하므로 나중엔 앱 안에서. 지금은 그 CLI 로 */
        login: { bin: "codex", args: ["login"] },
        logout: { bin: "codex", args: ["logout"] },
      },
    },
    /*
     * ★ **나간 뒤 한 번 더 치운다** (2026-10-01).
     *
     * 🔴 Codex 는 세션을 **파일과 sqlite 인덱스 둘**에 두는데, ACP 의
     * `session/delete` 는 **파일만 지운다.** 그래서 방을 나갈 때마다 인덱스에
     * 붕 뜬 행이 쌓이고 확장 목록에 «열 수 없는 세션» 으로 남는다.
     *
     * `--force` 가 있어야 한다 — 없으면 «터미널이 아니라 확인을 못 받는다»
     * 며 거절한다. 사람이 아닌 것이 부를 때를 위해 둔 문이다.
     *
     * ⚠️ Claude 에는 이 줄이 없다. 거기선 **파일이 곧 목록**이라 ACP delete
     * 하나로 끝난다 — 할 일이 없는데 명령을 띄우면 느려지기만 한다.
     *
     * ⚠️ **이 줄은 핀이 안 지켜준다.** `codex` 는 사용자가 언제든 올리고,
     * `delete` 나 `--force` 가 바뀜면 그날 깨진다. 막지는 않으나 **로그는
     * 남긴다** — 종료코드만 바뀌는 고장을 예전엔 통째로 못 봤다. `docs/PIN.md` §F.
     */
    /*
     * ★ **사용자의 `codex` 가 아니라 어댑터가 품은 것을 부른다** (2026-10-01).
     *
     * 사용자 물음: *"어댑터에 있는 exe에 접근해서 cli로 지우거나 할 수는 없는건가"*.
     *
     * 된다. 그리고 **그렇게 해야 맞았다.** 예전엔 PATH 의 `codex` 를 불렀는데
     * 그건 세션을 만든 엔진과 **다른 판**이었다 — 이 기계에서 넷 판 차이:
     *
     * ```
     * 어댑터가 도는 엔진   0.159.3   ← 이게 세션을 만들었다
     * 사용자 PATH 의 codex   0.155.0   ← 그걸 지우라고 시켰다
     * ```
     *
     * 우연히 돌았을 뿐이다. 저쪽이 낡으면 `--force` 가 없고, 새로우면 저장
     * 자리가 옮겨가 엔진이 쓴 세션을 못 본다. **아예 안 깔린 사람도 있다.**
     *
     * `npx -p` 는 받아둔 꾸러미에서 **다른 명령을 골라 띄울 수 있다.** 그래서
     * 경로를 한 글자도 안 적고도 그 exe 를 부른다(재보니 1초 — 방을 나갈
     * 때는 방금 그 어댑터를 띄운 뒤라 캐시가 항상 딼뜻하다).
     *
     * ⚠️ 지명하는 글자열이 위 `args` 와 **토씨 같아야** 캐시가 같다. 그래서
     * 둘 다 `CODEX_PIN` 에서 나온다 — 손으로 적으면 언젠가 갈라진다.
     */
    purgeSession: { command: npx(), args: ["-y", ...CODEX_PIN, "codex", "delete", "--force", "{id}"] },
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
        ...(patch.env ? { env: patch.env } : {}),
      });
    }
  }

  return [...byId.values()];
}
