/**
 * @agri/contracts 主入口，汇总转出五个导出分区。
 *
 * 契约包是全平台唯一的接口真相来源：只定义、不实现，不依赖任何能力包。
 * 每一次导出变更都视为平台级接口变更，需按兼容性规则判定版本号并通知下游。
 */
export * from "./common/index.js";
export * from "./events/index.js";
export * from "./errors/index.js";
export * from "./dto/index.js";
export * from "./enums/index.js";
export * from "./messages/index.js";
export * from "./authz/index.js";
