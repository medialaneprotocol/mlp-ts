// The lint gate for this package.
//
// TypeScript's own recommended rules, plus the two the repository's style
// forbids outright: `any`, and the non-null assertion. Both would be ways
// of dodging a type rather than writing one.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
);
