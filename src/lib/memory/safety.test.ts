import { describe, expect, it } from "vitest";

import { hasSensitiveMemoryContent, normalizeMemoryJsonText } from "./safety";

describe("memory safety helpers", () => {
  it("detects obvious secrets and tokens", () => {
    expect(hasSensitiveMemoryContent("apiKey = sk-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(hasSensitiveMemoryContent("password: abcdefghijklmnop")).toBe(true);
  });

  it("does not flag ordinary preferences", () => {
    expect(hasSensitiveMemoryContent("用户喜欢简洁中文回复。")).toBe(false);
  });

  it("extracts a JSON array from fenced model output", () => {
    expect(
      normalizeMemoryJsonText('```json\n[{"content":"用户偏好中文"}]\n```'),
    ).toBe('[{"content":"用户偏好中文"}]');
  });
});
