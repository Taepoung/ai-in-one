import * as path from "node:path";
import type { AgentDef } from "./types.js";

/** 품은 `claude.exe` — `.bin` 에 안 나오므로 꾸러미 안을 찾는다. 플랫폼마다 이름이 다르다 */
const CLAUDE_EXE = "node_modules/@anthropic-ai/claude-agent-sdk-*/claude";

/**
 * 🔴 **`.bin/codex.cmd` 가 아니라 진짜 exe 를 가리킨다** (2026-10-06).
 *
 * 터미널에 띄울 때 `.cmd` 는 셌을 거쳐야 하고, 그러면 **셌마다 문법이 다르다.**
 * PowerShell 은 `"경로" 인자` 를 명령으로 안 읽고 터졌다 — 사용자가 받은 글:
 *
 * ```
 * 식 또는 문에서 예기치 않은 'logout' 토큰입니다.
 * ```
 *
 * 진짜 실행파일을 가리키면 **셌 없이 그대로 띄울 수 있어** 문법 문제가
 * 통째로 사라진다. 공백 든 경로도 따옴표를 안 붙여도 된다.
 */
const CODEX_EXE = "node_modules/@openai/codex-*/vendor/*/bin/codex";

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
 * ★ **Node 도 우리가 받는다** (2026-10-07).
 *
 * 사용자: *"노드 20은 이거 깔릴때 같이 깔리게는 못해?"*. 된다. 그리고 그래야
 * 맞다 — **CLI 를 안 깔아도 된다고 해놓고 Node 는 깔라고 하는 것**은 앞뒤가
 * 안 맞는다. VSCode 를 쓰는 사람이 다 JS 를 쓰는 것도 아니다.
 *
 * ⏪ **VSCode 가 품은 Node 를 쓰는 길도 있다.** 재봤고, 띄우는 쪽은 실제로
 * 된다(`ELECTRON_RUN_AS_NODE=1`). 그런데 **받는 쪽이 막힌다** — VSCode 는
 * npm 을 안 품는다. npm 만 따로 받으면 되나 싶었는데:
 *
 * ```
 * npm 12.x   engines = ^22.22.2 || ^24.15.0 || >=26.0.0   ← VSCode 의 22.21.1 을 거절
 * npm 11.21  engines = ^20.17.0 || >=22.9.0               ← 된다
 * ```
 *
 * **한 패치 차이로 갈린다.** 그 길로 가면 우리가 VSCode 의 Node 판에 묶이고,
 * 저쪽이 올리거나 사용자가 옛 VSCode 를 쓰면 **설치가 통째로 막힌다** —
 * 사용자가 손쓸 수 없는 고장이다. 그래서 Node 를 통째로 받아 **핀을 우리가
 * 쥔다.** npm 이 같이 온다.
 *
 * 크기는 win 34MB · linux 29MB · mac 48MB 다. Codex 445MB 옆에서 티가 안 난다.
 *
 * ⚠️ **꼴을 `.zip`·`.tar.gz` 로만 고른다.** 리눅스는 `.tar.xz` 가 더 작지만
 * 푸는 데 `xz` 가 필요하고 그건 늘 있지 않다 — 우리가 이미 가진 배선
 * (`unzip.ts` · `tar -xzf`)으로 끝나는 쪽이 낫다.
 */
export const NODE_PIN = {
  version: "24.21.0",
  at: {
    "win32-x64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip",
      sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    },
    "win32-arm64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-arm64.zip",
      sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
    },
    "darwin-x64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz",
      sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    },
    "darwin-arm64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
      sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    },
    "linux-x64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz",
      sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    },
    "linux-arm64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz",
      sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    },
  } as Record<string, { url: string; sha256: string } | undefined>,
};

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
  "-p", "@agentclientprotocol/codex-acp@2.2.2",
  "-p", "@openai/codex@0.160.1",
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
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.90.0"],
    /*
     * ★ **우리 자리에 받아둔다** (2026-10-01) — `docs/INSTALL.md`.
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
      spec: "@agentclientprotocol/claude-agent-acp@0.90.0",
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
     * `overrides` 는 엔진 범위를 **한 판으로 눌러 박는다** — npx 로는 `-p` 를
     * 둘 주는 꺼미를 썼는데, 우리 `package.json` 이 생기니 정식 길이 열렸다.
     *
     * 🔴 **범위 밖을 박으면 안 된다** (2026-10-14). 어댑터 2.2.2 는
     * `^0.160.1` 을 무는데, 0.x 의 캐럿은 **`>=0.160.1 <0.161.0`** 이다 —
     * 옛 핀(0.159.3)을 그대로 뒀으면 `overrides` 가 **저쪽이 거절할 판을
     * 억지로** 눌러 박는 꼴이었다. 지금 그 범위에 드는 것은 `0.160.1`
     * 하나뿐이라 그것으로 박는다(0.162.1 은 범위 밖이다).
     */
    pkg: {
      spec: "@agentclientprotocol/codex-acp@2.2.2",
      bin: "codex-acp",
      overrides: { "@openai/codex": "0.160.1" },
      exeEnv: { name: "CODEX_PATH", bin: "codex" },
      /* 나갈 때 세션을 지우는 명령 — **품은 그 exe** 로 부른다 */
      purge: { find: CODEX_EXE, args: ["delete", "--force", "{id}"] },
      auth: {
        file: path.join(".codex", "auth.json"),
        /* ACP 가 `chat-gpt` 를 광고하므로 나중엔 앱 안에서. 지금은 그 CLI 로 */
        login: { find: CODEX_EXE, args: ["login"] },
        logout: { find: CODEX_EXE, args: ["logout"] },
        /* 🔴 이건 stderr 로 나온다 — 읽는 쪽이 두 흘림을 다 받아야 한다 */
        /*
         * ⚠️ **`who` 를 안 적는다.** `codex login status` 는 *"Logged in using
         * ChatGPT"* 까지만 말한다 — 그건 **방법**이지 계정이 아니다.
         * 가져다 붙이면 계정을 바꿔도 같은 글자가 떠 있어 **바뀜 줄 모르게** 한다.
         */
        status: { find: CODEX_EXE, args: ["login", "status"], yes: "Logged in" },
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
  },
  {
    id: "antigravity",
    label: "Antigravity",
    description: "Google Antigravity",
    /*
     * ★ **npm 이 아니라 zip 을 받는다** (2026-10-06).
     *
     * ACP 레지스트리의 `distribution.binary` 꼴이다 — 41개 중 19개가 이쪽이고
     * Antigravity 가 그 첫 사례다. `command`·`args` 는 받은 뒤에 우리가
     * 채워 넣는다(`withInstalled`) — 받기 전엔 띄울 것이 없으므로 빈 값이다.
     *
     * ⚠️ 푸는 실행파일 이름이 플랫폼마다 다르다 — 윈도우는 `.exe`, 나머지는
     * `.par`(파이썬 묶음). 리눅스는 `--uid=` 를 더 받는다.
     *
     * 🔴 레지스트리가 **해시를 안 준다.** 받은 것이 온전한지 맞춰볼 기준이
     * 없어서, HTTPS 와 **푸는 중 크기 확인**이 지금 가진 전부다(`unzip.ts`).
     *
     * ⚠️ **로그인 명령은 안 적었다.** 어떤 길인지 안 재봤고, 지어내면
     * 엉뚱한 걸 부르게 된다(`codex-code-mode-host` 전적).
     */
    command: "",
    args: [],
    /*
     * ★ **지울 명령이 없어서 파일을 지운다** (2026-10-12 실측).
     *
     * 🔴 여덟 이름을 두드려 봤다 — `delete`·`remove`·`discard`·`end`·
     * `archive`·`conversation/delete`·`conversation/remove` 전부 없고,
     * 되는 것은 `close`·`list`·`resume` 셋뿐이다(`probes/agymethods.cjs`).
     * `agy` CLI 에도 서브커맨드가 없고 **다른 집**을 본다(§G4-2).
     *
     * 안 지우면 **대화 전문이 평문으로 남는다** — 지운 뒤에도
     * `transcript.jsonl` 에 사용자가 친 말이 그대로 있었다
     * (`probes/agydelete.cjs`).
     *
     * 세션 하나가 파일 **다섯**을 만든다 — 폴더 하나와 sqlite 넷
     * (`-shm`·`-wal` 은 sqlite 가 쓰다 남기는 짝이라 같이 지운다).
     */
    purgeFiles: {
      home: "~/.gemini/antigravity-acp",
      paths: [
        "brain/{id}",
        "conversations/{id}.db",
        "conversations/{id}.db-shm",
        "conversations/{id}.db-wal",
        "conversations/{id}.meta",
      ],
    },
    pkg: {
      /*
       * ★ **받는 것은 zip 하나다** (2026-10-07).
       *
       * ⏪ 한때는 둘이었다. ACP zip 에는 서버뿐이고 CLI 는 따로
       * 나오므로(`agy`, 190MB), Claude·Codex 처럼 **로그인은 CLI 가
       * 한다** 고 보고 같이 받았다.
       *
       * 🔴 **그 전제가 틀렸다.** `agy` 와 ACP 서버는 **서로 다른 집을
       * 본다** — `antigravity-cli/` 와 `antigravity-acp/`. 그래서 `agy` 로
       * 로그인해도 세션은 계속 막혔다(§G4-2). 로그인도 로그아웃도
       * 모델 목록도 전부 **ACP 가 한다.**
       *
       * 직접 재봤다 — `agy.exe` 를 치워놓고도 `session/new` 가 붙고
       * 모델 11개가 그대로 온다. §0 P3 도 지켜진다 — **구독을 쓰는
       * 공식 바이너리는 `agy_acp_server` 자신**이고, 그걸 사용자 기계에서
       * 그대로 돌린다. Claude·Codex 는 어댑터가 **품은 CLI 를 제 손으로
       * 띄우므로** 그쪽은 CLI 가 실행 경로 위에 있다 — 구조가 다르다.
       *
       * ```
       * 뺀 것   agy.exe                   190MB
       * 남는 것 agy_acp_server.exe         81MB   ← 띄우는 것
       *          localharness_external.exe 145MB   ← 같은 zip 에 들어 있다
       * ```
       *
       * ⚠️ `localharness_external` 은 **구글이 같은 묶음에 넣어 보내는 것**이라
       * 그대로 둔다. 무엇을 하는지 우리는 모르고, 묶음을 통째로 받는 것이
       * 원칙이다(§G4) — **받는 것과 그 안에 든 것은 우리가 고르지 않는다.**
       *
       * ⚠️ **이미 받아둔 기계에는 `agy.exe` 가 남는다.** 낡음 판단은 zip
       * 주소만 보므로 «업데이트» 가 뜨지 않는다. 다음에 핀을 올리면
       * 받기 전에 자리를 비우므로(`fetchBinary`) 저절로 사라진다. 당장
       * 비우려면 제거 → 설치하기다.
       */
      binary: {
        "win32-x64": {
          archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip",
          cmd: "agy_acp_server.exe",
        },
        "win32-arm64": {
          archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-arm64.zip",
          cmd: "agy_acp_server.exe",
        },
        "darwin-arm64": {
          archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-arm64.zip",
          cmd: "agy_acp_server.par",
        },
        "darwin-x64": {
          archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-x86_64.zip",
          cmd: "agy_acp_server.par",
        },
        "linux-x64": {
          archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip",
          cmd: "agy_acp_server.par",
          args: ["--uid="],
        },
        "linux-arm64": {
          archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-arm64.zip",
          cmd: "agy_acp_server.par",
          args: ["--uid="],
        },
      },
      auth: {
        /*
         * 🔴 **`agy` 로 로그인해도 세션은 안 붙는다** (2026-10-07).
         *
         * 사용자가 봉착했다 — *"antigravity에 로그인해도 세션이
         * 안붙고 모델도 파악 불가임"*. 재보니 **둘이 서로 다른 집을
         * 본다:**
         *
         * ```
         * agy (CLI)       ~/.gemini/antigravity-cli/
         * agy_acp_server  ~/.gemini/antigravity-acp/settings.json   status=missing
         * ```
         *
         * 그래서 `agy` 로 아무리 로그인해도 `session/new` 는
         * *"Authentication required"* 로 막혔다. 저쪽이 직접 시킨 길은
         * **ACP 의 `authenticate`** 다 — 부르면 브라우저를 열고 주소도 뿜는다.
         *
         * ⚠️ **이제 `agy` 는 로그인과 상관없다.** 190MB 를 그것 때문에
         * 받고 있었는데 그 것이 아니었다. `agy models` 가 모델 목록을
         * 내주긴 하나, 그것도 ACP 세션이 붙으면 거기서 나온다 —
         * 붙는 걸 본 뒤에 뺌지 말지 정한다.
         */
        acp: true,
        /*
         * 🔴 **집이 있는 것과 들어가 있는 것은 다르다** (2026-10-07).
         *
         * 처음엔 `antigravity-cli/settings.json` 을 봤다 — 로그아웃해도
         * 그대로 있어서 단추가 안 바뀜다. 그래서 ACP 서버의 집으로
         * 옮겼는데 **그것도 틀렸다** — 사용자가 다시 짚었다
         * (*"안티그래비티 로그아웃이 안됨"*).
         *
         * 그 집은 **서버를 띄우기만 해도 생긴다.** 시작하면서
         * `settings.json` 을 써버리므로, 로그인을 한 적이 없어도
         * «들어가 있다» 가 된다 — 그 상태로 로그아웃을 눌러봤자
         * 지울 것도 없으니 **아무 일도 안 일어난다.**
         *
         * 진짜 자격은 여기다. 로그아웃이 지우는 것도 바로 이것이다:
         *
         * ```
         * credential_store.py: Cleared credential file at
         *   C:/Users/.../.gemini/antigravity-acp/acp_token.json
         * ```
         *
         * ⚠️ 기업 계정(`oauth-business`)은 `acp_business_token.json` 으로
         * 따로 간다. 지금은 개인 계정만 본다 — 둔 걸 본 적이 없어
         * 지어내지 않는다.
         */
        file: path.join(".gemini", "antigravity-acp", "acp_token.json"),
      },
    },
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
