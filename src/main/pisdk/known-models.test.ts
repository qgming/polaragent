/**
 * pi-ai 标准目录的读取与档位判定。
 *
 * 分两层测：
 * - 纯函数层用**手搓的模型对象**驱动，把 thinkingLevelMap 的几种形态钉死（这是档位语义的
 *   唯一依据，也是本功能最容易出错的地方）；
 * - 末尾几条走**真实目录**，验证 pi-ai 的 `providers/all` 枚举出的每个 provider 都真的进了
 *   索引 —— 那正是「依赖升级新增/改动了 provider 目录」这类事故的唯一探测手段。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
  buildKnownModelIndex,
  knownCapabilities,
  knownModelCount,
  knownModelKeys,
  knownSupportsImages,
  knownThinkingLevels,
  matchInKnownIndex,
  matchKnownModel,
  providerCatalogCount,
} from "./known-models";

/** 造一个最小可用的 pi-ai 模型 */
function model(over: Partial<Model<Api>> & { id: string }): Model<Api> {
  return {
    name: over.id,
    api: "openai-completions",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    ...over,
  } as Model<Api>;
}

describe("knownThinkingLevels（档位判定交给内核）", () => {
  it("reasoning=false → 只有关闭", () => {
    expect(knownThinkingLevels(model({ id: "a", reasoning: false }))).toEqual(["off"]);
  });

  it("reasoning=true 但没有档位表 → 五档全给（内核的默认行为）", () => {
    expect(knownThinkingLevels(model({ id: "b" }))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("档位表里 off: null → 关不掉思考，列表里没有 off", () => {
    const levels = knownThinkingLevels(
      model({ id: "c", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }),
    );
    expect(levels).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("档位表把 high 标成 null → high 不在列表里（用户看得见这个限制）", () => {
    expect(knownThinkingLevels(model({ id: "d", thinkingLevelMap: { high: null } }))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
    ]);
  });

  it("xhigh / max 不进用户可选档位（本仓只暴露五档）", () => {
    const levels = knownThinkingLevels(
      model({ id: "e", thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
    );
    expect(levels).toEqual(["off", "minimal", "low", "medium", "high"]);
  });
});

describe("knownSupportsImages", () => {
  it("看 pi-ai 的 input", () => {
    expect(knownSupportsImages(model({ id: "f", input: ["text", "image"] }))).toBe(true);
    expect(knownSupportsImages(model({ id: "g", input: ["text"] }))).toBe(false);
  });
});

describe("knownModelKeys / matchInKnownIndex", () => {
  const index = buildKnownModelIndex([
    model({ id: "claude-opus-4-5", provider: "anthropic", name: "Claude Opus 4.5" }),
  ]);

  it("键包含小写 id、provider/id 与两种归一化形式", () => {
    const keys = knownModelKeys(model({ id: "Claude-Opus-4.5", provider: "Anthropic" }));
    expect(keys).toContain("claude-opus-4.5");
    expect(keys).toContain("anthropic/claude-opus-4.5");
    expect(keys).toContain("claudeopus45");
  });

  it("原样 id、带 provider、写法有差异（点/下划线）都能命中", () => {
    expect(matchInKnownIndex(index, "claude-opus-4-5")?.name).toBe("Claude Opus 4.5");
    expect(matchInKnownIndex(index, "anthropic/claude-opus-4-5")?.id).toBe("claude-opus-4-5");
    expect(matchInKnownIndex(index, "claude_opus_4_5")?.id).toBe("claude-opus-4-5");
  });

  it("空输入与不认识的 id → null", () => {
    expect(matchInKnownIndex(index, "   ")).toBeNull();
    expect(matchInKnownIndex(index, "no-such-model")).toBeNull();
  });

  it("同名模型冲突时：带档位表的顶掉不带的（我们正是为了档位才查目录）", () => {
    const withMap = model({ id: "same", provider: "p1", thinkingLevelMap: { high: null } });
    const withoutMap = model({ id: "same", provider: "p2" });
    const noMapFirst = buildKnownModelIndex([withoutMap, withMap]);
    expect(matchInKnownIndex(noMapFirst, "same")?.thinkingLevelMap).toEqual({ high: null });

    // 反过来（先有 map）也保持有 map 的那份，不会被后者顶掉
    const mapFirst = buildKnownModelIndex([withMap, withoutMap]);
    expect(matchInKnownIndex(mapFirst, "same")?.thinkingLevelMap).toEqual({ high: null });
  });
});

describe("knownCapabilities", () => {
  it("摘出能力快照，input 收窄到 text/image", () => {
    const caps = knownCapabilities(
      model({ id: "h", input: ["text", "image"], thinkingLevelMap: { off: null } }),
    );
    expect(caps.id).toBe("h");
    expect(caps.input).toEqual(["text", "image"]);
    expect(caps.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
    expect(caps.hasThinkingMap).toBe(true);
  });

  it("没有档位表时 hasThinkingMap=false，档位退化成 [off]（上层据此按 reasoning 推断）", () => {
    const caps = knownCapabilities(model({ id: "i", reasoning: false }));
    expect(caps.hasThinkingMap).toBe(false);
    expect(caps.thinkingLevels).toEqual(["off"]);
  });
});

describe("真实目录（防「子路径失效」这类事故）", () => {
  it("能加载全部 provider 目录并匹配到已知模型", async () => {
    const hit = await matchKnownModel("claude-opus-4-5");
    expect(hit).not.toBeNull();
    expect(hit?.input).toContain("image");
    // 这个模型目录里没带档位表：档位走内核默认（reasoning=true → 五档全给）
    expect(knownThinkingLevels(hit as Model<Api>)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  }, 30000);

  it("带档位表的模型：null 档位被正确排除（off 关不掉思考）", async () => {
    const hit = await matchKnownModel("claude-fable-5");
    expect(hit).not.toBeNull();
    const caps = knownCapabilities(hit as Model<Api>);
    expect(caps.hasThinkingMap).toBe(true);
    expect(caps.thinkingLevels).not.toContain("off");
    expect(caps.thinkingLevels).toContain("high");
  }, 30000);

  it("provider/id 形式与大小写差异同样能命中", async () => {
    expect(await matchKnownModel("anthropic/claude-opus-4-5")).not.toBeNull();
    expect(await matchKnownModel("Claude-Opus-4-5")).not.toBeNull();
  }, 30000);

  it("目录覆盖全部内置 provider：每个 provider 的每个模型都能匹配到", async () => {
    // provider 清单直接来自 pi-ai 的 providers/all，数量与上游一致（升级新增 provider 自动跟上）
    expect(await providerCatalogCount()).toBe(getBuiltinProviders().length);
    // 索引里的键含 provider/id 与归一化形式，数量是模型数的数倍；
    // 用下限兜住「少加载了几个 provider」这种静默退化
    expect(await knownModelCount()).toBeGreaterThan(2000);

    /**
     * 逐条反查：任何一个 provider 目录没进索引，它下面的模型就一条都匹配不到。
     *
     * 这条断言是手写清单被删掉之后**唯一**的守卫 —— 以前漏一个子路径只会少几百个模型、
     * 不报任何错，现在至少在这里会红。索引加载一次即缓存，逐条走 matchKnownModel 不重复解析。
     */
    const unreachable: string[] = [];
    for (const provider of getBuiltinProviders()) {
      for (const model of getBuiltinModels(provider)) {
        if ((await matchKnownModel(`${provider}/${model.id}`)) === null) {
          unreachable.push(`${provider}/${model.id}`);
        }
      }
    }
    expect(unreachable).toEqual([]);
  }, 60000);

  it("列表靠后的 provider 同样被加载（漏掉尾部不会报错，只能靠断言发现）", async () => {
    // zai-coding-cn 在表的前段；amazon-bedrock 在表尾（id 带点与冒号，顺带覆盖归一化匹配）
    expect(await matchKnownModel("zai-coding-cn/glm-5.3")).not.toBeNull();
    expect(await matchKnownModel("amazon-bedrock/anthropic.claude-fable-5")).not.toBeNull();
  }, 30000);
});
