import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import type { ModelServiceConfig, Settings } from "@/shared/contracts/settings";

/** safeStorage 的最小接口，便于在测试中注入假实现 */
export type Crypto = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/** 加密 apiKey 的落盘格式 */
export interface EncryptedKey {
  v: 1;
  enc: true;
  data: string;
}

type PersistedApiKey = string | EncryptedKey;
type PersistedService = Omit<ModelServiceConfig, "apiKey"> & { apiKey: PersistedApiKey };
type PersistedSettings = Omit<Settings, "services"> & { services: PersistedService[] };
type Warn = (message: string) => void;

/** 完整 Settings 默认值；读文件时缺失字段一律以此兜底 */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: "zh-CN",
  density: "comfortable",
  chatFont: "",
  chatFontSize: 14,
  defaultWorkingDir: null,
  services: [],
  defaultModel: null,
  thinkingLevel: "medium",
  permissionMode: "default",
  aiApprovalModel: null,
  skillDirs: [],
  disabledSkillNames: [],
};

export interface SettingsStoreOptions {
  /** 注入加密实现；缺省时动态加载 Electron safeStorage，不可用则回退明文 */
  crypto?: Crypto;
  /** 警告日志输出，默认 console.warn */
  warn?: Warn;
}

export interface SettingsStore {
  load(): Promise<Settings>;
  save(next: Settings): Promise<void>;
}

function cloneDefaults(): Settings {
  return { ...DEFAULT_SETTINGS, services: [], skillDirs: [], disabledSkillNames: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isEncryptedKey(value: unknown): value is EncryptedKey {
  if (!isRecord(value)) return false;
  return value.v === 1 && value.enc === true && typeof value.data === "string";
}

function encryptionAvailable(crypto: Crypto | null): boolean {
  if (!crypto) return false;
  try {
    return crypto.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 深合并仅覆盖顶层字段；services 数组整体替换，不逐元素合并 */
function mergeWithDefaults(raw: unknown, crypto: Crypto | null, warn: Warn): Settings {
  const base = cloneDefaults();
  if (!isRecord(raw)) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = raw[key];
    if (value !== undefined) merged[key] = value;
  }
  return {
    ...(merged as unknown as Settings),
    defaultModel: normalizeModelRef(raw.defaultModel),
    aiApprovalModel: normalizeModelRef(raw.aiApprovalModel),
    services: normalizeServices(raw.services, crypto, warn),
    skillDirs: Array.isArray(raw.skillDirs)
      ? raw.skillDirs.filter((dir) => typeof dir === "string")
      : base.skillDirs,
    disabledSkillNames: Array.isArray(raw.disabledSkillNames)
      ? raw.disabledSkillNames.filter((name) => typeof name === "string")
      : base.disabledSkillNames,
  };
}

function normalizeModelRef(raw: unknown): Settings["defaultModel"] {
  if (!isRecord(raw)) return null;
  const { serviceId, modelId } = raw;
  if (typeof serviceId !== "string" || typeof modelId !== "string") return null;
  return { serviceId, modelId };
}

function normalizeServices(raw: unknown, crypto: Crypto | null, warn: Warn): ModelServiceConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => ({
    id: asString(item.id),
    name: asString(item.name),
    baseUrl: asString(item.baseUrl),
    wireFormat: item.wireFormat === "openai-responses" ? "openai-responses" : "openai-completions",
    models: Array.isArray(item.models) ? (item.models as ModelServiceConfig["models"]) : [],
    apiKey: decodeApiKey(item.apiKey, crypto, warn),
  }));
}

/** 解密 apiKey：字符串视为旧格式明文；加密对象在无密钥环时置空并告警 */
function decodeApiKey(raw: unknown, crypto: Crypto | null, warn: Warn): string {
  if (typeof raw === "string") return raw;
  if (!isEncryptedKey(raw)) return "";
  if (crypto === null || !encryptionAvailable(crypto)) {
    warn("检测到加密的 apiKey，但当前环境无法解密，已置空");
    return "";
  }
  try {
    return crypto.decryptString(Buffer.from(raw.data, "base64"));
  } catch (error) {
    warn(`apiKey 解密失败，已置空: ${String(error)}`);
    return "";
  }
}

/** 加密 apiKey：safeStorage 不可用时原样返回明文字符串 */
function encodeApiKey(plain: string, crypto: Crypto | null): PersistedApiKey {
  if (plain === "" || crypto === null || !encryptionAvailable(crypto)) return plain;
  return { v: 1, enc: true, data: crypto.encryptString(plain).toString("base64") };
}

function toPersisted(settings: Settings, crypto: Crypto | null): PersistedSettings {
  return {
    ...settings,
    services: settings.services.map((service) => ({
      ...service,
      apiKey: encodeApiKey(service.apiKey, crypto),
    })),
  };
}

/** 创建一个基于指定数据目录的设置存储；测试传入临时目录，生产使用 dataDir() */
export function createSettingsStore(
  baseDir: string,
  options: SettingsStoreOptions = {},
): SettingsStore {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const filePath = path.join(baseDir, "config", "settings.json");
  let warnedFallback = false;

  async function resolveCrypto(): Promise<Crypto | null> {
    const crypto = options.crypto ?? (await resolveSharedCrypto());
    if (crypto && !encryptionAvailable(crypto) && !warnedFallback) {
      warnedFallback = true;
      warn("safeStorage 加密不可用，apiKey 将以明文存储");
    }
    return crypto;
  }

  async function load(): Promise<Settings> {
    const crypto = await resolveCrypto();
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`读取设置失败，已回退默认值: ${String(error)}`);
      }
      return cloneDefaults();
    }
    return mergeWithDefaults(raw, crypto, warn);
  }

  async function save(next: Settings): Promise<void> {
    const crypto = await resolveCrypto();
    const payload = `${JSON.stringify(toPersisted(next, crypto), null, 2)}\n`;
    await mkdir(path.dirname(filePath), { recursive: true });
    // 先写临时文件再 rename，避免中断时留下半截 JSON
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  }

  return { load, save };
}

// 动态加载避免 vitest（无 Electron 运行时）在 import 阶段失败；结果缓存一次
let sharedCrypto: Crypto | null | undefined;

async function resolveSharedCrypto(): Promise<Crypto | null> {
  if (sharedCrypto !== undefined) return sharedCrypto;
  try {
    const electron = await import("electron");
    const candidate = electron.safeStorage as Partial<Crypto> | undefined;
    sharedCrypto =
      candidate && typeof candidate.isEncryptionAvailable === "function"
        ? (candidate as Crypto)
        : null;
  } catch {
    sharedCrypto = null;
  }
  return sharedCrypto;
}

let defaultStore: SettingsStore | null = null;

/** 默认单例：数据目录来自 Electron userData，首次调用时才解析 */
export function getSettingsStore(): SettingsStore {
  defaultStore ??= createSettingsStore(dataDir());
  return defaultStore;
}

export async function loadSettings(): Promise<Settings> {
  return getSettingsStore().load();
}

export async function saveSettings(next: Settings): Promise<void> {
  return getSettingsStore().save(next);
}
