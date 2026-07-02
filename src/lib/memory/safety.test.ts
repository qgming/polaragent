import { describe, expect, it } from "vitest";

import { normalizeMemoryJsonText } from "./safety";

describe("memory safety helpers", () => {
  it("extracts a JSON array from fenced model output", () => {
    expect(
      normalizeMemoryJsonText('```json\n[{"content":"用户偏好中文"}]\n```'),
    ).toBe('[{"content":"用户偏好中文"}]');
  });
});
