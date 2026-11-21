// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/generated/**", "packages/sdk/src/schema.d.ts", "*.config.js", ".dependency-cruiser.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false, attributes: false } }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  { files: ["**/test/**", "**/scripts/**", "apps/server/src/cli.ts"], rules: { "no-console": "off", "@typescript-eslint/no-floating-promises": "off" } },
  {
    // Fastify admite hooks async (devuelven promesa); la regla no conoce esa firma.
    files: ["apps/server/src/access/http/plugins/**"],
    rules: { "@typescript-eslint/no-misused-promises": "off" },
  },
);
