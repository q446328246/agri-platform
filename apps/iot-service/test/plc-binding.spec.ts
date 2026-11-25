import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DEVICE_PROTOCOLS, fieldAccessCatalogue, fieldGatewayProtocols, getDeviceProtocolDriver } from "../src/device-binding.js";
import { createMqttConfigCipher } from "../src/mqtt-config.js";
import { normalizePlcConfig, plcProfiles, publicPlcConfig, readPlcConfig } from "../src/plc-binding.js";

const cipher = createMqttConfigCipher(randomBytes(32).toString("base64"));

function opcInput(profile = "OPC_UA_WATER_M3") {
  return {
    endpointUrl: "opc.tcp://opc.test:4840",
    authMode: "USERNAME",
    username: "operator",
    password: randomBytes(12).toString("base64url"),
    profile,
    switchPoint: "ns=2;i=1001",
    runFeedbackPoint: "ns=2;i=1002",
    faultPoint: "ns=2;i=1003",
    meterPoint: "ns=2;i=1004",
  };
}

describe("PLC 协议目录与连接配置", () => {
  it("四种 PLC 协议有独立驱动、参数 schema 和执行剖面", () => {
    const plcProtocols = DEVICE_PROTOCOLS.filter((protocol) => getDeviceProtocolDriver(protocol).runtime === "PLC_DRIVER");
    expect(plcProtocols).toEqual(["PLC_MODBUS_TCP", "SIEMENS_S7", "MITSUBISHI_MC", "OPC_UA"]);
    expect(new Set(plcProtocols.map((protocol) => getDeviceProtocolDriver(protocol).id)).size).toBe(4);
    expect(fieldGatewayProtocols()).toEqual(["MODBUS_TCP", ...plcProtocols]);
    for (const protocol of plcProtocols) {
      expect(plcProfiles(protocol)).toHaveLength(3);
      expect(getDeviceProtocolDriver(protocol).parameters.map((parameter) => parameter.key)).toEqual(
        expect.arrayContaining(["profile", "switchPoint", "runFeedbackPoint", "faultPoint", "meterPoint"]),
      );
    }
  });

  it("计量剖面强制要求计量点位，无计量剖面拒绝多余点位", () => {
    const input = opcInput();
    const { meterPoint, ...missingMeter } = input;
    expect(() => normalizePlcConfig("OPC_UA", missingMeter, "PLC", undefined, cipher)).toThrow("meterPoint");
    expect(() => normalizePlcConfig("OPC_UA", input, "PLC", undefined, cipher)).not.toThrow();
    expect(() => normalizePlcConfig("OPC_UA", opcInput("OPC_UA_SWITCH_ONLY"), "PLC", undefined, cipher)).toThrow("无计量剖面");
    expect(meterPoint).toBeTruthy();
  });

  it("OPC UA 密码加密落库、响应脱敏，编辑留空沿用原密文", () => {
    const input = opcInput();
    const first = normalizePlcConfig("OPC_UA", input, "PLC", undefined, cipher).config;
    if (first.driverId !== "OPC_UA_CLIENT") throw new Error("OPC UA driver mismatch");
    expect(first.passwordCiphertext).not.toBe(input.password);
    expect(publicPlcConfig(first)).toMatchObject({ hasPassword: true });
    expect(publicPlcConfig(first)).not.toHaveProperty("passwordCiphertext");

    const edited = normalizePlcConfig("OPC_UA", { ...input, password: "" }, "PLC", first, cipher).config;
    expect(edited).toEqual(first);
    expect(readPlcConfig("OPC_UA", first, "PLC", cipher)).toEqual(first);
  });

  it("匿名 OPC UA 不需要密码或加密密钥", () => {
    const parsed = normalizePlcConfig("OPC_UA", {
      endpointUrl: "opc.tcp://opc.test:4840",
      authMode: "ANONYMOUS",
      profile: "OPC_UA_SWITCH_ONLY",
      switchPoint: "ns=2;i=1001",
      runFeedbackPoint: "ns=2;i=1002",
      faultPoint: "ns=2;i=1003",
    }, "PLC");
    expect(parsed.config).toMatchObject({ driverId: "OPC_UA_CLIENT", authMode: "ANONYMOUS" });
    expect(parsed.config).not.toHaveProperty("passwordCiphertext");
  });

  it("MC 帧格式与 32 位字地址按协议校验", () => {
    const ascii = normalizePlcConfig("MITSUBISHI_MC", {
      host: "mc.test",
      ascii: "ASCII",
      profile: "MITSUBISHI_MC_WATER_M3",
      switchPoint: "M0",
      runFeedbackPoint: "M1",
      faultPoint: "M2",
      meterPoint: "D0",
    }, "PLC").config;
    expect(ascii).toMatchObject({ driverId: "MITSUBISHI_MC_DRIVER", ascii: true });
    expect(() => normalizePlcConfig("MITSUBISHI_MC", {
      host: "mc.test",
      profile: "MITSUBISHI_MC_FERTILIZER_L",
      switchPoint: "M0",
      runFeedbackPoint: "M1",
      faultPoint: "M2",
      meterPoint: "D0",
    }, "PLC")).toThrow("meterPoint");
  });

  it("接入目录不把 PLC 剖面混进 Modbus 地址表", () => {
    const catalogue = fieldAccessCatalogue();
    expect(catalogue.profiles.every((profile) => profile.protocol === "MODBUS_TCP")).toBe(true);
    expect(catalogue.plcProfiles).toHaveLength(12);
  });
});
