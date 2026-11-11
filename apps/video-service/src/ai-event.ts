/**
 * 视频 AI 识别事件接入。
 *
 * 摄像头侧的算法识别出虫害后，需要把「识别结果」变成「告警与消息」。
 * 这条链路统一由遥测服务收口：它负责落库、生成告警、发布 TelemetryPestDetected 事件，
 * 消息中心再按模板生成通知。视频服务只做校验与转发，避免同一份识别结果出现第二条告警路径。
 */

/** 算法侧上报的识别结果 */
export interface AiDetection {
  cameraId: string;
  plotCode: string;
  pestType: string;
  /** 发生等级：1 轻微、2 中等、3 严重 */
  level: 1 | 2 | 3;
  /** 识别置信度 0 到 1 */
  confidence: number;
  imageFileId?: string;
  detectedAt: string;
}

/** 解析并校验识别结果；失败抛错，由 HTTP 层统一转 400 */
export function parseAiDetection(body: Record<string, unknown>): AiDetection {
  const cameraId = String(body.cameraId ?? "").trim();
  const plotCode = String(body.plotCode ?? "").trim();
  const pestType = String(body.pestType ?? "").trim();
  if (cameraId === "") throw new Error("缺少摄像头标识");
  if (pestType === "") throw new Error("缺少虫害类型");
  const level = Number(body.level);
  if (level !== 1 && level !== 2 && level !== 3) throw new Error("发生等级需为 1、2 或 3");
  const confidence = body.confidence === undefined ? 0.9 : Number(body.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new Error("识别置信度需在 0 到 1 之间");
  const detection: AiDetection = {
    cameraId,
    plotCode,
    pestType,
    level,
    confidence,
    detectedAt: typeof body.detectedAt === "string" && body.detectedAt !== "" ? body.detectedAt : new Date().toISOString(),
  };
  if (typeof body.imageFileId === "string" && body.imageFileId !== "") detection.imageFileId = body.imageFileId;
  return detection;
}

/** 转发结果：forwarded 为 false 时表示遥测服务不可用，识别结果仍在视频侧有记录 */
export interface ForwardResult {
  forwarded: boolean;
  status: number;
  message: string;
}

/**
 * 把识别结果转给遥测服务的虫情入口。
 *
 * 该入口认设备回调凭证：转发时携带与遥测服务一致的 DEVICE_CALLBACK_TOKEN；
 * 转发失败不抛出，由调用方把 forwarded=false 一并返回，便于现场排查网络而不是丢掉识别结果。
 */
export async function forwardPestDetection(
  detection: AiDetection,
  options: { baseUrl: string; timeoutMs?: number; deviceToken?: string | undefined },
): Promise<ForwardResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/api/v1/telemetry/pest-events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.deviceToken ? { "x-device-token": options.deviceToken } : {}) },
      body: JSON.stringify({
        deviceId: detection.cameraId,
        plotCode: detection.plotCode,
        pestType: detection.pestType,
        level: detection.level,
        confidence: detection.confidence,
        ...(detection.imageFileId ? { imageFileId: detection.imageFileId } : {}),
        detectedAt: detection.detectedAt,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { forwarded: false, status: response.status, message: `遥测服务返回 ${response.status}` };
    }
    return { forwarded: true, status: 201, message: "已生成虫情告警" };
  } catch (error) {
    return { forwarded: false, status: 0, message: error instanceof Error ? error.message : "遥测服务不可达" };
  } finally {
    clearTimeout(timer);
  }
}
