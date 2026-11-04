/**
 * 类型相关规则：显式返回类型、禁用松散类型。
 * 公共包导出必须标注返回类型，故 createConfig 允许把该项提升为 error。
 */
export const TYPESCRIPT_RULES = {
  "@typescript-eslint": {
    "explicit-function-return-type": [
      "warn",
      { allowExpressions: true, allowTypedFunctionExpressions: true, allowHigherOrderFunctions: true },
    ],
    "explicit-module-boundary-types": "warn",
    "no-unsafe-assignment": "warn",
    "no-unsafe-member-access": "warn",
    "no-floating-promises": "error",
    "await-thenable": "error",
  },
};

/**
 * 把显式返回类型规则提升为 error，用于公共包。
 * @returns {Record<string, unknown>} 覆盖后的规则片段
 */
export function withStrictReturnType() {
  return {
    "@typescript-eslint": {
      ...TYPESCRIPT_RULES["@typescript-eslint"],
      "explicit-function-return-type": [
        "error",
        { allowExpressions: true, allowTypedFunctionExpressions: true, allowHigherOrderFunctions: true },
      ],
    },
  };
}
