import tseslint from "typescript-eslint";

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
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "vscode",
              message:
                "core는 vscode를 import할 수 없습니다. 셸 기능이 필요하면 WorkspaceHost 인터페이스에 추가하세요.",
            },
          ],
          patterns: [
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
          ],
        },
      ],
    },
  },
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
);
