// providers 装配单测：只做纯装配断言，不发起任何网络请求。
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelEntry, ModelServiceConfig, Settings } from "@/shared/contracts/settings";
import { buildProviders, resolveModel, toPiModels } from "./providers";

/** 构造最小 Settings，避免引入 Electron 相关依赖 */
function makeSettings(services: ModelServiceConfig[]): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    defaultWorkingDir: null,
    services,
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    skillDirs: [],
    skillsEnabled: true,
    promptTemplateDirs: [],
    mcpServers: [],
    disabledSkillNames: [],
  };
}

/** 用默认值补齐服务配置，仅覆盖用例关心的字段 */
function makeService(overrides: Partial<ModelServiceConfig> & { id: string }): ModelServiceConfig {
  return {
    name: overrides.id,
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    wireFormat: "openai-completions",
    models: [],
    ...overrides,
  };
}

describe("toPiModels", () => {
  it("映射字段并补齐缺省值", () => {
    const service = makeService({
      id: "svc-a",
      name: "服务 A",
      wireFormat: "openai-responses",
      models: [
        {
          id: "m1",
          name: "模型一",
          contextWindow: 200000,
          maxTokens: 4096,
          reasoning: true,
          acceptsImages: true,
        },
        { id: "m2", reasoning: false },
      ],
    });

    const models = toPiModels(service);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "m1",
      name: "模型一",
      api: "openai-responses",
      provider: "svc-a",
      baseUrl: "https://api.test/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    // 未提供 name/reasoning/input/窗口参数时使用缺省值
    expect(models[1]).toMatchObject({
      id: "m2",
      name: "m2",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      // 未设置输出上限：maxTokens 为 0，pi-ai 会省略 max_tokens 交给服务端决定
      maxTokens: 0,
    });
  });

  it("空模型列表返回空数组", () => {
    expect(toPiModels(makeService({ id: "svc-empty" }))).toEqual([]);
  });

  it("maxTokens 超过上下文窗口时视为误填，改为不传递（0）", () => {
    const service = makeService({
      id: "svc-clamp",
      models: [{ id: "m", contextWindow: 128000, maxTokens: 9_000_000 }],
    });
    expect(toPiModels(service)[0]?.maxTokens).toBe(0);
  });

  it("maxTokens 未设置或小于 1 时为 0（不传递）", () => {
    const service = makeService({
      id: "svc-none",
      models: [{ id: "a" }, { id: "b", maxTokens: 0 }, { id: "c", maxTokens: -5 }],
    });
    for (const model of toPiModels(service)) {
      expect(model.maxTokens).toBe(0);
    }
  });

  it("maxTokens 合法时原样保留", () => {
    const service = makeService({
      id: "svc-keep",
      models: [{ id: "m", contextWindow: 1000000, maxTokens: 384000 }],
    });
    expect(toPiModels(service)[0]?.maxTokens).toBe(384000);
  });
});

describe("buildProviders", () => {
  it("分别为 completions / responses 适配器装配两个服务", () => {
    const settings = makeSettings([
      makeService({ id: "svc-a", models: [{ id: "ma" }] }),
      makeService({ id: "svc-b", wireFormat: "openai-responses", models: [{ id: "mb" }] }),
    ]);

    const bundle = buildProviders(settings);

    expect(bundle.providers.size).toBe(2);
    expect(bundle.models.getModel("svc-a", "ma")?.api).toBe("openai-completions");
    expect(bundle.models.getModel("svc-b", "mb")?.api).toBe("openai-responses");
    expect(bundle.models.getModel("svc-a", "mb")).toBeUndefined();
  });

  it("静默跳过无效服务", () => {
    const settings = makeSettings([
      makeService({ id: "svc-ok", models: [{ id: "m" }] }),
      makeService({ id: "svc-no-base", baseUrl: "   ", models: [{ id: "m" }] }),
      makeService({ id: "svc-no-models", models: [] }),
      makeService({ id: "   ", models: [{ id: "m" }] }),
    ]);

    const bundle = buildProviders(settings);

    expect(bundle.providers.size).toBe(1);
    expect(bundle.providers.has("svc-ok")).toBe(true);
    expect(bundle.models.getModel("svc-no-base", "m")).toBeUndefined();
  });

  it("apiKey 为空串时仍能装配并返回空密钥", async () => {
    const settings = makeSettings([
      makeService({ id: "svc-a", apiKey: "", models: [{ id: "m" }] }),
    ]);

    const bundle = buildProviders(settings);
    const ctx = { env: async () => undefined, fileExists: async () => false };
    const result = await bundle.providers
      .get("svc-a")
      ?.auth.apiKey?.resolve({ ctx, signal: new AbortController().signal });

    expect(result).toEqual({ auth: { apiKey: "" } });
  });

  it("无有效服务时返回空 bundle", () => {
    const bundle = buildProviders(makeSettings([]));

    expect(bundle.providers.size).toBe(0);
    expect(bundle.models.getModel("svc-a", "m")).toBeUndefined();
  });
});

describe("resolveModel", () => {
  const settings = makeSettings([
    makeService({
      id: "svc-a",
      models: [{ id: "m1", name: "模型一" }, { id: "m2" }],
    }),
    makeService({ id: "svc-bad", baseUrl: "", models: [{ id: "m1" }] }),
  ]);

  it("命中时返回对应 Model（不依赖 buildProviders 副作用）", () => {
    expect(resolveModel(settings, { serviceId: "svc-a", modelId: "m1" })).toMatchObject({
      id: "m1",
      name: "模型一",
      provider: "svc-a",
      api: "openai-completions",
      baseUrl: "https://api.test/v1",
    });
    expect(resolveModel(settings, { serviceId: "svc-a", modelId: "m2" })).toMatchObject({
      id: "m2",
    });
  });

  it("未命中时返回 undefined", () => {
    expect(resolveModel(settings, null)).toBeUndefined();
    expect(resolveModel(settings, { serviceId: "missing", modelId: "m1" })).toBeUndefined();
    expect(resolveModel(settings, { serviceId: "svc-a", modelId: "missing" })).toBeUndefined();
    expect(resolveModel(settings, { serviceId: "svc-bad", modelId: "m1" })).toBeUndefined();
  });
});

describe("思考档位 → thinkingLevelMap", () => {
  const service = (entry: ModelEntry): ModelServiceConfig => ({
    id: "svc",
    name: "服务",
    baseUrl: "https://api.test/v1",
    apiKey: "",
    wireFormat: "openai-completions",
    models: [entry],
  });

  it("配过的档位写 undefined（用 provider 默认），没勾的写 null（明确不支持）", () => {
    const [model] = toPiModels(service({ id: "m", thinkingLevels: ["off", "medium", "high"] }));
    expect(model?.thinkingLevelMap).toEqual({
      off: undefined,
      minimal: null,
      low: null,
      medium: undefined,
      high: undefined,
    });
  });

  it("没配过（undefined）→ 不生成 map，让内核按 provider 默认处理", () => {
    expect(toPiModels(service({ id: "m" }))[0]?.thinkingLevelMap).toBeUndefined();
  });

  it("空数组同样视为「没有信息」→ 不生成 map", () => {
    expect(
      toPiModels(service({ id: "m", thinkingLevels: [] }))[0]?.thinkingLevelMap,
    ).toBeUndefined();
  });

  it("acceptsImages → pi-ai 的 input 列表", () => {
    expect(toPiModels(service({ id: "m", acceptsImages: true }))[0]?.input).toEqual([
      "text",
      "image",
    ]);
    expect(toPiModels(service({ id: "m" }))[0]?.input).toEqual(["text"]);
    expect(toPiModels(service({ id: "m", acceptsImages: false }))[0]?.input).toEqual(["text"]);
  });
});

describe("档位真的会作用于请求（用内核自己的 clamp 验证）", () => {
  const service = (entry: ModelEntry): ModelServiceConfig => ({
    id: "svc",
    name: "服务",
    baseUrl: "https://api.test/v1",
    apiKey: "",
    wireFormat: "openai-completions",
    models: [entry],
  });

  it("用户只勾了 off/medium → 要 high 时内核降到 medium（而不是照发 high）", () => {
    const [model] = toPiModels(
      service({ id: "m", reasoning: true, thinkingLevels: ["off", "medium"] }),
    );
    expect(model).toBeDefined();
    // 内核请求阶段就是这么取档位的（openai-completions 的 streamSimple 里是同一个调用）
    expect(clampThinkingLevel(model as Model<Api>, "high")).toBe("medium");
    expect(clampThinkingLevel(model as Model<Api>, "medium")).toBe("medium");
    expect(clampThinkingLevel(model as Model<Api>, "low")).toBe("medium");
    expect(clampThinkingLevel(model as Model<Api>, "off")).toBe("off");
  });

  it("非推理模型：任何档位都被降成 off（不会把 reasoning 发给不支持的服务）", () => {
    const [model] = toPiModels(service({ id: "m", reasoning: false, thinkingLevels: ["off"] }));
    expect(clampThinkingLevel(model as Model<Api>, "high")).toBe("off");
  });

  it("没配档位表的推理模型：五档都照原样（交给 provider 默认）", () => {
    const [model] = toPiModels(service({ id: "m", reasoning: true }));
    expect(model?.thinkingLevelMap).toBeUndefined();
    expect(clampThinkingLevel(model as Model<Api>, "high")).toBe("high");
    expect(clampThinkingLevel(model as Model<Api>, "minimal")).toBe("minimal");
  });
});
