/**
 * @agri/plot-service 示例入口。
 * 仅作为公共包引用组合的示范，生产服务按此结构扩展。
 */
export { AppModule, IDEMPOTENCY_STORE, OUTBOX_STORE, PLOT_REPOSITORY } from "./app.module.js";
export type { AppModuleOptions } from "./app.module.js";
export { PlotCodeService } from "./plot-code.service.js";
export { PlotEventConsumer } from "./plot.consumer.js";
export { InMemoryPlotRepository, SqlPlotRepository } from "./plot.repository.js";
export type { PlotRecord, PlotRepository } from "./plot.repository.js";
export { PlotService } from "./plot.service.js";
export type { RegisterPlotInput } from "./plot.service.js";
export { createExamplePrismaFactory, exampleId } from "./prisma.factory.js";
export { createPlotHttpServer } from "./http.js";
