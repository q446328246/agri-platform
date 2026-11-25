import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface MqttDeviceConfig {
  username: string;
  brokerUrl: string;
  caCertificate: string;
  passwordCiphertext: string;
}

export interface MqttConfigCipher {
  encrypt(password: string): string;
  decrypt(passwordCiphertext: string): string;
}

export interface ParsedMqttConfig {
  config: MqttDeviceConfig;
  password?: string;
}

function encryptionKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("MQTT_CONFIG_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  return key;
}

export function createMqttConfigCipher(rawKey: string): MqttConfigCipher {
  const key = encryptionKey(rawKey);
  return {
    encrypt(password: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
    },
    decrypt(passwordCiphertext: string): string {
      const [version, iv, tag, encrypted] = passwordCiphertext.split(":");
      if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("MQTT 密码密文格式无效");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string") throw new Error("MQTT 密码需为字符串");
  if (value.length < 8 || value.length > 128) throw new Error("MQTT 密码长度需为 8~128 个字符");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("MQTT 密码不能包含控制字符");
  return value;
}

function validateBrokerUrl(value: unknown): string {
  const raw = requiredText(value, "MQTT Broker 地址");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MQTT Broker 地址格式无效");
  }
  if (url.protocol !== "mqtt:" && url.protocol !== "mqtts:") throw new Error("MQTT Broker 地址需使用 mqtt:// 或 mqtts://");
  if (!url.hostname || url.username || url.password || url.hash) throw new Error("MQTT Broker 地址不能包含账号、密码或片段");
  return raw;
}

function validateCertificate(value: unknown, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error("mqtts 连接需上传 CA 证书");
    return "";
  }
  if (typeof value !== "string") throw new Error("CA 证书需为 PEM 文本");
  const certificate = value.trim();
  if (!certificate.includes("-----BEGIN CERTIFICATE-----") || !certificate.includes("-----END CERTIFICATE-----")) {
    throw new Error("CA 证书需为 X.509 PEM 格式");
  }
  if (Buffer.byteLength(certificate, "utf8") > 65_536) throw new Error("CA 证书不能超过 64 KB");
  return certificate;
}

export function parseMqttConfig(raw: unknown, current: MqttDeviceConfig | undefined, cipher: MqttConfigCipher): ParsedMqttConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MQTT 连接配置需为 JSON 对象");
  const value = raw as Record<string, unknown>;
  const username = requiredText(value.username, "MQTT 账号");
  if (username.length > 64 || /\s/.test(username)) throw new Error("MQTT 账号长度需为 1~64 个字符且不能包含空白");
  const brokerUrl = validateBrokerUrl(value.brokerUrl);
  const caCertificate = value.caCertificate === undefined && current
    ? current.caCertificate
    : validateCertificate(value.caCertificate, brokerUrl.startsWith("mqtts://"));
  const password = value.password === undefined || value.password === "" ? undefined : validatePassword(value.password);
  if (!password && !current) throw new Error("首次配置 MQTT 必须填写密码");
  return {
    config: {
      username,
      brokerUrl,
      caCertificate,
      passwordCiphertext: password ? cipher.encrypt(password) : current!.passwordCiphertext,
    },
    ...(password ? { password } : {}),
  };
}

export function publicMqttConfig(config: MqttDeviceConfig): { username: string; brokerUrl: string; hasPassword: boolean; hasCaCertificate: boolean } {
  return {
    username: config.username,
    brokerUrl: config.brokerUrl,
    hasPassword: Boolean(config.passwordCiphertext),
    hasCaCertificate: Boolean(config.caCertificate),
  };
}
