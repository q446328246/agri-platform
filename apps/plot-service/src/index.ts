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
export { SqlPlotOutboxStore } from "./outbox.repository.js";
export { CROP_SEASON_STATUSES, InMemoryCropSeasonRepository, SqlCropSeasonRepository, compareRotation, isValidFarmDate } from "./season.repository.js";
export type { CropSeason, CropSeasonInput, CropSeasonPatch, CropSeasonRepository, CropSeasonStatus } from "./season.repository.js";
export { PLOT_CHANGE_ACTIONS, InMemoryPlotChangeLogRepository, SqlPlotChangeLogRepository } from "./plot-change-log.repository.js";
export type { PlotChangeAction, PlotChangeLog, PlotChangeLogRepository } from "./plot-change-log.repository.js";
export { PlotService } from "./plot.service.js";
export type { MergePlotsInput, MergePlotsResult, MergePreviewResult, RegisterPlotInput, SplitPlotInput, SplitPlotPiece, SplitPlotResult } from "./plot.service.js";
export { createExamplePrismaFactory, exampleId } from "./prisma.factory.js";
export { createPlotHttpServer } from "./http.js";
