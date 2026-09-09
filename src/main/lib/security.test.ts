import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnvironmentMode = process.env.POLARAGENT_SECURITY_MODE;

beforeEach(() => {
  vi.resetModules();
  delete process.env.POLARAGENT_SECURITY_MODE;
});

afterEach(() => {
  if (originalEnvironmentMode === undefined) {
    delete process.env.POLARAGENT_SECURITY_MODE;
  } else {
    process.env.POLARAGENT_SECURITY_MODE = originalEnvironmentMode;
  }
});

describe("security mode validation", () => {
  it("rejects an invalid runtime mode instead of falling through to full access", async () => {
    const security = await import("./security");

    expect(() => security.setSecurityMode("invalid")).toThrow("无效的安全模式");
    expect(security.getSecurityMode()).toBe("ai_review");
  });

  it("ignores an invalid environment mode", async () => {
    process.env.POLARAGENT_SECURITY_MODE = "invalid";
    const security = await import("./security");

    expect(security.getSecurityMode()).toBe("ai_review");
  });

  it("accepts each supported runtime mode", async () => {
    const security = await import("./security");

    for (const mode of ["readonly", "safe", "ai_review", "full"] as const) {
      security.setSecurityMode(mode);
      expect(security.getSecurityMode()).toBe(mode);
    }
  });
});

describe("critical path matching", () => {
  it("does not treat a sibling with the same prefix as a critical path", async () => {
    const { isSystemCriticalPath } = await import("./security");

    if (process.platform === "win32") {
      expect(isSystemCriticalPath("C:\\Windows.old")).toBe(false);
      expect(isSystemCriticalPath("C:\\Windows\\System32")).toBe(true);
    } else {
      expect(isSystemCriticalPath("/usr-local")).toBe(false);
      expect(isSystemCriticalPath("/usr/local")).toBe(true);
    }
  });
});

describe("shell and file policy", () => {
  it("readonly mode blocks shell and write", async () => {
    const security = await import("./security");
    security.setSecurityMode("readonly");
    expect(security.validateShellCommand("ls").allowed).toBe(false);
    expect(security.validateFileAccess("C:\\temp\\a.txt", "write").allowed).toBe(false);
    expect(security.validateFileAccess("C:\\temp\\a.txt", "read").allowed).toBe(true);
  });

  it("safe mode blocks dangerous shell patterns", async () => {
    const security = await import("./security");
    security.setSecurityMode("safe");
    const result = security.validateShellCommand("rm -rf /");
    expect(result.allowed).toBe(false);
  });

  it("validateExternalAccess rejects non http/https/file protocols", async () => {
    const security = await import("./security");
    security.setSecurityMode("ai_review");
    expect(security.validateExternalAccess("https://example.com").allowed).toBe(true);
    expect(security.validateExternalAccess("javascript:alert(1)").allowed).toBe(false);
  });
});
