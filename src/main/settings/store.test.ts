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
  baseDir = await mkdtemp(path.join(os.tmpdir(), "polaragent-settings-"));
  settingsFile = path.join(baseDir, "config", "settings.json");
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
