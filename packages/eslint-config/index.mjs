import { createRequire } from "node:module";

import { ARCHITECTURE_CONSTRAINTS } from "./architecture.mjs";
import { BASE_RULES } from "./base.mjs";
import { NEST_RULES } from "./nest.mjs";
import { TYPESCRIPT_RULES, withStrictReturnType } from "./typescript.mjs";
import { VUE_RULES } from "./vue.mjs";

const require = createRequire(import.meta.url);

/** 规则前缀到插件包名的映射 */
const PLUGIN_PACKAGES = {
  "@typescript-eslint": "@typescript-eslint/eslint-plugin",
  import: "eslint-plugin-import",
  vue: "eslint-plugin-vue",
};

/**
 * 解析已安装的插件。
 * 插件为可选依赖：未安装时对应规则整体降级跳过，架构约束仍然生效。
 * @returns {Record<string, unknown>} 插件名到插件对象的映射
 */
export function resolvePlugins() {
  const resolved = {};
  for (const [prefix, pkg] of Object.entries(PLUGIN_PACKAGES)) {
    try {
      resolved[prefix] = require(pkg);
    } catch {
      // 插件未安装，跳过该组规则
    }
  }
  return resolved;
}

/**
 * 按规则提供方分组，把可解析的插件规则合并进来。
 * @param {Record<string, unknown>} plugins 已解析插件
 * @param {Array<Record<string, unknown>>} groups 规则分组
 * @param {Record<string, unknown>} rules 累积结果
 */
function mergeRules(plugins, groups, rules) {
  for (const group of groups) {
    if (!group) continue;
    for (const [prefix, ruleSet] of Object.entries(group)) {
      if (prefix === "builtin" || plugins[prefix]) {
        Object.assign(rules, ruleSet);
      }
    }
  }
}

/**
 * 把架构约束按作用文件分组，合并为 no-restricted-imports 规则。
 * @returns {Array<Record<string, unknown>>} 扁平配置片段
 */
function buildArchitectureConfigs() {
  /** @type {Map<string, {files: string[], patterns: object[]}>} */
  const grouped = new Map();
  for (const constraint of ARCHITECTURE_CONSTRAINTS) {
    const key = constraint.files.join("|");
    const bucket = grouped.get(key) ?? { files: constraint.files, patterns: [] };
    bucket.patterns.push(...constraint.patterns);
    grouped.set(key, bucket);
  }
  return [...grouped.values()].map((bucket) => ({
    files: bucket.files,
    rules: {
      "no-restricted-imports": ["error", { patterns: bucket.patterns }],
    },
  }));
}

/**
 * 组装 ESLint 扁平配置。
 * @param {object} [options] 选项
 * @param {"library"|"nest"|"vue"} [options.framework] 工程类型
 * @param {boolean} [options.architecture] 是否启用架构约束
 * @param {"warn"|"error"} [options.explicitReturnType] 显式返回类型规则级别
 * @param {string} [options.tsconfigRootDir] 类型感知规则的 tsconfig 根目录
 * @returns {Array<Record<string, unknown>>} 可直接导出的扁平配置
 */
export function createConfig(options = {}) {
  const {
    framework = "library",
    architecture = true,
    explicitReturnType,
    tsconfigRootDir,
  } = options;

  const plugins = resolvePlugins();
  const rules = {};

  mergeRules(plugins, [BASE_RULES, VUE_RULES], rules);

  if (framework === "library") {
    mergeRules(plugins, [explicitReturnType === "error" ? withStrictReturnType() : TYPESCRIPT_RULES], rules);
  } else if (framework === "nest") {
    mergeRules(plugins, [TYPESCRIPT_RULES, NEST_RULES], rules);
  }

  /** @type {Array<Record<string, unknown>>} */
  const configs = [
    {
      ignores: ["**/node_modules/**", "**/dist/**", "**/*.tsbuildinfo", "coverage/**"],
    },
    {
      files: ["**/*.ts", "**/*.mjs", "**/*.vue"],
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        parserOptions: {
          ...(tsconfigRootDir ? { tsconfigRootDir } : {}),
          projectService: true,
        },
      },
      plugins,
      rules,
    },
  ];

  if (architecture) {
    configs.push(...buildArchitectureConfigs());
  }

  // 测试与脚本豁免调试输出限制
  configs.push({
    files: ["**/*.spec.ts", "**/*.test.ts", "scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  });

  return configs;
}

export { ARCHITECTURE_CONSTRAINTS } from "./architecture.mjs";
export { BASE_RULES } from "./base.mjs";
export { NEST_RULES } from "./nest.mjs";
export { TYPESCRIPT_RULES } from "./typescript.mjs";
export { VUE_RULES } from "./vue.mjs";

export default createConfig;
