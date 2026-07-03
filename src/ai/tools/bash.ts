// Shell 命令执行工具 —— run_bash
// src/ai/tools/bash.ts
//
// 在会话工作目录下执行 shell 命令，返回标准输出与错误输出。
// 命令由主进程（electron/ipc/shell.cjs）执行，那里会做黑名单二次校验、超时 kill、输出截断。
// 渲染侧在这里先做一次黑名单预检，提前拦截明显的高危命令。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { runShell } from "@/lib/electron/electron-api";
import { text, type ToolContext } from "./tool-context";
import blockedPatterns from "@/lib/blocked-patterns.json";

// 超时边界（与主进程 shell.cjs 对齐）
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

// 从共享 JSON 加载黑名单，保证渲染侧与主进程完全一致
// 单个正则无效时跳过该条，避免整个模块加载失败
const BLOCKED_PATTERNS = blockedPatterns.patterns
  .map(({ pattern, flags, description }) => {
    try {
      return { test: new RegExp(pattern, flags), reason: description };
    } catch (e) {
      console.error(`[bash] 无效黑名单正则: /${pattern}/${flags}`, e);
      return null;
    }
  })
  .filter((item): item is NonNullable<typeof item> => item !== null);

// 命中黑名单返回拒绝原因，否则返回 null
function checkBlocked(command: string): string | null {
  for (const { test, reason } of BLOCKED_PATTERNS) {
    if (test.test(command)) return reason;
  }
  return null;
}

// run_bash 参数 schema
const runBashParams = Type.Object({
  command: Type.String({
    description: "要执行的 shell 命令（在会话工作目录下运行）",
  }),
  timeout: Type.Optional(
    Type.Number({
      description: "超时毫秒数，1000-120000，默认 30000",
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
    }),
  ),
});

export function runBashTool(ctx: ToolContext): AgentTool<typeof runBashParams> {
  return {
    name: "run_bash",
    label: "运行命令",
    description:
      "在会话工作目录下执行一条 shell 命令，返回标准输出与错误输出。" +
      "高危命令（rm -rf /、shutdown、mkfs、format 等）会被拦截。" +
      "长输出会被截断，请用具体命令避免无意义的大量输出。",
    parameters: runBashParams,
    execute: async (_id, params: Static<typeof runBashParams>, _signal, onUpdate) => {
      const command = params.command.trim();
      if (!command) {
        return {
          content: text("命令不能为空。"),
          details: { command, error: "命令为空" },
        };
      }

      // 前置校验：必须有工作目录
      if (!ctx.workingDir) {
        return {
          content: text(
            "当前会话未设置工作目录。请先在对话设置中选择工作目录，" +
              "或在新建会话时指定工作目录后再使用此工具。",
          ),
          details: { command, error: "未设置工作目录" },
        };
      }

      // 渲染侧黑名单预检（主进程会再查一遍）
      const blockedReason = checkBlocked(command);
      if (blockedReason) {
        return {
          content: text(
            `命令被安全策略拦截：${blockedReason}。` +
              "如确属必要，请手动在终端执行。",
          ),
          details: { command, blocked: true, reason: blockedReason },
        };
      }

      const timeoutMs =
        typeof params.timeout === "number" && Number.isFinite(params.timeout)
          ? Math.trunc(params.timeout)
          : DEFAULT_TIMEOUT_MS;

      // 推送执行中状态（onUpdate 回调让任务面板实时显示）
      onUpdate?.({
        content: text(`$ ${command}\n(执行中...)`),
        details: { command, phase: "executing" },
      });

      try {
        const result = await runShell({
          command,
          cwd: ctx.workingDir,
          timeoutMs,
          securityMode: ctx.permissionMode,
        });

        // 主进程拦截（二次校验）
        if (result.blocked) {
          return {
            content: text(
              `命令被安全策略拦截：${result.error ?? "高危操作"}。` +
                "如确属必要，请手动在终端执行。",
            ),
            details: { command, blocked: true, error: result.error },
          };
        }

        // 超时
        if (result.timedOut) {
          return {
            content: text(
              `命令执行超时（${timeoutMs}ms）。\n\n` +
                `标准输出：\n${result.stdout || "(无)"}\n\n` +
                `错误输出：\n${result.stderr || "(无)"}`,
            ),
            details: {
              command,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: true,
              truncated: result.truncated,
            },
          };
        }

        // 执行失败（IPC 层或 spawn 错误）
        if (!result.success && result.error) {
          return {
            content: text(`命令执行失败：${result.error}`),
            details: {
              command,
              error: result.error,
              stdout: result.stdout,
              stderr: result.stderr,
            },
          };
        }

        // 执行完成（exitCode 0 或非 0）
        const exitCode = result.exitCode ?? -1;
        const truncatedHint = result.truncated
          ? "\n\n(输出已截断，超出 30000 字符)"
          : "";
        const combined = [
          `$ ${command}`,
          `exit code: ${exitCode}`,
          "",
          result.stdout || result.stderr
            ? `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}${truncatedHint}`
            : "(无输出)",
        ].join("\n");

        return {
          content: text(combined),
          details: {
            command,
            exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        return {
          content: text(
            `命令执行异常：${error instanceof Error ? error.message : String(error)}`,
          ),
          details: { command, error: String(error) },
        };
      }
    },
  };
}
