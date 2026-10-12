// ESLint 설정: JS 권장 규칙 + typescript-eslint 권장 규칙. 빈 catch는 CLAUDE.md 규칙에 따라 금지한다.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // .venv: 파이썬 워커(uv) 가상환경에는 torch가 넣은 JS 파일이 있어, 무시하지 않으면 npm run lint가 그것까지 검사한다.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.venv/**", "docs/**", "**/*.d.ts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
]);
