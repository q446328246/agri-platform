/**
 * 通用规则：命名、导入顺序、未使用变量。
 * 规则按提供方分组，便于在插件不可用时降级而不是整体失败。
 */
export const BASE_RULES = {
  // 内建规则，无需任何插件
  builtin: {
    "no-console": ["error", { allow: ["warn", "error"] }],
    "no-debugger": "error",
    "no-var": "error",
    "prefer-const": "error",
    eqeqeq: ["error", "always", { null: "ignore" }],
    "no-duplicate-imports": "error",
    "no-fallthrough": "error",
    "no-throw-literal": "error",
  },

  // 需 @typescript-eslint/eslint-plugin
  "@typescript-eslint": {
    "naming-convention": [
      "error",
      { selector: "typeLike", format: ["PascalCase"] },
      { selector: "interface", format: ["PascalCase"], prefix: [] },
      { selector: "variable", format: ["camelCase", "UPPER_CASE", "PascalCase"], leadingUnderscore: "allow" },
      { selector: "function", format: ["camelCase", "PascalCase"] },
      { selector: "class", format: ["PascalCase"] },
    ],
    "consistent-type-imports": ["error", { prefer: "type-imports" }],
    "no-explicit-any": "error",
  },

  // 需 eslint-plugin-import
  import: {
    "order": [
      "error",
      {
        groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
        "newlines-between": "always",
        alphabetize: { order: "asc", caseInsensitive: true },
      },
    ],
  },
};
