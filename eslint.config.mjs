import tseslint from "typescript-eslint";

// core 전체에 걸리는 금지 — 층 규칙이 같은 규칙을 덮어쓰므로 상수로 두고 합쳐 건다
const CORE_PATHS = [
  {
    name: "vscode",
    message:
      "core는 vscode를 import할 수 없습니다. 셸 기능이 필요하면 WorkspaceHost 인터페이스에 추가하세요.",
  },
];
const CORE_PATTERNS = [
  // 문자열과 객체를 한 배열에 못 섞는다 — 원래 두 줄도 객체 꼴로 둔다
  { group: ["../vscode/*", "../webview/*"], message: "core 는 셸(vscode·webview)을 모릅니다." },
  {
    /*
     * ★ **core 는 에이전트를 모른다** (리팩토링 ①, 2026-10-20).
     * 에이전트에 따라 달라야 하는 것은 `agent-api.ts` 에 칸을 내고
     * 애드온이 채운다 — core 가 애드온을 들여다보면 «이 에이전트만
     * 올릴 때 한 폴더만 보면 된다» 가 깨진다(docs/REFACTOR.md §2).
     */
    regex: "(^|/)agents(/|$)",
    message:
      "core 는 src/agents/* 를 import 할 수 없습니다. 에이전트마다 달라야 하면 core/agent-api.ts 에 칸을 내세요.",
  },
];

/*
 * ★ **층은 아래만 본다** (리팩토링 ⑧·⑨, 2026-10-20 · docs/REFACTOR.md §4 ⑤).
 *
 *   L0  room/rooms · room/runtimes      아무 층도 안 본다
 *   L1  session/pool
 *   L2  session/config
 *   L3  session/sessions · turn/activity · turn/prompt · room/fork
 *   L4  turn/turns
 *   L5  room/outbox
 *       mcp · review                    봇 상태(runtimes)만
 *       roomManager                     전부 — 그리고 아무 층도 roomManager 를 안 본다
 *
 * 🔴 위층을 부를 일이 있으면 import 하지 말고 **포트의 갈고리**로 받는다 — 턴이 예약
 * 보내기를 `turnDone` 으로 받는 것처럼. 그 갈고리가 곧 «위층에 무엇을 바라나» 의 목록이다.
 */
const up = (regex, what) => ({ regex, message: `아래층은 위층을 모릅니다 — ${what}. 필요하면 포트에 갈고리를 내세요.` });
const NO_MANAGER = up("(^|/)roomManager\\.js$", "roomManager");
const NO_SESSION = up("(^|/)session/", "session/*");
const NO_TURN = up("(^|/)turn/", "turn/*");
const NO_TURNS = up("(^|/)turns\\.js$", "turn/turns");
const NO_SESSIONS = up("(^|/)sessions\\.js$", "session/sessions");
const NO_FORK = up("(^|/)fork\\.js$", "room/fork");
const NO_OUTBOX = up("(^|/)outbox\\.js$", "room/outbox");
const layer = (files, ...forbid) => ({
  files,
  rules: {
    "no-restricted-imports": ["error", { paths: CORE_PATHS, patterns: [...CORE_PATTERNS, NO_MANAGER, ...forbid] }],
  },
});

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // `const { drop: _drop, ...rest } = obj`로 필드를 덜어내는 관용구를 허용한다
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // core는 셸에 의존하지 않는다. 이 규칙이 v2에서 다른 셸(Electron 등)을
    // 붙일 수 있게 하고, core를 단독 테스트 가능하게 유지한다.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: CORE_PATHS, patterns: CORE_PATTERNS }],
    },
  },
  // ── 층 (뒤 블록이 앞 블록의 같은 규칙을 덮어쓴다 — 좁은 것을 뒤에) ──
  layer(["src/core/*/**/*.ts"]),
  layer(["src/core/mcp/**/*.ts", "src/core/review/**/*.ts"], NO_SESSION, NO_TURN, NO_FORK, NO_OUTBOX),
  layer(["src/core/session/**/*.ts"], NO_TURN, NO_FORK, NO_OUTBOX),
  layer(["src/core/session/pool.ts", "src/core/session/config.ts"], NO_TURN, NO_FORK, NO_OUTBOX, NO_SESSIONS),
  layer(["src/core/room/rooms.ts", "src/core/room/runtimes.ts"], NO_SESSION, NO_TURN, NO_FORK, NO_OUTBOX),
  layer(["src/core/room/fork.ts"], NO_TURN, NO_OUTBOX),
  layer(["src/core/turn/**/*.ts"], NO_OUTBOX, NO_FORK),
  layer(["src/core/turn/activity.ts", "src/core/turn/prompt.ts"], NO_OUTBOX, NO_FORK, NO_TURNS, NO_SESSIONS),
  {
    /*
     * ★ **애드온은 문 하나로만 core 를 본다** (리팩토링 ①, 2026-10-20).
     *
     * 🔴 이게 없으면 몇 달 뒤 «Antigravity 만 잠깐» 하는 import 하나로 격리가
     * 끝난다. 애드온이 기대는 것은 `core/agent-api.ts` 하나뿐이고, 다른 애드온은
     * **아예 모른다** — 그래야 한 에이전트를 올릴 때 그 폴더만 보면 된다.
     *
     * 목록(`agents/index.ts`)만은 예외다 — 셋을 줄 세우는 것이 그 일이다.
     */
    files: ["src/agents/*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "vscode", message: "애드온은 vscode 를 모릅니다." }],
          patterns: [
            {
              regex: "(^|/)core/(?!agent-api\\.js$)",
              message: "애드온은 core 에서 core/agent-api.ts 만 import 합니다.",
            },
            {
              // `../다른애드온/…` — 형제를 보는 길. `../../` 는 core 쪽이라 위가 맡는다
              regex: "^\\.\\./(?!\\.\\./)",
              message: "애드온은 다른 애드온을 import 할 수 없습니다.",
            },
            { regex: "(^|/)(vscode|webview)/", message: "애드온은 확장 호스트·화면을 모릅니다." },
          ],
        },
      ],
    },
  },
  {
    // 화면은 에이전트를 모른다 — 에이전트마다 다른 것은 호스트가 다 뜯어서 보낸다
    files: ["src/webview/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "(^|/)agents(/|$)", message: "화면은 src/agents/* 를 import 할 수 없습니다." },
          ],
        },
      ],
    },
  },
  {
    /*
     * ★ **창 공통은 창을 모른다** (webview 나누기, 2026-10-20 · src/webview/README.md).
     * 공통이 어느 창을 부르면 그 창 없이는 못 쓰는 «공통» 이 된다. 형만은 허용한다 —
     * 같이 쓰는 상태의 칸(`S.chat`)이 채팅의 DOM 손잡이 형을 들고 있다.
     */
    files: ["src/webview/common/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [{
            regex: "^\\.\\./(chat|list|new|join|setup|perm|drawer)/",
            allowTypeImports: true,
            message: "창 공통(common/)은 창 모듈을 import 하지 않습니다. 창이 공통을 부르게 하세요.",
          }],
        },
      ],
    },
  },
);
