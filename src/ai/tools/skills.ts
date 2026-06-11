// 技能读取工具 —— list_skills / read_skill

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation } from "@earendil-works/pi-agent-core";

import { listDirectoryEntries, readFile } from "@/lib/electron/electron-api";
import { text, type ToolContext } from "./tool-context";

const listSkillsParams = Type.Object({});

const readSkillParams = Type.Object({
  name: Type.String({ description: "要读取的技能名称，例如 frontend-design" }),
});

const readSkillFileParams = Type.Object({
  name: Type.String({ description: "技能名称，例如 frontend-design" }),
  path: Type.String({ description: "技能目录内的相对路径，例如 references/colors.md" }),
});

const MAX_TREE_ENTRIES = 120;
const MAX_TREE_DEPTH = 4;

function availableSkills(ctx: ToolContext) {
  return ctx.skills ?? [];
}

function findSkill(ctx: ToolContext, name: string) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return availableSkills(ctx).find(
    (skill) => skill.name.toLowerCase() === normalized,
  );
}

function skillRoot(skillFilePath: string): string {
  return skillFilePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
}

function normalizeRelativePath(path: string): string {
  const parts: string[] = [];
  for (const raw of path.replace(/\\/g, "/").split("/")) {
    const part = raw.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error("技能文件路径不能包含越界的 .. 段");
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function resolveSkillFilePath(skillFilePath: string, relativePath: string): string {
  const normalizedRelative = normalizeRelativePath(relativePath);
  if (!normalizedRelative) throw new Error("技能文件路径不能为空");
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(relativePath)) {
    throw new Error("技能文件路径必须是相对路径");
  }
  const root = skillRoot(skillFilePath);
  const target = `${root}/${normalizedRelative}`;
  const rootPrefix = `${root.replace(/\/+$/, "")}/`;
  if (!target.startsWith(rootPrefix)) {
    throw new Error("技能文件路径超出了技能目录范围");
  }
  return target;
}

async function buildSkillTree(root: string): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (count >= MAX_TREE_ENTRIES) {
      truncated = true;
      return;
    }
    if (depth > MAX_TREE_DEPTH) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await listDirectoryEntries(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      lines.push(`${entry.isDir ? "[dir] " : "[file] "}${rel}`);
      count += 1;
      if (entry.isDir) {
        await walk(`${dir}/${entry.name}`, rel, depth + 1);
      }
    }
  }

  await walk(root, "", 1);
  return { lines, truncated };
}

export function listSkillsTool(
  ctx: ToolContext,
): AgentTool<typeof listSkillsParams> {
  return {
    name: "list_skills",
    label: "列出技能",
    description:
      "列出当前助手或团队上下文可用的技能。遇到任务可能匹配某个技能时，先调用此工具查看技能名称和适用场景，再用 read_skill 读取具体说明。",
    parameters: listSkillsParams,
    executionMode: "parallel",
    execute: async () => {
      const skills = availableSkills(ctx);
      if (skills.length === 0) {
        return {
          content: text("当前没有可用技能。"),
          details: { skills: [] },
        };
      }

      const lines = skills.map(
        (skill) => `- ${skill.name}: ${skill.description}`,
      );
      return {
        content: text(lines.join("\n")),
        details: {
          skills: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            location: skill.filePath,
          })),
        },
      };
    },
  };
}

export function readSkillTool(
  ctx: ToolContext,
): AgentTool<typeof readSkillParams> {
  return {
    name: "read_skill",
    label: "读取技能",
    description:
      "读取当前上下文中某个可用技能的完整 SKILL.md 说明。只能读取 list_skills 列出的技能，用于在执行匹配任务前加载具体流程、约束和参考资料位置。",
    parameters: readSkillParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof readSkillParams>) => {
      const skill = findSkill(ctx, params.name);
      if (!skill) {
        const names = availableSkills(ctx).map((item) => item.name).join(", ");
        throw new Error(
          names
            ? `技能「${params.name}」不可用。当前可用技能：${names}`
            : `技能「${params.name}」不可用。当前没有可用技能。`,
        );
      }

      const root = skillRoot(skill.filePath);
      const tree = await buildSkillTree(root);
      const treeText = tree.lines.length > 0
        ? tree.lines.join("\n")
        : "(没有发现其他文件)";
      const truncatedHint = tree.truncated
        ? "\n\n(目录树已截断；可根据已列出的相对路径继续调用 read_skill_file。)"
        : "";

      return {
        content: text(
          `${formatSkillInvocation(skill)}\n\n<skill_files root="${root}">\n${treeText}${truncatedHint}\n</skill_files>\n\n可调用 read_skill_file({ name: "${skill.name}", path: "相对路径" }) 读取 references 或其他子文件。`,
        ),
        details: {
          name: skill.name,
          description: skill.description,
          location: skill.filePath,
          root,
          files: tree.lines,
          truncated: tree.truncated,
        },
      };
    },
  };
}

export function readSkillFileTool(
  ctx: ToolContext,
): AgentTool<typeof readSkillFileParams> {
  return {
    name: "read_skill_file",
    label: "读取技能文件",
    description:
      "读取某个可用技能目录内的子文件，例如 references、examples、scripts 下的说明文件。路径必须是 read_skill 返回目录树中的相对路径，不能越过技能目录。",
    parameters: readSkillFileParams,
    execute: async (_id, params: Static<typeof readSkillFileParams>) => {
      const skill = findSkill(ctx, params.name);
      if (!skill) {
        const names = availableSkills(ctx).map((item) => item.name).join(", ");
        throw new Error(
          names
            ? `技能「${params.name}」不可用。当前可用技能：${names}`
            : `技能「${params.name}」不可用。当前没有可用技能。`,
        );
      }

      const target = resolveSkillFilePath(skill.filePath, params.path);
      const content = await readFile(target);
      return {
        content: text(
          `<skill_file skill="${skill.name}" path="${normalizeRelativePath(params.path)}" location="${target}">\n${content}\n</skill_file>`,
        ),
        details: {
          name: skill.name,
          path: normalizeRelativePath(params.path),
          location: target,
          bytes: content.length,
        },
      };
    },
  };
}
