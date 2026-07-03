import { describe, expect, it } from "vitest";

import { buildScheduledAgentMessage, resolveScheduledWorkingDir } from "./prompt";

describe("buildScheduledAgentMessage", () => {
  it("returns the original message when no context dirs are provided", () => {
    expect(buildScheduledAgentMessage({ kind: "agentTurn", message: "run report" })).toBe("run report");
  });

  it("prepends normalized context directories when provided", () => {
    const message = buildScheduledAgentMessage({
      kind: "agentTurn",
      message: "run report",
      contextDirs: ["  D:/repo ", "D:/repo/docs"],
    });

    expect(message).toContain("Scheduled run context:");
    expect(message).toContain("- D:/repo");
    expect(message).toContain("- D:/repo/docs");
    expect(message.endsWith("run report")).toBe(true);
  });
});

describe("resolveScheduledWorkingDir", () => {
  it("prefers explicit workingDir", () => {
    expect(resolveScheduledWorkingDir({ kind: "agentTurn", message: "x", workingDir: "D:/repo/app" }, "D:/fallback")).toBe("D:/repo/app");
  });

  it("falls back to the first context dir before fallback dir", () => {
    expect(resolveScheduledWorkingDir({ kind: "agentTurn", message: "x", contextDirs: [" D:/repo ", "D:/repo/docs"] }, "D:/fallback")).toBe("D:/repo");
  });

  it("uses fallback dir when neither workingDir nor contextDirs are provided", () => {
    expect(resolveScheduledWorkingDir({ kind: "agentTurn", message: "x" }, "D:/fallback")).toBe("D:/fallback");
  });
});
