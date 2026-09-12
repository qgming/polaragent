import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import { ALL_THINKING_LEVELS, type ThinkingLevel } from "@/shared/contracts/common";
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
  skillDirs: [],
  disabledSkillNames: [],
  skillsEnabled: true,
  promptTemplateDirs: [],
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
    permissionMode: normalizePermissionMode(raw.permissionMode),
    language: normalizeLanguage(raw.language),
    services: normalizeServices(raw.services, crypto, warn),
    skillDirs: Array.isArray(raw.skillDirs)
      ? raw.skillDirs.filter((dir) => typeof dir === "string")
      : base.skillDirs,
    disabledSkillNames: Array.isArray(raw.disabledSkillNames)
      ? raw.disabledSkillNames.filter((name) => typeof name === "string")
      : base.disabledSkillNames,
    // 布尔字段必须显式校验：上面按 Object.keys 的透传会把任意类型原样带进来
    skillsEnabled: typeof raw.skillsEnabled === "boolean" ? raw.skillsEnabled : base.skillsEnabled,
    promptTemplateDirs: Array.isArray(raw.promptTemplateDirs)
      ? raw.promptTemplateDirs.filter((dir) => typeof dir === "string")
      : base.promptTemplateDirs,
  };
}

function normalizeModelRef(raw: unknown): Settings["defaultModel"] {
  if (!isRecord(raw)) return null;
  const { serviceId, modelId } = raw;
  if (typeof serviceId !== "string" || typeof modelId !== "string") return null;
  return { serviceId, modelId };
}

/** 审批模式容错：非法取值一律回落到 default（安全侧弹卡询问） */
function normalizePermissionMode(raw: unknown): Settings["permissionMode"] {
  return raw === "ai_review" || raw === "full" ? raw : "default";
}

/** 语言容错：非法取值回落到默认语言（提示词、占位文案都按它索引） */
function normalizeLanguage(raw: unknown): Settings["language"] {
  return raw === "en-US" ? "en-US" : "zh-CN";
}

function normalizeServices(raw: unknown, crypto: Crypto | null, warn: Warn): ModelServiceConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => ({
    id: asString(item.id),
    name: asString(item.name),
    baseUrl: asString(item.baseUrl),
    wireFormat: item.wireFormat === "openai-responses" ? "openai-responses" : "openai-completions",
    models: normalizeModelEntries(item.models),
    apiKey: decodeApiKey(item.apiKey, crypto, warn),
  }));
}

/** 只接受有限正数；其余（字符串、NaN、0、负数）视为未设置 */
function asOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 校验思考档位：只留本仓五档、去重、按强弱顺序排好；空数组视为「没有信息」（undefined）。
 *
 * 顺序必须归一：档位列表要参与「就近降级」的比较，留着用户在磁盘上写乱的顺序会让结果
 * 依赖文件内容而不是规则。
 */
function normalizeThinkingLevels(value: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = ALL_THINKING_LEVELS.filter((level) => value.includes(level));
  return levels.length > 0 ? [...levels] : undefined;
}

/**
 * 模型条目归一化。除了剔除非法的数字/布尔，还负责一次**字段迁移**：
 *
 * 旧版本用 `input: ("text"|"image")[]` 存模态，现在只留一个 `acceptsImages` 布尔。
 * 老设置文件里没有 acceptsImages 但有 input 时，按「列表里有没有 image」还原 ——
 * 不迁移的话用户之前勾的图片支持会在升级后静默丢失（变成「跟随目录」）。
 */
function normalizeModelEntries(raw: unknown): ModelServiceConfig["models"] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => {
    const entry: ModelServiceConfig["models"][number] = { id: asString(item.id) };
    const name = typeof item.name === "string" ? item.name : "";
    if (name !== "") entry.name = name;
    const contextWindow = asOptionalPositiveNumber(item.contextWindow);
    if (contextWindow !== undefined) entry.contextWindow = contextWindow;
    const maxTokens = asOptionalPositiveNumber(item.maxTokens);
    if (maxTokens !== undefined) entry.maxTokens = maxTokens;
    if (typeof item.reasoning === "boolean") entry.reasoning = item.reasoning;

    const acceptsImages =
      typeof item.acceptsImages === "boolean"
        ? item.acceptsImages
        : Array.isArray(item.input)
          ? item.input.includes("image")
          : undefined;
    if (acceptsImages !== undefined) entry.acceptsImages = acceptsImages;

    const thinkingLevels = normalizeThinkingLevels(item.thinkingLevels);
    if (thinkingLevels !== undefined) entry.thinkingLevels = thinkingLevels;
    return entry;
  });
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
  const filePath = path.join(baseDir, "settings.json");
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

/** 默认单例：设置文件位于数据根（~/.oint 或 OINT_HOME 指定的目录），首次调用时才解析 */
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
