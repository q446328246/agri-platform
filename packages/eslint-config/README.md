# @agri/eslint-config

把全工程的代码规范收敛为一组可组合的配置，并承担一项超出常规规范的职责：**把架构约束写成可在提交与流水线中自动执行的检查规则**。

常规规范解决「写法是否一致」，架构约束解决「依赖是否正确」。后者通常只停留在文档与评审意见中，随人员流动很快失效；变为机器校验才能长期保持依赖分层。

## 导出清单

| 导出名称 | 适用对象 | 说明 |
| --- | --- | --- |
| `base.mjs` | 全部工程 | 通用规则：命名、导入顺序、未使用变量 |
| `typescript.mjs` | 使用类型的工程 | 显式返回类型、禁用松散类型 |
| `nest.mjs` | 服务工程 | 依赖注入与装饰器相关规则 |
| `vue.mjs` | 前端工程 | 单文件组件与模板相关规则 |
| `architecture.mjs` | 全部工程 | 依赖方向与跨层引用校验 |
| `createConfig` | 函数入口 | 按选项组合规则集，返回扁平化配置 |

## 使用

```js
// apps/plot-service/eslint.config.mjs
import { createConfig } from "@agri/eslint-config";

export default createConfig({
  framework: "nest",
  architecture: true,
  tsconfigRootDir: import.meta.dirname,
});
```

```js
// packages/contracts/eslint.config.mjs
import { createConfig } from "@agri/eslint-config";

export default createConfig({
  framework: "library",
  architecture: true,
  /** 公共包导出必须标注返回类型，故此处提升为错误 */
  explicitReturnType: "error",
  tsconfigRootDir: import.meta.dirname,
});
```

## 插件降级策略

`@typescript-eslint/eslint-plugin`、`eslint-plugin-import`、`eslint-plugin-vue` 为**可选**依赖。未安装时对应规则整体跳过，而架构约束使用内建 `no-restricted-imports` 实现，始终生效。这样在只装 `eslint` 的最小环境里也能拦住违规依赖。

## 架构约束清单

| 约束 | 检查对象 | 违规示例 |
| --- | --- | --- |
| 公共包不得引用应用层 | 公共包源码 | 公共包中出现对服务目录或服务包的导入 |
| 依赖只向下 | 公共包源码 | 在契约包中导入消息包 |
| 同层解耦 | 能力包源码 | 数据、消息、可观测性三包互相导入 |
| 应用层互不引用 | 服务源码 | 在作业服务中直接导入核算服务的源码文件 |
| 禁止深层导入 | 全部源码 | 从包产物目录或内部文件路径导入 |

架构约束规则同时以独立脚本在流水线中再校验一次，两处并非重复：Lint 面向开发者即时反馈，脚本面向合并与构建的最终拦截。
