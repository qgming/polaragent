import { describe, expect, it } from "vitest";

import { errorMessage, normalizeBaseUrl, normalizeWebUrl } from "./http-utils";

describe("normalizeBaseUrl", () => {
  it("appends /v1 when missing", () => {
    expect(normalizeBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
  });

  it("keeps existing /v1 and strips trailing slash", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("rejects empty", () => {
    expect(() => normalizeBaseUrl("")).toThrow("Base URL 不能为空");
  });
});

describe("normalizeWebUrl", () => {
  it("prefixes https when protocol missing", () => {
    expect(normalizeWebUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("keeps http", () => {
    expect(normalizeWebUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects empty", () => {
    expect(() => normalizeWebUrl("   ")).toThrow("url 不能为空");
  });
});

describe("errorMessage", () => {
  it("prefers nested error.message", () => {
    expect(errorMessage({ error: { message: "boom" } })).toBe("boom");
  });

  it("falls back to message then default", () => {
    expect(errorMessage({ message: "m" })).toBe("m");
    expect(errorMessage(null)).toBe("服务返回错误");
  });
});
