import { describe, expect, it } from "vitest";
import { assertCommandAllowed, assessCommand } from "./command-guard";

const blockedCommands = [
  "rm -rf /",
  "shutdown /s /t 0",
  "mkfs.ext4 /dev/sda1",
  ":(){ :|:& };:",
  "del /s C:\\",
];

const safeCommands = ["ls -la", "git status", "npm run build", "echo hello", "node script.js"];

describe("assessCommand", () => {
  for (const command of blockedCommands) {
    it(`命中黑名单判定为 high: ${command}`, () => {
      const result = assessCommand(command);
      expect(result.risk).toBe("high");
      expect(result.matched?.description).toBeTruthy();
    });
  }

  for (const command of safeCommands) {
    it(`普通命令判定为 safe: ${command}`, () => {
      expect(assessCommand(command).risk).toBe("safe");
    });
  }

  it("返回命中模式的原始正则与描述", () => {
    const result = assessCommand("rm -rf /");
    expect(result.matched?.pattern).toContain("rm");
    expect(result.matched?.description).toContain("删除");
  });
});

describe("assertCommandAllowed", () => {
  it("安全命令不抛错", () => {
    expect(() => assertCommandAllowed("git status")).not.toThrow();
  });

  it("高危命令抛出拦截错误", () => {
    expect(() => assertCommandAllowed("shutdown")).toThrow("安全策略");
  });
});
