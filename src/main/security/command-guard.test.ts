import { describe, expect, it } from "vitest";
import { assessCommand } from "./command-guard";

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

  /**
   * 黑名单是**词面**匹配，必须避免「字符串里恰好出现某个词」就命中的假阳性：
   * 早先 `(shutdown|reboot|halt|poweroff|init\s+0)\b` 没有锚定命令位置，
   * 于是 `echo shutdown` 也被拦、模型连一句回显都发不出去。
   * 这些词只在**作为命令本身**（行首、或 `;`/`&&`/`|` 之后）时才该命中。
   */
  it("关机类词只作为命令出现时命中，出现在参数/字符串里不算", () => {
    expect(assessCommand("shutdown /s /t 0").risk).toBe("high");
    expect(assessCommand("sudo reboot").risk).toBe("high");
    expect(assessCommand("git commit -m 'reboot the service'").risk).toBe("safe");
    expect(assessCommand("echo shutdown").risk).toBe("safe");
    expect(assessCommand("grep -r shutdown ./src").risk).toBe("safe");
    expect(assessCommand("rg 'poweroff' docs/").risk).toBe("safe");
  });

  it("返回命中模式的原始正则与描述", () => {
    const result = assessCommand("rm -rf /");
    expect(result.matched?.pattern).toContain("rm");
    expect(result.matched?.description).toContain("删除");
  });
});
