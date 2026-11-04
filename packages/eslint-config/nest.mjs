/**
 * 服务工程规则：依赖注入与装饰器相关。
 */
export const NEST_RULES = {
  "@typescript-eslint": {
    "no-extraneous-class": ["error", { allowWithDecorator: true }],
    "parameter-properties": ["error", { prefer: "class-property" }],
  },
  builtin: {
    // 服务内统一使用日志服务，脚本与测试文件在 createConfig 中豁免
    "no-console": ["error", { allow: ["warn", "error"] }],
  },
};
