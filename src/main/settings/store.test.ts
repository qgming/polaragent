import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/shared/contracts/settings";
import { type Crypto, createSettingsStore, DEFAULT_SETTINGS } from "./store";

// 假加密：密文带前缀，便于断言"文件不含明文"
const fakeCrypto: Crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`cipher:${plain}`, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8").replace(/^cipher:/, ""),
};

const unavailableCrypto: Crypto = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("不应调用加密");
  },
  decryptString: () => {
    throw new Error("不应调用解密");
  },
};

function sampleSettings(apiKey: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    theme: "dark",
    services: [
      {
        id: "svc-1",
        name: "测试服务",
        baseUrl: "https://api.test/v1",
        apiKey,
        wireFormat: "openai-completions",
        models: [{ id: "m1" }],
      },
    ],
  };
}

let baseDir: string;
let settingsFile: string;

async function writeRawSettings(content: unknown): Promise<void> {
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(content, null, 2), "utf8");
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "oint-settings-"));
  settingsFile = path.join(baseDir, "settings.json");
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("文件缺失时返回完整默认值", async () => {
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("与默认值合并，缺失字段自动兜底", async () => {
    await writeRawSettings({ theme: "dark" });
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    const loaded = await store.load();
    expect(loaded.theme).toBe("dark");
    expect(loaded.language).toBe(DEFAULT_SETTINGS.language);
    expect(loaded.services).toEqual([]);
  });

  it("文件损坏时回退默认值且不抛错", async () => {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, "{ 不是合法 JSON", "utf8");
    const warn = vi.fn();
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
  });

  it("旧格式明文 apiKey 保持可读", async () => {
    // sampleSettings 直接产出字符串 apiKey，即旧版明文格式
    await writeRawSettings(sampleSettings("sk-legacy"));
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    const loaded = await store.load();
    expect(loaded.services[0]?.apiKey).toBe("sk-legacy");
  });
});

describe("saveSettings", () => {
  it("自动创建 config 目录，保存后可完整读回", async () => {
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    const settings = sampleSettings("sk-roundtrip");
    await store.save(settings);
    const loaded = await store.load();
    expect(loaded).toEqual(settings);
  });

  it("加密可用时 apiKey 加密落盘，文件不含明文", async () => {
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    await store.save(sampleSettings("sk-secret"));

    const raw = await readFile(settingsFile, "utf8");
    expect(raw).not.toContain("sk-secret");
    const parsed = JSON.parse(raw) as { services?: { apiKey?: unknown }[] };
    expect(parsed.services?.[0]?.apiKey).toMatchObject({
      v: 1,
      enc: true,
      data: expect.any(String),
    });

    const loaded = await store.load();
    expect(loaded.services[0]?.apiKey).toBe("sk-secret");
  });

  it("加密不可用时回退明文存储并告警", async () => {
    const warn = vi.fn();
    const store = createSettingsStore(baseDir, { crypto: unavailableCrypto, warn });
    await store.save(sampleSettings("sk-plain"));

    const raw = await readFile(settingsFile, "utf8");
    expect(raw).toContain("sk-plain");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("明文"));

    const loaded = await store.load();
    expect(loaded.services[0]?.apiKey).toBe("sk-plain");
  });

  it("未注入 crypto 时可读回（vitest 下自动回退明文）", async () => {
    const store = createSettingsStore(baseDir, { warn: () => {} });
    await store.save(sampleSettings("sk-env"));
    const loaded = await store.load();
    expect(loaded.services[0]?.apiKey).toBe("sk-env");
  });

  it("加密数据在无解密能力时置空并告警", async () => {
    await writeRawSettings({
      services: [
        {
          id: "svc-1",
          name: "测试服务",
          baseUrl: "https://api.test/v1",
          apiKey: { v: 1, enc: true, data: Buffer.from("cipher:x").toString("base64") },
          wireFormat: "openai-completions",
          models: [],
        },
      ],
    });
    const warn = vi.fn();
    const store = createSettingsStore(baseDir, { crypto: unavailableCrypto, warn });
    const loaded = await store.load();
    expect(loaded.services[0]?.apiKey).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("无法解密"));
  });
});

/** 审批模式与语言：写入后可完整读回，坏数据有兜底 */
describe("审批模式与语言", () => {
  it("非默认的 permissionMode 可完整往返", async () => {
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    const settings: Settings = {
      ...sampleSettings("sk-mode"),
      permissionMode: "ai_review",
    };
    await store.save(settings);
    const loaded = await store.load();
    expect(loaded.permissionMode).toBe("ai_review");
  });

  it("非法 permissionMode / language 回落到默认值", async () => {
    // 手改坏的 settings.json：模式与语言都是非法取值
    await writeRawSettings({ permissionMode: "yolo", language: "fr-FR" });
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    const loaded = await store.load();
    expect(loaded.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
    expect(loaded.language).toBe(DEFAULT_SETTINGS.language);
  });

  it("旧版本残留的提示词字段被忽略，重新保存后不再落盘", async () => {
    // 旧版 settings.json：顶层就是完整设置，多出两个已移除的提示词字段
    await writeRawSettings({
      ...sampleSettings("sk-legacy-prompt"),
      aiApprovalPrompt: "旧的自定义审批提示词",
      aiTitlePrompt: "旧的自定义命名提示词",
    });
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    const loaded = await store.load();
    expect(loaded).not.toHaveProperty("aiApprovalPrompt");
    expect(loaded).not.toHaveProperty("aiTitlePrompt");
    // 有效字段照旧读回，不被残留字段带偏
    expect(loaded.services[0]?.apiKey).toBe("sk-legacy-prompt");

    await store.save(loaded);
    const raw = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("aiApprovalPrompt");
    expect(raw).not.toHaveProperty("aiTitlePrompt");
  });
});

describe("模型条目的校验与迁移", () => {
  /** 写一份只含必要结构的设置文件，services 用给定的模型条目 */
  async function loadWithModels(models: unknown[]): Promise<Settings> {
    await writeRawSettings({
      ...DEFAULT_SETTINGS,
      services: [
        {
          id: "svc-1",
          name: "服务",
          baseUrl: "https://api.test/v1",
          apiKey: "sk-plain",
          wireFormat: "openai-completions",
          models,
        },
      ],
    });
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    return store.load();
  }

  it("旧版本的 input 列表迁移成 acceptsImages（升级不该悄悄丢掉用户的图片设置）", async () => {
    const loaded = await loadWithModels([
      { id: "with-image", input: ["text", "image"] },
      { id: "text-only", input: ["text"] },
    ]);
    const models = loaded.services[0]?.models ?? [];
    expect(models[0]?.acceptsImages).toBe(true);
    expect(models[1]?.acceptsImages).toBe(false);
    // 迁移后不再保留旧字段
    expect(models[0]).not.toHaveProperty("input");
  });

  it("acceptsImages 优先于旧 input（两者同时存在且矛盾时）", async () => {
    const loaded = await loadWithModels([
      { id: "m", acceptsImages: false, input: ["text", "image"] },
    ]);
    expect(loaded.services[0]?.models[0]?.acceptsImages).toBe(false);
  });

  it("未配能力项时保持 undefined（表示「跟随目录」，而不是 false）", async () => {
    const loaded = await loadWithModels([{ id: "m" }]);
    const model = loaded.services[0]?.models[0];
    expect(model?.acceptsImages).toBeUndefined();
    expect(model?.thinkingLevels).toBeUndefined();
    expect(model).not.toHaveProperty("input");
  });

  it("思考档位：滤掉未知值、去重、按强弱排序；空数组/非数组视为未配置", async () => {
    const loaded = await loadWithModels([
      { id: "a", thinkingLevels: ["high", "off", "high", "nonsense", "medium"] },
      { id: "b", thinkingLevels: [] },
      { id: "c", thinkingLevels: "high" },
      { id: "d", thinkingLevels: ["nonsense"] },
    ]);
    const models = loaded.services[0]?.models ?? [];
    expect(models[0]?.thinkingLevels).toEqual(["off", "medium", "high"]);
    expect(models[1]?.thinkingLevels).toBeUndefined();
    expect(models[2]?.thinkingLevels).toBeUndefined();
    expect(models[3]?.thinkingLevels).toBeUndefined();
  });

  it("数字字段非法时丢弃（字符串、NaN、0、负数）", async () => {
    const loaded = await loadWithModels([
      { id: "m", contextWindow: "200000", maxTokens: Number.NaN },
      { id: "n", contextWindow: -1, maxTokens: 0 },
    ]);
    const models = loaded.services[0]?.models ?? [];
    expect(models[0]?.contextWindow).toBeUndefined();
    expect(models[0]?.maxTokens).toBeUndefined();
    expect(models[1]?.contextWindow).toBeUndefined();
    expect(models[1]?.maxTokens).toBeUndefined();
  });

  it("存盘往返后未配置的字段不落盘（「恢复目录值」才生效）", async () => {
    const loaded = await loadWithModels([{ id: "m", acceptsImages: true }]);
    const store = createSettingsStore(baseDir, { crypto: fakeCrypto, warn: () => {} });
    await store.save(loaded);
    const raw = JSON.parse(await readFile(settingsFile, "utf8")) as {
      services: { models: Record<string, unknown>[] }[];
    };
    const saved = raw.services[0]?.models[0];
    expect(saved?.acceptsImages).toBe(true);
    expect(saved).not.toHaveProperty("thinkingLevels");
  });
});
