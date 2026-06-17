import { describe, expect, it } from "vitest";

import { normalizeCandidate, parseMemoryCandidates } from "./memory-capture";

describe("memory capture helpers", () => {
  it("parses JSON array candidates from raw model output", () => {
    expect(
      parseMemoryCandidates('[{"scope":"global","type":"preference","content":"用户喜欢简洁回答","confidence":0.9}]'),
    ).toHaveLength(1);
  });

  it("returns an empty list for invalid JSON", () => {
    expect(parseMemoryCandidates("not json")).toEqual([]);
  });

  it("downgrades project scope when no project context is allowed", () => {
    const candidate = normalizeCandidate(
      {
        scope: "project",
        type: "project",
        content: "项目使用 Vite 和 Electron。",
        confidence: 0.8,
      },
      { allowProject: false },
    );

    expect(candidate?.scope).toBe("global");
    expect(candidate?.type).toBe("project");
  });

  it("normalizes unknown types by scope", () => {
    const candidate = normalizeCandidate(
      {
        scope: "project",
        type: "unknown",
        content: "项目源码在 src 目录。",
      },
      { allowProject: true },
    );

    expect(candidate?.type).toBe("project");
  });
});
