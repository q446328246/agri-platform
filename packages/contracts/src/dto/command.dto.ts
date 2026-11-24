/**
 * 控制指令类型与作业指令集合。
 *
 * 控制侧（control-service）的作业联锁与现场网关（iot-service）的电子围栏/离线保护
 * 都要判断「哪些指令是执行类作业」，两边各抄一份清单就会出现两套口径，
 * 因此作业指令集合在契约层定单一真相源。
 */

/** 执行类作业指令：同一设备同时只允许一条在途（作业联锁 B4） */
export const JOB_COMMAND_TYPES = ["IRRIGATION", "FERTILIZATION", "SEEDING", "TILLAGE", "WEEDING", "TOOL_SWITCH", "RETURN_HOME"] as const;

export type JobCommandType = (typeof JOB_COMMAND_TYPES)[number];

/** 是否为执行类作业指令 */
export function isJobCommandType(type: string): boolean {
  return (JOB_COMMAND_TYPES as readonly string[]).includes(type);
}
