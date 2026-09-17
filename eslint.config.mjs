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
          patterns: ["../vscode/*", "../webview/*"],
        },
      ],
    },
  },
);
