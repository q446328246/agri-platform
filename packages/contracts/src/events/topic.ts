/**
 * 领域事件主题常量。
 *
 * 主题字符串只在此处定义，服务侧一律引用常量而非字面量。
 * 命名格式：业务对象 + 动作 + 过去式，主题前缀为生产者所属服务名。
 */
export const EventTopic = {
  PlotCreated: "plot.plot.created",
  IotDeviceOffline: "iot.device.offline",
  TelemetryThresholdBreached: "telemetry.threshold.breached",
  TelemetryPestDetected: "telemetry.pest.detected",
  DecisionPrescriptionIssued: "decision.prescription.issued",
  OperationTaskCompleted: "operation.task.completed",
  ControlIrrigationFinished: "control.irrigation.finished",
  ControlCommandTimeout: "control.command.timeout",
  FinanceCostAccrued: "finance.cost.accrued",
} as const;

/** 事件主题联合类型 */
export type EventTopicValue = (typeof EventTopic)[keyof typeof EventTopic];

/** 全部主题的数组形式，供网关与运维侧遍历 */
export const EVENT_TOPIC_VALUES: EventTopicValue[] = Object.values(EventTopic);
