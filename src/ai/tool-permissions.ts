// 工具权限审查：接入 pi-agent 的 tool_call 钩子，在真实执行前决定 allow/deny。
// 使用 pi-ai 统一的 streamSimple API，跟随设置中的 provider 配置。

import { callLlm } from "./llm-call";
import { toolDisplayName } from "./tools";
import { resolveModelService } from "./model-router";
import type { ToolPermissionMode } from "@/types/permissions";

export interface ToolPermissionRequest {
  agentId: string;
  requesterName: string;
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  permissionMode: ToolPermissionMode;
  workingDir?: string;
  isTeam?: boolean;
}

export interface ToolPermissionDecision {
  allow: boolean;
  reason?: string;
}

type ToolRisk = "read" | "write" | "execute" | "network" | "interaction" | "unknown";

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "web_search",
  "web_fetch",
  "list_skills",
  "read_skill",
  "read_skill_file",
  "speech_recognition",
]);

const SAFE_STATE_TOOLS = new Set([
  "update_todos",
  "ask_user",
  "request_team_vote",
  "cast_team_vote",
  "control_team_flow",
]);

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "delete_file",
  "image_generation",
  "image_edit",
  "speech_synthesis",
  "create_office_document",
]);

const EXECUTE_TOOLS = new Set(["run_bash"]);

export async function reviewToolPermission(
  request: ToolPermissionRequest,
): Promise<ToolPermissionDecision> {
  const mode = request.permissionMode;

  if (mode === "full") {
    return { allow: true };
  }

  if (mode === "readonly") {
    return reviewReadonly(request);
  }

  return reviewWithAi(request, mode);
}

function reviewReadonly(request: ToolPermissionRequest): ToolPermissionDecision {
  if (READ_ONLY_TOOLS.has(request.toolName) || SAFE_STATE_TOOLS.has(request.toolName)) {
    return { allow: true };
  }

  const label = toolDisplayName(request.toolName);
  return {
    allow: false,
    reason: `当前工具权限为只读模式，已阻止「${label}」。如需执行写入、命令或外部副作用，请在输入栏底部切换权限模式。`,
  };
}

async function reviewWithAi(
  request: ToolPermissionRequest,
  _mode: ToolPermissionMode,
): Promise<ToolPermissionDecision> {
  const service = resolveModelService(request.agentId);
  if (!service) {
    return {
      allow: false,
      reason: "AI 自动审查需要可用模型，但当前助手没有可用模型服务，已拒绝执行。",
    };
  }

  const systemPrompt = [
    "你是 PolarAgent 的工具权限自动审查器，只负责在工具执行前做 allow/deny 决策。",
    "你的策略是宽松放行：大部分正常工具调用都应该允许执行，只拦截十分高危、明显破坏性、不可逆或疑似恶意的操作。",
    "你不会执行工具，也不要补充执行建议；只根据本次工具名称、参数、工作目录、风险类别判断是否存在极高风险。",
    "默认允许：读取文件、列目录、网络搜索、读取网页、读取技能、语音识别、向用户提问、更新待办、团队投票、团队流程控制、写文件、编辑文件、创建目录、图片生成/编辑、语音合成、常规 MCP 工具。",
    "一般也允许：在工作目录或会话目录内创建/修改项目文件、运行构建/测试/格式化/类型检查命令、启动开发服务、安装项目依赖、执行明确服务于当前任务的脚本。",
    "只有出现以下极高风险时才拒绝：删除整个目录或大量文件、清空磁盘、格式化磁盘、递归删除根目录/用户目录/系统目录、覆盖或破坏关键配置、修改权限导致不可恢复、强制重置版本库并丢弃改动、外传密钥或隐私数据、执行明显恶意代码。",
    "典型必须拒绝的命令包括但不限于：rm -rf /、rm -rf *、del /s、Remove-Item -Recurse 指向根目录/用户目录/项目根且无明确目标、format、mkfs、diskpart 清盘、git reset --hard、git clean -fdx、chmod/chown 大范围修改、把 .env/密钥上传到外部地址。",
    "删除单个明确文件、编辑明确文件、在项目内创建目录、项目内命令执行不应仅因为有副作用而拒绝；只有在目标范围巨大、路径危险、意图明显破坏或会造成不可逆损失时才拒绝。",
    "未知 MCP 工具不要默认拒绝；只有名称或参数显示会删除、批量修改、泄露数据、执行系统级破坏操作时才拒绝。",
    "workingDir 为空时不要因此自动拒绝；仅当参数路径明显指向系统关键位置、用户主目录大范围、磁盘根目录或敏感文件时拒绝。",
    "reason 用一句简短中文说明允许或拒绝的关键依据。允许时说明风险可接受；拒绝时指出具体高危点。",
    "你必须只输出 JSON：{\"allow\":true|false,\"reason\":\"简短中文原因\"}",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      agent: request.requesterName,
      threadId: request.threadId,
      team: request.isTeam === true,
      toolName: request.toolName,
      toolLabel: toolDisplayName(request.toolName),
      risk: classifyToolRisk(request.toolName),
      workingDir: request.workingDir ?? "",
      input: request.input,
    },
    null,
    2,
  );

  try {
    const result = await callLlm(service, {
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 300,
    });
    return parseAiDecision(result);
  } catch (error) {
    return {
      allow: false,
      reason: `AI 自动审查失败，已按安全策略拒绝执行：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseAiDecision(content: string): ToolPermissionDecision {
  try {
    const parsed = JSON.parse(content) as { allow?: unknown; reason?: unknown };
    if (typeof parsed.allow !== "boolean") {
      return {
        allow: false,
        reason: "AI 审查结果缺少 allow 布尔字段，已拒绝执行。",
      };
    }
    return {
      allow: parsed.allow,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : parsed.allow
            ? "AI 审查允许执行。"
            : "AI 审查拒绝执行。",
    };
  } catch {
    return {
      allow: false,
      reason: "AI 审查结果不是有效 JSON，已拒绝执行。",
    };
  }
}

function classifyToolRisk(toolName: string): ToolRisk {
  if (READ_ONLY_TOOLS.has(toolName)) return toolName.startsWith("web_") ? "network" : "read";
  if (SAFE_STATE_TOOLS.has(toolName)) return "interaction";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (EXECUTE_TOOLS.has(toolName)) return "execute";
  if (toolName.startsWith("mcp_")) return "unknown";
  return "unknown";
}
