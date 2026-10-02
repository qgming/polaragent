import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import { stdioOptions } from "./launch-policy";

const config: McpServerConfig = {
  id: "test",
  name: "test",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "server"],
  env: {},
  cwd: "",
  url: "",
  headers: {},
  createdAt: 0,
};
afterEach(() => vi.unstubAllEnvs());

describe("native MCP launch policy", () => {
  it("disables upstream environment inheritance and passes only allowlisted and explicit values", () => {
    vi.stubEnv("OINT_TEST_PRIVATE_TOKEN", "must-not-leak");
    const options = stdioOptions(
      { ...config, env: { EXPLICIT_TOKEN: "provided" } },
      () => {},
      "linux",
    );
    expect(options.inheritEnv).toBe(false);
    expect(options.env?.OINT_TEST_PRIVATE_TOKEN).toBeUndefined();
    expect(options.env?.EXPLICIT_TOKEN).toBe("provided");
    expect(options.args).toEqual(config.args);
  });

  it("rejects cmd expansion characters for both explicit and PATH-resolved Windows shims", () => {
    for (const command of ["npx", "npx.cmd", "tool.bat"]) {
      for (const arg of ["%PATH%", "!TOKEN!", "a&b", "a|b", "a<b", "a>b", "a^b", 'a"b', "a\nb"]) {
        expect(() => stdioOptions({ ...config, command, args: [arg] }, () => {}, "win32")).toThrow(
          "cmd",
        );
      }
    }
  });

  it("preserves native executable arguments and paths with spaces", () => {
    const args = ["C:\\Program Files\\server.mjs", "a&b"];
    expect(stdioOptions({ ...config, command: "node.exe", args }, () => {}, "win32").args).toEqual(
      args,
    );
    expect(
      stdioOptions(
        { ...config, command: "tool.cmd", args: ["C:\\Program Files\\server.mjs"] },
        () => {},
        "win32",
      ).command,
    ).toBe("tool.cmd");
  });
});
