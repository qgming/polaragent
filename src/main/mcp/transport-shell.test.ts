/**
 * MCP stdio 启动的「命令怎么被启动」这一层（不真的起进程，只测判据）。
 *
 * 修的是缺口六：旧实现在 Windows 上恒定 `shell: true`，并把命令与每个参数各自
 * 引号化后**拼成一条字符串**交给 shell。判据正则 `/[\s"^&|<>()]/` **不含 `%` 与 `!`**，
 * 而这两个恰是 cmd 的变量展开与延迟展开字符 —— 旧代码的注释自己写着"真正有歧义的
 * 参数（含 % 或 !）建议写成 .cmd 脚本再调用"，也就是这个洞是被知道并在事实上接受的。
 *
 * 现在改成：**参数永远逐项传递**，只有确认目标是 `.cmd`/`.bat` 垫片时才经 `cmd.exe`，
 * 且**任何含 cmd 元字符的命令或参数一律拒绝启动**。
 */

import { describe, expect, it } from "vitest";
import { findCmdUnsafeArg, needsWindowsInterpreter } from "./transport";

const isWindows = process.platform === "win32";

describe("needsWindowsInterpreter", () => {
  it("只有 .cmd / .bat 才需要解释器", () => {
    // 判据是**扩展名**而不是「我们在 Windows 上」：真正的 .exe 不需要解释器，
    // 多套一层只会多一次注入面。
    const result = needsWindowsInterpreter("npx.cmd");
    expect(result).toBe(isWindows);
    expect(needsWindowsInterpreter("uvx.BAT")).toBe(isWindows);
  });

  it("普通可执行文件不经过解释器", () => {
    expect(needsWindowsInterpreter("node")).toBe(false);
    expect(needsWindowsInterpreter("server.exe")).toBe(false);
    // `.cmd.exe` 这种后缀不是垫片
    expect(needsWindowsInterpreter("weird.cmd.exe")).toBe(false);
  });
});

describe("findCmdUnsafeArg", () => {
  it("干净的命令与参数返回 undefined", () => {
    expect(findCmdUnsafeArg("npx.cmd", ["-y", "@modelcontextprotocol/server-filesystem"])).toBe(
      undefined,
    );
    expect(findCmdUnsafeArg("npx.cmd", ["-y", "@scope/pkg@1.2.3"])).toBe(undefined);
  });

  it("**含 % 的参数被拒** —— 这是旧实现漏掉的两个字符之一", () => {
    expect(findCmdUnsafeArg("npx.cmd", ["--token", "%USERPROFILE%"])).toBe("%USERPROFILE%");
  });

  it("**含 ! 的参数被拒** —— 另一个漏掉的字符（cmd 的延迟展开）", () => {
    expect(findCmdUnsafeArg("npx.cmd", ["say!hi"])).toBe("say!hi");
  });

  it("含 & | < > ^ 的参数被拒（命令拼接与重定向）", () => {
    for (const arg of ["a&b", "a|b", "a<b", "a>b", "a^b"]) {
      expect(findCmdUnsafeArg("npx.cmd", [arg]), arg).toBe(arg);
    }
  });

  it("含引号或换行的参数被拒", () => {
    expect(findCmdUnsafeArg("npx.cmd", ['a"b'])).toBe('a"b');
    expect(findCmdUnsafeArg("npx.cmd", ["a\nb"])).toBe("a\nb");
  });

  it("命令名本身也检查", () => {
    expect(findCmdUnsafeArg("evil&calc.cmd", [])).toBe("evil&calc.cmd");
  });

  it("返回的是**第一个**有问题的值，便于直接报给用户", () => {
    expect(findCmdUnsafeArg("npx.cmd", ["ok", "a&b", "c|d"])).toBe("a&b");
  });

  it("空格与常见路径分隔符**不算**元字符", () => {
    // 它们由 Node 的平台引号化负责，不需要我们拒绝 ——
    // 拒绝一切带空格的参数会把 `C:\Program Files\...` 这类正常路径也挡掉。
    expect(findCmdUnsafeArg("npx.cmd", ["C:\\Program Files\\app\\server.js"])).toBe(undefined);
    expect(findCmdUnsafeArg("npx.cmd", ["--config=./a b/c.json"])).toBe(undefined);
  });
});
