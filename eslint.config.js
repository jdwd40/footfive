import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "e2e/**",
      "playwright-report/**",
      "test-results/**",
      "backups/**",
      "pocketbase/pb_data/**",
      "pocketbase/pb_data_test/**",
      "pocketbase/pb_data_rehearsal/**",
      // Applied migrations are immutable history; never edited to satisfy lint.
      "pocketbase/pb_migrations/**",
      "pocketbase/pocketbase",
      "e2e/.browser-libs/**",
      "coverage/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}", "shared/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // PocketBase JSVM hooks (goja). lib/*.js are CommonJS modules required from
  // handlers; *.pb.js are scripts whose handler callbacks run without the file's
  // outer scope.
  {
    extends: [js.configs.recommended],
    files: ["pocketbase/pb_hooks/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.es2021,
        console: "readonly",
        $app: "readonly",
        $apis: "readonly",
        $dbx: "readonly",
        $os: "readonly",
        $security: "readonly",
        __hooks: "readonly",
        Record: "readonly",
        arrayOf: "readonly",
        sleep: "readonly",
        ApiError: "readonly",
        BadRequestError: "readonly",
        ForbiddenError: "readonly",
        NotFoundError: "readonly",
        UnauthorizedError: "readonly",
        routerAdd: "readonly",
        routerUse: "readonly",
        cronAdd: "readonly",
        onBootstrap: "readonly",
        onRecordCreateRequest: "readonly",
        onRecordUpdateRequest: "readonly",
        onRecordDeleteRequest: "readonly",
        onRecordAuthRequest: "readonly",
      },
    },
    rules: {
      "no-redeclare": ["error", { builtinGlobals: true }],
      // ES5 needs a catch binding, so unused ones are inherent, not findings.
      "no-unused-vars": [
        "error",
        { vars: "all", args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Best-effort `catch (_) {}` is deliberate in hooks.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["pocketbase/pb_hooks/*.pb.js"],
    languageOptions: {
      sourceType: "script",
      globals: { require: "readonly" },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program > :matches(VariableDeclaration, FunctionDeclaration, ClassDeclaration)",
          message:
            "PocketBase runs hook handlers without this file's scope: put helpers in lib/ and require them inside the handler.",
        },
      ],
    },
  },
);
