/**
 * 架构约束：把依赖分层写成机器可校验的规则。
 *
 * 这组规则解决的不是「写法是否一致」，而是「依赖是否正确」。
 * 以「禁止导入路径」形式表达，覆盖面清晰、误报率低。
 */
export const ARCHITECTURE_CONSTRAINTS = [
  {
    name: "公共包不得引用应用层",
    files: ["packages/**/*.ts"],
    patterns: [
      {
        group: ["apps/*", "**/apps/**"],
        message: "公共包不得引用应用层代码：业务分支应留在服务内部。",
      },
    ],
  },
  {
    name: "依赖只向下（契约包不得引用能力包）",
    files: ["packages/contracts/**/*.ts"],
    patterns: [
      {
        group: ["@agri/db", "@agri/mq", "@agri/observability"],
        message: "契约包不得依赖能力包，否则会把运行期依赖带进前端构建。",
      },
    ],
  },
  {
    name: "同层解耦（数据、消息、可观测性互不依赖）",
    files: ["packages/db/**/*.ts", "packages/mq/**/*.ts", "packages/observability/**/*.ts"],
    patterns: [
      {
        group: ["@agri/db", "@agri/mq", "@agri/observability"],
        message: "L3 能力包之间禁止互相依赖：数据、消息、可观测性三包互不引用。",
      },
    ],
  },
  {
    name: "应用层互不引用",
    files: ["apps/**/*.ts"],
    patterns: [
      {
        group: ["../../packages/*/src/**", "@agri/app-*"],
        message: "服务之间通过契约包的共享类型通信，不得直接导入对方源码。",
      },
    ],
  },
  {
    name: "禁止深层导入",
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    patterns: [
      {
        group: ["@agri/*/dist/**", "@agri/*/src/**"],
        message: "只从包入口或声明的子路径导入，深层导入会在内部重构时破坏下游。",
      },
    ],
  },
];
