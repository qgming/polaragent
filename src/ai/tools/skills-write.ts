// 技能写入工具 —— write_skill
// src/ai/tools/skills-write.ts
//
// 允许 AI 在 dataDir/skills/custom 目录下创建、编辑、精确替换和删除技能。
// 所有修改都会先自动备份到 .bak 目录（保留最多 10 个版本）。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  writeSkill as apiWriteSkill,
  patchSkill as apiPatchSkill,
  deleteSkillByName as apiDeleteSkill,
} from "@/lib/electron/electron-api";
import { skillLoader } from "@/lib/skill";
import { text, type ToolContext } from "./tool-context";

// write_skill 支持的 action 类型
const actionType = Type.Union(
  [
    Type.Literal("create", { description: "创建新技能" }),
    Type.Literal("edit", { description: "全量替换 SKILL.md" }),
    Type.Literal("patch", { description: "精确替换 SKILL.md 中的旧字符串为新字符串" }),
    Type.Literal("delete", { description: "删除整个技能目录" }),
  ],
  { description: "操作类型" },
);

// write_skill 参数 schema
const writeSkillParams = Type.Object({
  action: actionType,
  name: Type.String({
    description: "技能名称，只能包含小写字母、数字和连字符",
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  }),
  content: Type.Optional(
    Type.String({
      description: "SKILL.md 的完整内容（create / edit 时必填）",
    }),
  ),
  old_string: Type.Optional(
    Type.String({
      description: "patch 时要查找的旧字符串，必须与文件内容逐字符精确匹配",
    }),
  ),
  new_string: Type.Optional(
    Type.String({
      description: "patch 时替换为的新字符串",
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description: "delete 时必须设为 true 以确认删除",
    }),
  ),
});

/** 校验技能名称格式：只能包含小写字母、数字和连字符 */
function validateSkillName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("技能名称不能为空");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("技能名称不能为空");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error(
      `技能名称「${trimmed}」格式无效。只能包含小写字母、数字和连字符，例如「frontend-design」。`,
    );
  }
}

/** 构造成功返回结果 */
function successResult(path: string, message: string) {
  return {
    content: text(message),
    details: { success: true, path, message },
  };
}

/** 构造失败抛出异常 */
function failResult(message: string): never {
  throw new Error(message);
}

export function writeSkillTool(
  _ctx: ToolContext,
): AgentTool<typeof writeSkillParams> {
  return {
    name: "write_skill",
    label: "写入技能",
    description:
      "创建、编辑、精确替换或删除 dataDir/skills/custom 目录下的技能。" +
      "create: 创建新技能目录和 SKILL.md；" +
      "edit: 全量替换 SKILL.md；" +
      "patch: 精确定位 old_string 替换为 new_string；" +
      "delete: 删除整个技能目录（需 confirm=true）。" +
      "每次修改前会自动备份（保留最多 10 个版本）。",
    parameters: writeSkillParams,
    execute: async (_id, params: Static<typeof writeSkillParams>) => {
      const { action, name } = params;

      // 校验技能名
      validateSkillName(name);

      switch (action) {
        case "create": {
          if (!params.content || params.content.trim().length === 0) {
            failResult("create 操作必须提供 content 参数（SKILL.md 完整内容）");
          }
          const result = await apiWriteSkill(name, params.content!);
          if (!result.success) {
            failResult(result.message || `创建技能「${name}」失败`);
          }
          await skillLoader.initialize();
          return successResult(
            result.path,
            `技能「${name}」已创建。\n路径: ${result.path}`,
          );
        }

        case "edit": {
          if (!params.content || params.content.trim().length === 0) {
            failResult("edit 操作必须提供 content 参数（SKILL.md 完整内容）");
          }
          const result = await apiWriteSkill(name, params.content!);
          if (!result.success) {
            failResult(result.message || `编辑技能「${name}」失败`);
          }
          await skillLoader.initialize();
          return successResult(
            result.path,
            `技能「${name}」已全量替换。\n路径: ${result.path}`,
          );
        }

        case "patch": {
          if (!params.old_string || params.old_string.length === 0) {
            failResult("patch 操作必须提供 old_string 参数");
          }
          if (params.new_string === undefined) {
            failResult("patch 操作必须提供 new_string 参数");
          }
          const result = await apiPatchSkill(
            name,
            params.old_string!,
            params.new_string!,
          );
          if (!result.success) {
            failResult(result.message || `精确替换技能「${name}」失败`);
          }
          await skillLoader.initialize();
          return successResult(
            result.path,
            `技能「${name}」已精确替换。\n路径: ${result.path}`,
          );
        }

        case "delete": {
          if (params.confirm !== true) {
            failResult("delete 操作必须将 confirm 设为 true 以确认删除");
          }
          const result = await apiDeleteSkill(name);
          if (!result.success) {
            failResult(result.message || `删除技能「${name}」失败`);
          }
          await skillLoader.initialize();
          return successResult(
            result.path,
            `技能「${name}」已删除。\n路径: ${result.path}`,
          );
        }

        default:
          // TypeScript 中不会走到这里，但为了安全
          failResult(`不支持的操作类型: ${action}`);
      }
    },
  };
}
