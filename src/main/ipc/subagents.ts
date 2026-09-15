// 子智能体通道：定义目录的读写 + 运行记录的查询/停止。
//
// 定义侧与技能（ipc/skills.ts）同源：目录解析走 resources.ts 的 resolveSubagentDirs，
// 内容读写走 pisdk/subagent-catalog.ts —— 面板里看到的与运行时装配的必须是同一套规则。
// 运行侧不属于本文件：运行记录由 pisdk/subagent-runner.ts（子智能体运行时）维护，这里只做转发。

import { existsSync } from "node:fs";
import { shell } from "electron";
import {
  BUILTIN_SUBAGENTS,
  loadSubagentCatalog,
  readUserSubagentFile,
  removeUserSubagentFile,
  serializeSubagentMarkdown,
  subagentFilePath,
  toSubagentInfo,
  writeUserSubagentFile,
} from "@/main/pisdk/subagent-catalog";
import { reconcileSubagentRuns, stopSubagentRun } from "@/main/pisdk/subagent-runner";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import {
  normalizeSubagentName,
  type SubagentCatalog,
  type SubagentInfo,
  type SubagentReadResult,
  type SubagentRun,
  type SubagentWriteRequest,
} from "@/shared/contracts/subagent";
import { handle } from "./handler";

/** 内置定义按名字索引：内置的 .md 不存在于磁盘，读/写/删都要按名字特判 */
function builtinByName(name: string): (typeof BUILTIN_SUBAGENTS)[number] | undefined {
  const normalized = normalizeSubagentName(name);
  return BUILTIN_SUBAGENTS.find((def) => def.name === normalized);
}

export function registerSubagentsIpc(): void {
  handle(
    IPC.subagents.list,
    "读取子智能体列表",
    async (request?: { workingDir?: string }): Promise<SubagentCatalog> => {
      const settings = await loadSettings();
      // cwd 决定项目级目录（.oint/subagents）扫不扫：设置面板不带会话，只列数据目录里的定义；
      // 项目级定义跟着会话 cwd 走。定义目录固定，读取走普通 fs，不需要装配 ExecutionEnv
      const { definitions, diagnostics } = await loadSubagentCatalog(request?.workingDir);
      // enabled 由设置现算，不在目录层过滤：已禁用的定义也要显示出来才能重新启用
      return { subagents: definitions.map((def) => toSubagentInfo(def, settings)), diagnostics };
    },
  );

  handle(
    IPC.subagents.read,
    "读取子智能体定义",
    async (request: { name: string }): Promise<SubagentReadResult> => {
      const builtin = builtinByName(request.name);
      // 内置定义没有磁盘文件：现序列化一份等价 markdown，让编辑框能只读展示
      if (builtin) {
        return { name: builtin.name, content: serializeSubagentMarkdown(builtin) };
      }
      return readUserSubagentFile(request.name);
    },
  );

  handle(
    IPC.subagents.write,
    "写入子智能体定义",
    async (request: SubagentWriteRequest): Promise<SubagentInfo> => {
      // 内置名不许被用户文件覆盖：否则改内置得先删数据目录里的同名文件，行为不可预期
      if (builtinByName(request.name) !== undefined) {
        throw new Error(`内置子智能体不可覆盖：${normalizeSubagentName(request.name)}`);
      }
      return writeUserSubagentFile(request);
    },
  );

  handle(
    IPC.subagents.remove,
    "删除子智能体定义",
    async (request: { name: string }): Promise<void> => {
      // catalog.remove 也会拒绝内置；这里先拦一道是为了给出更准确的提示
      if (builtinByName(request.name) !== undefined) {
        throw new Error(`内置子智能体不可删除：${normalizeSubagentName(request.name)}`);
      }
      await removeUserSubagentFile(request.name);
    },
  );

  handle(
    IPC.subagents.reveal,
    "在文件管理器中显示子智能体定义",
    (request: { name: string }): { ok: boolean } => {
      const filePath = subagentFilePath(normalizeSubagentName(request.name));
      // 文件不存在时不打开文件夹：否则用户看到的是「定位失败」，而真实情况是还没保存
      if (!existsSync(filePath)) return { ok: false };
      shell.showItemInFolder(filePath);
      return { ok: true };
    },
  );

  // 读的时候顺手对账：盘上还写着 running、本进程却没有它的运行，说明拥有它的进程已经没了 ——
  // 标成 interrupted 之后再返回，面板与模型看到的就不是一条永远不会动的「还在跑」
  handle(IPC.subagents.runs, "读取子智能体运行记录", (request: { sessionId: string }) =>
    reconcileSubagentRuns(request.sessionId),
  );

  handle(
    IPC.subagents.stop,
    "停止子智能体运行",
    // 不在本进程运行中的记录（例如对账出来的 interrupted）没有可停的东西：runner 返回 undefined，
    // 原样透出去即可 —— 工具侧会以「没有找到这些运行」告诉模型（见 tools/subagent.ts）
    (request: { sessionId: string; delegationId: string }): Promise<SubagentRun | undefined> =>
      stopSubagentRun(request.sessionId, request.delegationId),
  );
}
