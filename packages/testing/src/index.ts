/**
 * @agri/testing 主入口。
 * 仅供测试环境引入；生产依赖不得指向本包。
 */
export { MockClock, freezeTime } from "./clock.js";
export { InMemoryEventBus } from "./event-bus.js";
export type { BusEvent, BusHandler, BusPublishReceipt } from "./event-bus.js";
export {
  createTestDatabase,
  DEFAULT_TEST_TABLES,
  resetDatabase,
  stopTestDatabase,
} from "./test-database.js";
export type { TestDatabase, TestDatabaseOptions } from "./test-database.js";
export { buildTestModule, TestModuleBuilder } from "./module-builder.js";
export {
  buildPlotCodeFixture,
  deviceFixture,
  gridFixture,
  plotFixture,
  seasonFixture,
  telemetryFixture,
} from "./fixtures.js";
export type { TelemetryFixture } from "./fixtures.js";
