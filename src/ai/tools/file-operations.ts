// 文件操作工具 —— read_file / write_file / list_directory
// src/ai/tools/file-operations.ts
//
// 隶属 file-operations 技能。write_file 写入成功后会登记到产物面板。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpath } from "fs/promises";

import {
  appendFile,
  copyPath,
  createDirectory,
  deleteFile,
  listDirectory,
  listDirectoryEntries,
  readFile,
  renamePath,
  writeFile,
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
  append: Type.Optional(
    Type.Boolean({
      description: "是否在文件末尾追加内容（默认 false，覆盖写入）",
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
      "把内容写入工作目录下的文件。默认覆盖写入，append 为 true 时追加到文件末尾。写入成功后该文件会出现在产物面板。",
    parameters: writeFileParams,
    execute: async (_id, params: Static<typeof writeFileParams>) => {
      const target = resolvePath(ctx, params.path);
      const content = params.content;
      if (params.append) {
        await appendFile(target, content);
      } else {
        await writeFile(target, content);
      }

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

// edit_file 参数 schema —— 旧字符串精确替换或正则替换
const editFileParams = Type.Object({
  path: Type.String({ description: "文件路径，相对工作目录或绝对路径" }),
  oldString: Type.String({
    description:
      "要被替换的原文片段，必须与文件内容逐字符精确匹配（含缩进与换行）。默认须在文件中唯一。regex 为 true 时作为正则表达式处理。",
  }),
  newString: Type.String({
    description: "替换后的新文本（可为空字符串以删除该片段）。regex 为 true 时支持 $1、$2 等捕获组替换",
  }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description: "为 true 时替换全部匹配；否则要求 oldString 唯一，多处匹配会报错",
    }),
  ),
  regex: Type.Optional(
    Type.Boolean({
      description: "是否将 oldString 作为正则表达式处理（默认 false，字面匹配）",
    }),
  ),
  regexFlags: Type.Optional(
    Type.String({
      description: "正则表达式标志，默认 replaceAll 为 true 时 'g'，否则为空。仅在 regex=true 时生效",
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
      "支持正则替换模式（regex=true），oldString 将作为正则表达式处理。" +
      "适合定点修改，无需重写整个文件。编辑成功后该文件会出现在产物面板。",
    parameters: editFileParams,
    execute: async (_id, params: Static<typeof editFileParams>) => {
      const target = resolvePath(ctx, params.path);

      if (!params.regex && params.oldString === params.newString) {
        throw new Error("oldString 与 newString 相同，无需编辑");
      }

      const original = await readFile(target);

      let updated: string;
      let count: number;

      if (params.regex) {
        // 正则模式：oldString 作为正则表达式处理
        let flags = params.regexFlags ?? (params.replaceAll ? "g" : "");
        if (params.replaceAll && !flags.includes("g")) {
          flags += "g";
        } else if (!params.replaceAll) {
          // 非 replaceAll 时移除全局标志，确保只替换第一个匹配
          flags = flags.replace(/g/g, "");
        }

        let regex: RegExp;
        try {
          regex = new RegExp(params.oldString, flags);
        } catch {
          throw new Error(`正则表达式 /${params.oldString}/${flags} 格式无效`);
        }

        // 统计匹配数（使用全局副本）
        const countRegex = new RegExp(
          params.oldString,
          flags.includes("g") ? flags : `${flags}g`,
        );
        const matches = original.match(countRegex);
        count = matches ? matches.length : 0;

        if (count === 0) {
          throw new Error(
            `正则表达式 /${params.oldString}/${flags} 在文件中没有匹配项`,
          );
        }
        if (count > 1 && !params.replaceAll) {
          throw new Error(
            `正则表达式 /${params.oldString}/${flags} 匹配到 ${count} 处。请提供更精确的模式，或设 replaceAll 为 true`,
          );
        }

        updated = original.replace(regex, params.newString);
      } else {
        // 字面匹配模式（原有逻辑）
        count = 0;
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

        updated = params.replaceAll
          ? original.split(params.oldString).join(params.newString)
          : original.replace(params.oldString, params.newString);
      }

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

// move_file 参数 schema
const moveFileParams = Type.Object({
  source: Type.String({ description: "源文件/目录路径，相对工作目录或绝对路径" }),
  destination: Type.String({
    description: "目标路径（新位置或新名称），相对工作目录或绝对路径",
  }),
});

export function moveFileTool(ctx: ToolContext): AgentTool<typeof moveFileParams> {
  return {
    name: "move_file",
    label: "移动/重命名",
    description:
      "移动或重命名工作目录下的文件/目录。支持跨目录移动、同目录重命名以及跨分区回退。",
    parameters: moveFileParams,
    execute: async (_id, params: Static<typeof moveFileParams>) => {
      const src = resolvePath(ctx, params.source);
      const dest = resolvePath(ctx, params.destination);
      try {
        await renamePath(src, dest);
      } catch (err) {
        // 跨设备/分区时回退为复制后删除
        if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
          await copyPath(src, dest);
          await deleteFile(src);
        } else {
          throw err;
        }
      }
      return {
        content: text(`已将 ${params.source} 移动到 ${params.destination}`),
        details: { source: src, destination: dest },
      };
    },
  };
}

// copy_file 参数 schema
const copyFileParams = Type.Object({
  source: Type.String({ description: "源文件/目录路径，相对工作目录或绝对路径" }),
  destination: Type.String({
    description: "目标路径（复制到的位置），相对工作目录或绝对路径",
  }),
});

export function copyFileTool(ctx: ToolContext): AgentTool<typeof copyFileParams> {
  return {
    name: "copy_file",
    label: "复制文件",
    description: "复制工作目录下的文件或目录到指定位置。",
    parameters: copyFileParams,
    execute: async (_id, params: Static<typeof copyFileParams>) => {
      const src = resolvePath(ctx, params.source);
      const dest = resolvePath(ctx, params.destination);
      await copyPath(src, dest);
      return {
        content: text(`已将 ${params.source} 复制到 ${params.destination}`),
        details: { source: src, destination: dest },
      };
    },
  };
}

// search_files 参数 schema
const searchFilesParams = Type.Object({
  pattern: Type.String({
    description:
      "Glob 匹配模式，如 '**/*.ts'、'src/**/*.{js,jsx}'、'**/README.md'",
  }),
  path: Type.Optional(
    Type.String({ description: "搜索起始目录，默认为工作目录" }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "最大返回数量，默认 100，上限 500",
      minimum: 1,
      maximum: 500,
    }),
  ),
});

// 展开 Glob 模式中的大括号，如 "src/**/*.{js,jsx}" 展开为 ["src/**/*.js", "src/**/*.jsx"]。
function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice((match.index ?? 0) + match[0].length);
  const alternatives = match[1].split(",");
  return alternatives.flatMap((alt) => expandBraces(`${prefix}${alt.trim()}${suffix}`));
}

/**
 * 判断文件名片段是否匹配单个 Glob 段（支持 * 与 ?）。
 */
function matchSegment(name: string, segment: string): boolean {
  let pat = "";
  for (const ch of segment) {
    if (ch === "*") pat += ".*";
    else if (ch === "?") pat += ".";
    else pat += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${pat}$`);
  return regex.test(name);
}

/**
 * 判断路径分段是否匹配模式分段（支持 ** 匹配零到多级目录）。
 */
function matchSegments(pathParts: string[], patternParts: string[]): boolean {
  if (patternParts.length === 0) return pathParts.length === 0;
  const [pat, ...restPat] = patternParts;
  if (pat === "**") {
    if (restPat.length === 0) return true;
    for (let i = 0; i <= pathParts.length; i++) {
      if (matchSegments(pathParts.slice(i), restPat)) return true;
    }
    return false;
  }
  if (pathParts.length === 0) return false;
  const [part, ...restPath] = pathParts;
  return matchSegment(part, pat) && matchSegments(restPath, restPat);
}

/**
 * 在指定目录下递归搜索匹配 Glob 模式的文件与目录。
 */
async function globSearch(
  pattern: string,
  options: { cwd: string; max: number },
): Promise<string[]> {
  const patterns = expandBraces(pattern).map((p) => p.split("/").filter(Boolean));
  const results: string[] = [];
  const visited = new Set<string>(); // 已遍历的真实路径，防止符号链接循环

  async function walk(dir: string, relPrefix: string) {
    if (results.length >= options.max) return;

    // 获取真实路径并检测循环；无法解析时跳过该目录
    try {
      const resolved = await realpath(dir);
      if (visited.has(resolved)) return;
      visited.add(resolved);
    } catch {
      return;
    }

    const entries = await listDirectoryEntries(dir);
    for (const entry of entries) {
      if (results.length >= options.max) break;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = `${dir}/${entry.name}`;
      const parts = relPath.split("/");
      if (patterns.some((pat) => matchSegments(parts, pat))) {
        results.push(relPath);
      }
      if (entry.isDir) {
        await walk(fullPath, relPath);
      }
    }
  }

  await walk(options.cwd, "");
  return results;
}

export function searchFilesTool(
  ctx: ToolContext,
): AgentTool<typeof searchFilesParams> {
  return {
    name: "search_files",
    label: "搜索文件",
    description:
      "使用 Glob 模式在工作目录或指定目录下搜索文件与目录，支持 *、?、** 与 {a,b} 语法。",
    parameters: searchFilesParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof searchFilesParams>) => {
      const basePath = resolvePath(ctx, params.path || ".");
      const maxResults = Math.min(params.maxResults || 100, 500);
      const results = await globSearch(params.pattern, {
        cwd: basePath,
        max: maxResults,
      });
      if (results.length === 0) {
        return {
          content: text(`未找到匹配 "${params.pattern}" 的文件。`),
          details: { path: basePath, pattern: params.pattern },
        };
      }
      return {
        content: text(`找到 ${results.length} 个匹配：\n${results.join("\n")}`),
        details: { path: basePath, pattern: params.pattern, results },
      };
    },
  };
}
