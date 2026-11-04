import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 测试期把 @agri/* 别名直连源码，避免测试依赖构建顺序。
 * 生产构建走 tsc -b（project references），产物落在各包 dist 目录。
 */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // 业务代码的订阅声明依赖旧式装饰器语义（tsc 侧由 @agri/tsconfig/nest.json 开启），
  // 测试期转译同样需要开启，否则装饰器登记不上处理器。
  // 注意：这里不需要 emitDecoratorMetadata，装配中有依赖的提供者一律显式声明 inject。
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
      },
    },
  },
  resolve: {
    alias: [
      // 子路径导出必须排在主入口之前
      { find: /^@agri\/contracts\/events$/, replacement: r("./packages/contracts/src/events/index.ts") },
      { find: /^@agri\/contracts\/errors$/, replacement: r("./packages/contracts/src/errors/index.ts") },
      { find: /^@agri\/contracts$/, replacement: r("./packages/contracts/src/index.ts") },
      { find: /^@agri\/plot-core$/, replacement: r("./packages/plot-core/src/index.ts") },
      { find: /^@agri\/observability$/, replacement: r("./packages/observability/src/index.ts") },
      { find: /^@agri\/db$/, replacement: r("./packages/db/src/index.ts") },
      { find: /^@agri\/mq$/, replacement: r("./packages/mq/src/index.ts") },
      { find: /^@agri\/config$/, replacement: r("./packages/config/src/index.ts") },
      { find: /^@agri\/shared$/, replacement: r("./packages/shared/src/index.ts") },
      { find: /^@agri\/testing$/, replacement: r("./packages/testing/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/**/test/**/*.spec.ts", "apps/**/test/**/*.spec.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
