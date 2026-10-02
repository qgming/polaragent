// 仅负责 Oint 的进程启动策略；实际解析可执行文件、隐藏窗口与进程树收尾由 pi-mcp 负责。
import type { StdioTransportOptions } from "@earendil-works/pi-mcp";
import { buildChildEnv } from "@/main/security/child-env";
import type { McpServerConfig } from "@/shared/contracts/mcp";

const CMD_METACHARACTERS = /[%!&|<>^"\r\n]/;

export function findCmdUnsafeArg(command: string, args: readonly string[]): string | undefined {
  if (CMD_METACHARACTERS.test(command)) return command;
  return args.find((arg) => CMD_METACHARACTERS.test(arg));
}

export function stdioOptions(
  config: McpServerConfig,
  warn: (message: string) => void,
  platform = process.platform,
): StdioTransportOptions {
  // 裸 npx 也可能解析成 .cmd；只对明确的 native executable 放开元字符参数。
  // 不自己拼接 shell 字符串，交给上游 cross-spawn 逐参数转义。
  if (
    platform === "win32" &&
    !/\.(exe|com)$/i.test(config.command) &&
    findCmdUnsafeArg(config.command, config.args) !== undefined
  ) {
    throw new Error(
      "无法启动 MCP server：命令或参数含有 cmd 元字符（% ! & | < > ^ 引号或换行）。请使用原生可执行文件或包装脚本。",
    );
  }
  return {
    command: config.command,
    args: config.args,
    ...(config.cwd.trim() === "" ? {} : { cwd: config.cwd.trim() }),
    // pi-mcp 默认叠加 process.env；两个选项必须一起传，才能防止继承宿主密钥。
    inheritEnv: false,
    env: buildChildEnv(process.env, config.env),
    stderr: "pipe",
    onStderr: (chunk) => warn(`[mcp:${config.id}] ${chunk.trimEnd()}`),
  };
}
