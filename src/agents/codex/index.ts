/**
 * **Codex** — 애드온 (리팩토링 ①, 2026-10-20 · `src/agents/README.md`).
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
import { parseCodexQuota } from "./quota.js";
import { codexMcpIdentity } from "./identity.js";

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
  "-p", "@agentclientprotocol/codex-acp@2.7.0",
  "-p", "@openai/codex@0.166.0",
];

export const codex: AgentDef = {
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
   * ★ **우리 자리에 받아둔다** (2026-10-01) — `src/core/install/README.md`.
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
   *
   * 2026-11-18: 어댑터 2.7.0 은 `^0.166.0` — 범위 안은 `0.166.0` 하나다(최신 0.169.0 은 밖).
   */
  pkg: {
    spec: "@agentclientprotocol/codex-acp@2.7.0",
    bin: "codex-acp",
    overrides: { "@openai/codex": "0.166.0" },
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
  // ★ 잔량 — /usage 가 아니라 /status — 한도가 다른 줄과 섞여 온다 (뜯기는 ./quota.ts)
  quota: { commands: ["status"], parse: parseCodexQuota },
  // ★ 우리 도구 알아보기 — 제 자리에서만 꺼낸다 (./identity.ts)
  mcpIdentity: codexMcpIdentity,
  /*
   * ★ **다른 Codex 가 그 세션을 쥐고 있다** (2026-10-20 실측 · codex-acp 2.2.2):
   *
   * ```
   * Invalid request: This Codex session is in use by another Codex client (the Codex
   * app, the CLI or an IDE extension). Close the session there or quit that client,
   * then try again. — thread 01a1…bb3790 already has an active writer
   * ```
   *
   * 두 말 중 하나만 맞아도 본다 — 판이 올라가며 한쪽 문장이 바뀌어도 걸리게.
   */
  sessionInUse: (reason) =>
    /in use by another Codex client|already has an active writer/i.test(reason),
};
