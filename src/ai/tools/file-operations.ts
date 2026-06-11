// 文件操作工具 —— read_file / write_file / list_directory
// src/ai/tools/file-operations.ts
//
// 隶属 file-operations 技能。write_file 写入成功后会登记到产物面板。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  createDirectory,
  deleteFile,
  readFile,
  writeFile,
  listDirectory,
} from "@/lib/electron/electron-api";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import { fileName, resolvePath, text, type ToolContext } from "./tool-context";

// read_file 参数 schema
const readFileParams = Type.Object({
  path: Type.String({ description: "文件路径，相对工作目录或绝对路径" }),
});

export function readFileTool(ctx: ToolContext): AgentTool<typeof readFileParams> {
  return {
    name: "read_file",
    label: "读取文件",
    description: "读取工作目录下指定文件的文本内容。",
    parameters: readFileParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof readFileParams>) => {
      const target = resolvePath(ctx, params.path);
      const content = await readFile(target);
      return {
        content: text(content),
        details: { path: target, bytes: content.length },
      };
    },
  };
}

// write_file 参数 schema
const writeFileParams = Type.Object({
  path: Type.String({ description: "文件路径，相对工作目录或绝对路径" }),
  content: Type.String({ description: "要写入的完整文本内容" }),
  final: Type.Optional(
    Type.Boolean({
      description:
        "是否为最终交付文件（true 归入“最终文件”，否则“工作文件”）",
    }),
  ),
});

export function writeFileTool(
  ctx: ToolContext,
): AgentTool<typeof writeFileParams> {
  return {
    name: "write_file",
    label: "写入文件",
    description:
      "把内容写入工作目录下的文件（覆盖写入）。写入成功后该文件会出现在产物面板。",
    parameters: writeFileParams,
    execute: async (_id, params: Static<typeof writeFileParams>) => {
      const target = resolvePath(ctx, params.path);
      const content = params.content;
      await writeFile(target, content);

      const artifact = {
        path: target,
        name: fileName(target),
        kind: params.final ? "final" : "working",
      } as const;

      if (ctx.isTeam) {
        useTeamMonitorStore.getState().addArtifact(ctx.threadId, artifact);
      } else {
        useTaskMonitorStore.getState().addArtifact(ctx.threadId, artifact);
      }

      return {
        content: text(`已写入 ${fileName(target)}（${content.length} 字符）`),
        details: { path: target },
      };
    },
  };
}

// edit_file 参数 schema —— 旧字符串精确替换
const editFileParams = Type.Object({
  path: Type.String({ description: "文件路径，相对工作目录或绝对路径" }),
  oldString: Type.String({
    description:
      "要被替换的原文片段，必须与文件内容逐字符精确匹配（含缩进与换行）。默认须在文件中唯一。",
  }),
  newString: Type.String({
    description: "替换后的新文本（可为空字符串以删除该片段）",
  }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description: "为 true 时替换全部匹配；否则要求 oldString 唯一，多处匹配会报错",
    }),
  ),
});

export function editFileTool(ctx: ToolContext): AgentTool<typeof editFileParams> {
  return {
    name: "edit_file",
    label: "编辑文件",
    description:
      "对工作目录下的文件做精确替换编辑：把 oldString 替换为 newString。" +
      "oldString 须与文件内容逐字符精确匹配；默认要求唯一，replaceAll 为 true 时替换全部匹配。" +
      "适合定点修改，无需重写整个文件。编辑成功后该文件会出现在产物面板。",
    parameters: editFileParams,
    execute: async (_id, params: Static<typeof editFileParams>) => {
      const target = resolvePath(ctx, params.path);

      if (params.oldString === params.newString) {
        throw new Error("oldString 与 newString 相同，无需编辑");
      }

      const original = await readFile(target);

      // 统计匹配次数（按字面子串，非正则）
      let count = 0;
      let from = 0;
      while (params.oldString.length > 0) {
        const index = original.indexOf(params.oldString, from);
        if (index === -1) break;
        count += 1;
        from = index + params.oldString.length;
      }

      if (count === 0) {
        throw new Error("未在文件中找到 oldString，请确认片段是否逐字符精确匹配");
      }
      if (count > 1 && !params.replaceAll) {
        throw new Error(
          `oldString 在文件中出现 ${count} 次，存在歧义。请提供更长的唯一片段，或设 replaceAll 为 true`,
        );
      }

      const updated = params.replaceAll
        ? original.split(params.oldString).join(params.newString)
        : original.replace(params.oldString, params.newString);

      await writeFile(target, updated);

      const artifact = {
        path: target,
        name: fileName(target),
        kind: "working",
      } as const;

      if (ctx.isTeam) {
        useTeamMonitorStore.getState().addArtifact(ctx.threadId, artifact);
      } else {
        useTaskMonitorStore.getState().addArtifact(ctx.threadId, artifact);
      }

      const replaced = params.replaceAll ? count : 1;
      return {
        content: text(`已编辑 ${fileName(target)}（替换 ${replaced} 处）`),
        details: { path: target, replaced },
      };
    },
  };
}

// create_directory 参数 schema
const createDirectoryParams = Type.Object({
  path: Type.String({
    description: "要创建的目录路径，相对工作目录或绝对路径。会自动创建必要的父目录。",
  }),
});

export function createDirectoryTool(
  ctx: ToolContext,
): AgentTool<typeof createDirectoryParams> {
  return {
    name: "create_directory",
    label: "新建目录",
    description:
      "创建工作目录下的指定目录。会自动创建必要的父目录，适合先搭建项目结构再写入文件。",
    parameters: createDirectoryParams,
    execute: async (_id, params: Static<typeof createDirectoryParams>) => {
      const target = resolvePath(ctx, params.path);
      await createDirectory(target);
      return {
        content: text(`已创建目录 ${fileName(target)}`),
        details: { path: target },
      };
    },
  };
}

// delete_file 参数 schema
const deleteFileParams = Type.Object({
  path: Type.String({
    description:
      "要删除的文件或目录路径，相对工作目录或绝对路径。目录会递归删除其内部文件。",
  }),
});

export function deleteFileTool(
  ctx: ToolContext,
): AgentTool<typeof deleteFileParams> {
  return {
    name: "delete_file",
    label: "删除路径",
    description:
      "删除工作目录下的指定文件或目录。目录会递归删除其内部文件；删除成功后会从产物面板移除对应路径下的文件。",
    parameters: deleteFileParams,
    execute: async (_id, params: Static<typeof deleteFileParams>) => {
      const target = resolvePath(ctx, params.path);
      await deleteFile(target);

      if (ctx.isTeam) {
        useTeamMonitorStore
          .getState()
          .removeArtifactsUnderPath(ctx.threadId, target);
      } else {
        useTaskMonitorStore
          .getState()
          .removeArtifactsUnderPath(ctx.threadId, target);
      }

      return {
        content: text(`已删除 ${fileName(target)}`),
        details: { path: target },
      };
    },
  };
}

// list_directory 参数 schema
const listDirectoryParams = Type.Object({
  path: Type.Optional(
    Type.String({ description: "目录路径，留空则使用工作目录" }),
  ),
});

export function listDirectoryTool(
  ctx: ToolContext,
): AgentTool<typeof listDirectoryParams> {
  return {
    name: "list_directory",
    label: "列出目录",
    description: "列出工作目录或指定目录下的文件与子目录。",
    parameters: listDirectoryParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof listDirectoryParams>) => {
      const target = resolvePath(ctx, params.path || ".");
      const entries = await listDirectory(target);
      return {
        content: text(entries.join("\n") || "(空目录)"),
        details: { path: target, entries },
      };
    },
  };
}
