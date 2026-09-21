// IPC 探测通道的参数校验与结果形状。
//
// 只测**纯逻辑**（parseTestRequest / testProvider 的错误路径）——
// 真正的网络探测由 scripts/probe-searxng.mts 与 probe-web.mts 覆盖，
// 这里不该打网络（否则单测会因实例限流而 flaky）。

import { describe, expect, it } from "vitest";
import { __testing } from "./web";

const { parseTestRequest } = __testing;

describe("parseTestRequest", () => {
  it("接受合法的请求并保留 apiKey", () => {
    const parsed = parseTestRequest({
      provider: "tavily",
      config: { apiKey: "tvly-x", searchDepth: "advanced", includeAnswer: true },
    });
    expect(parsed).toEqual({
      provider: "tavily",
      config: { apiKey: "tvly-x", searchDepth: "advanced", includeAnswer: true },
    });
  });

  it("searxng 的 instances 被保留", () => {
    const parsed = parseTestRequest({
      provider: "searxng",
      config: { apiKey: "", instances: "https://mine.test" },
    });
    expect(parsed?.config.instances).toBe("https://mine.test");
  });

  it("拒绝未知 provider", () => {
    expect(parseTestRequest({ provider: "openai", config: { apiKey: "x" } })).toBeUndefined();
  });

  it("拒绝非对象 / 缺字段的请求（IPC 边界要自己守住）", () => {
    expect(parseTestRequest(null)).toBeUndefined();
    expect(parseTestRequest("string")).toBeUndefined();
    expect(parseTestRequest({})).toBeUndefined();
    expect(parseTestRequest({ provider: "tavily" })).toBeUndefined();
    expect(parseTestRequest({ provider: "tavily", config: null })).toBeUndefined();
  });

  it("apiKey 非字符串时回空串（而不是把非法值透传下去）", () => {
    const parsed = parseTestRequest({ provider: "tavily", config: { apiKey: 123 } });
    expect(parsed?.config.apiKey).toBe("");
  });

  it("丢弃类型不对的可选字段", () => {
    const parsed = parseTestRequest({
      provider: "tavily",
      config: {
        apiKey: "k",
        searchDepth: "turbo", // 非法枚举
        includeAnswer: "yes", // 非布尔
        instances: 42, // 非字符串
      },
    });
    expect(parsed?.config).toEqual({ apiKey: "k" });
  });

  it("保留各 provider 的专属字段", () => {
    expect(
      parseTestRequest({ provider: "serper", config: { apiKey: "k", gl: "cn", hl: "zh-cn" } })
        ?.config,
    ).toEqual({ apiKey: "k", gl: "cn", hl: "zh-cn" });
    expect(
      parseTestRequest({ provider: "brave", config: { apiKey: "k", country: "CN" } })?.config,
    ).toEqual({ apiKey: "k", country: "CN" });
    expect(
      parseTestRequest({ provider: "exa", config: { apiKey: "k", type: "keyword" } })?.config,
    ).toEqual({ apiKey: "k", type: "keyword" });
  });
});
