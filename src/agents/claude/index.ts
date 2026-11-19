/**
 * **Claude Code** — 애드온 (리팩토링 ①, 2026-10-20 · `src/agents/README.md`).
 *
 * 🔴 **`core/agent-api.ts` 말고는 core 를 import 하지 않는다.** 다른 에이전트도
 * 안 본다. 이 경계가 «이 에이전트만 올릴 때 펴는 곳이 한 폴더» 를 지킨다 —
 * 린트가 막는다(`eslint.config.mjs`).
 *
 * ⚠️ 지금은 `src/core/agentCatalog.ts` 에서 **그대로 옮긴** 정의다. 표준 ACP 와
 * 다른 버릇을 이 폴더로 모으는 일은 다음 걸음들이 한다(§5 ③~⑤).
 */
import * as path from "node:path";
import { npx, type AgentDef } from "../../core/agent-api.js";
import { parseClaudeQuota } from "./quota.js";
import { claudeMcpIdentity, claudeToolName } from "./identity.js";

/** 품은 `claude.exe` — `.bin` 에 안 나오므로 꾸러미 안을 찾는다. 플랫폼마다 이름이 다르다 */
const CLAUDE_EXE = "node_modules/@anthropic-ai/claude-agent-sdk-*/claude";

export const claude: AgentDef = {
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
   *
   * 0.90.0 → 0.108.0 (2026-11-18). probe 21개 중 갈린 셋: delsess · wakebusy 는 **좋아졌고**
   * (지운 방이 디스크에서도 사라진다 · 백그라운드 결과를 물으면 가져온다), bgnotify 는 **자**
   * 탓이다 — 첫 턴이 19초라 백그라운드(10초)가 둘째 턴 전에 끝나 알림이 올 자리가 없었다.
   * 세션·되돌리기 3/3. 🔴 0.90.0 의 `sonnet` 은 **`claude-sonnet-5`** 였다 — 또 한 세대 묶여 있었다.
   */
  args: ["-y", "@agentclientprotocol/claude-agent-acp@0.108.0"],
  /*
   * ★ **우리 자리에 받아둔다** (2026-10-01) — `src/core/install/README.md`.
   *
   * `exeEnv` 가 없다. Claude 어댑터는 내버려두면 **제가 품은 exe** 를
   * 쓰므로 건드릴 일이 없다. Codex 는 그렇지 않다(아래).
   *
   * 로그인은 `find` 로 찾아 터미널에 띄운다. 🔴 `.bin` 에 `claude` 가
   * **안 나온다** — `claude-agent-acp`·`anthropic-ai-sdk`·`node-which` 뿐이라
   * 꾸러미 안에 놓인 exe 를 직접 찾는 수밖에 없다. 플랫폼별로 꾸러미 이름이
   * 갈리므로(`-win32-x64` · `-darwin-arm64` …) `*` 로 두고 받은 것을 찾는다.
   */
  pkg: {
    spec: "@agentclientprotocol/claude-agent-acp@0.108.0",
    bin: "claude-agent-acp",
    auth: {
      file: path.join(".claude", ".credentials.json"),
      login: { find: CLAUDE_EXE, args: ["auth", "login"] },
      logout: { find: CLAUDE_EXE, args: ["auth", "logout"] },
      /*
       * 🔴 정규식에 `\s` 같은 걸 쓰면 **TS 문자열이 먼저 먹는다** —
       * 한 번 그렇게 써놓고 «계정 이름이 안 잡힌다» 로 헤맸다.
       * `auth status` 가 뜨우는 JSON 은 모양이 고정이라 그냥 글자로 찾는다.
       */
      status: { find: CLAUDE_EXE, args: ["auth", "status"], yes: '"loggedIn": true' },
    },
  },
  // ★ 잔량 — «쓴 양» 을 준다 — 뜻이 다른 둘과 반대다 (뜯기는 ./quota.ts)
  quota: { commands: ["usage"], parse: parseClaudeQuota },
  // ★ 우리 도구 알아보기 — 제 자리에서만 꺼낸다 (./identity.ts)
  mcpIdentity: claudeMcpIdentity,
  // ★ 알약에 쓸 도구 이름 — 제목은 명령 전체라 (./identity.ts)
  toolName: claudeToolName,
  /*
   * ★ **Claude in Chrome** (사용자, 2026-11-19).
   *
   * 품은 claude.exe 에 이미 들어 있다 — `--chrome` 으로 켜고, Chrome 의 «Claude» 확장과
   * 이어져 **사용자의 Chrome** 에서 탭을 열고 누르고 읽는다(도구 `mcp__claude-in-chrome__*`).
   * 어댑터는 `_meta.claudeCode.options.extraArgs` 를 claude.exe 에 그대로 넘긴다 —
   * 값 `null` 이 «값 없는 깃발» 이다. 실측(`chromeprobe` · 2026-11-19): 켜면 example.com
   * 을 열어 읽고 스크린샷까지 찍었고, 안 켜면 그 도구가 아예 없었다. 확장과 잇는 길
   * (native messaging)은 claude.exe 가 처음 켤 때 스스로 등록했다.
   */
  browser: {
    label: "Claude in Chrome",
    needs: "Chrome 에 Anthropic 의 «Claude» 확장을 깔고 같은 계정으로 로그인해야 합니다.",
    meta: { claudeCode: { options: { extraArgs: { chrome: null } } } },
  },
};
