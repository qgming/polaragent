// 工具权限审查：接入 pi-agent 的 tool_call 钩子，在真实执行前决定 allow/deny。
// 使用 pi-ai 统一的 streamSimple API，跟随设置中的 provider 配置。

import { callLlm } from "./llm-call";
import { toolDisplayName } from "./tools";
import { resolvePath } from "./tools/tool-context";
import { resolveModelService } from "./model-router";
import {
  extractLabeledBoolean,
  extractLastLabeledValue,
  normalizeLooseBoolean,
  parseJsonObjectCandidates,
} from "./structured-output";
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
  "search_files",
  "web_search",
  "web_fetch",
  "list_skills",
  "read_skill",
  "read_skill_file",
  "speech_recognition",
  "search_knowledge",
  "search_memory",
  // 安全说明：render_widget 不属于只读 —— AI 提供的 HTML 会在 iframe 渲染
  // 执行脚本，等同代码执行入口。所以不应列入只读集，也不应在 readonly
  // 模式自动放行；它在 HIGH_RISK_TOOLS 中，会走 AI 审查。（本次审计 C1 修正）
]);

const SAFE_STATE_TOOLS = new Set([
  "update_todos",
  "ask_user",
  "request_team_vote",
  "cast_team_vote",
  "control_team_flow",
  // 安全说明：schedule_task 不列入安全档/低风险档。
  // AI 创建后台无人监督任务 == 持久化 + 自动触发 + 用户不在场，必须走
  // AI 审查（reviewWithAi），让审查器评估任务参数是否包含越权意图。
  // schedule_task 也归入 HIGH_RISK_TOOLS，确保 ai_review 模式触发审查。
]);

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "delete_file",
  "move_file",
  "copy_file",
  "image_generation",
  "image_edit",
  "speech_synthesis",
  "create_office_document",
  "remember_memory",
  "forget_memory",
]);

const EXECUTE_TOOLS = new Set(["run_bash"]);

// 低风险工具集合：直接放行，不触发 AI
// 安全说明：render_widget 与 schedule_task 均不列入。
//   - render_widget：内联 HTML 经 iframe 渲染，等同代码执行入口，必须审查。
//   - schedule_task：后台无人监督任务持久化 + AI 可自选权限，必须审查。
const LOW_RISK_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "web_search",
  "web_fetch",
  "list_skills",
  "read_skill",
  "read_skill_file",
  "speech_recognition",
  "search_knowledge",
  "search_memory",
  "update_todos",
  "ask_user",
  "request_team_vote",
  "cast_team_vote",
  "control_team_flow",
]);

// 中风险工具集合：直接放行，不触发 AI
const MEDIUM_RISK_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "move_file",
  "copy_file",
  "image_generation",
  "image_edit",
  "speech_synthesis",
  "create_office_document",
  "remember_memory",
  "forget_memory",
]);

// 高风险工具集合：触发 AI 审查
// 安全说明：
//   - delete_file / run_bash：原高风险
//   - render_widget：AI 内联 HTML 在 iframe 渲染 ≈ 代码执行
//     （曾经被列入 LOW_RISK 自动放行，本次审计 C1 后纠正）
//   - schedule_task：后台无人监督持久化任务 + AI 可选权限档
//     （曾经被列入 LOW_RISK 自动放行，本次审计 C3 后纠正）
const HIGH_RISK_TOOLS = new Set([
  "delete_file",
  "run_bash",
  "render_widget",
  "schedule_task",
]);

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

  // ai_review 模式：分层审查
  if (mode === "ai_review") {
    const directDecision = reviewAiReview(request);
    if (directDecision) {
      return directDecision;
    }

    // 高风险操作触发 AI 审查
    if (HIGH_RISK_TOOLS.has(request.toolName) || request.toolName.startsWith("mcp_")) {
      return reviewWithAi(request, mode);
    }

    // 未知工具：触发 AI 审查
    return reviewWithAi(request, mode);
  }

  // safe 模式：使用本地规则
  if (mode === "safe") {
    return reviewSafe(request);
  }

  return { allow: true };
}

function reviewAiReview(request: ToolPermissionRequest): ToolPermissionDecision | null {
  if (LOW_RISK_TOOLS.has(request.toolName) || MEDIUM_RISK_TOOLS.has(request.toolName)) {
    return { allow: true };
  }

  // 安全说明（H1, H3）：曾经在此处对 delete_file 与 run_bash 做"工作目录/
  // 本地黑名单"自动放行，但这等价于 fail-open 删除/执行：
  //   - H1：isDangerousCommand 黑名单覆盖不全（漏 powershell -enc、
  //     schtasks /create、密钥外传等），命中黑名单才送 AI 审查的设计等于
  //     "默认允许任意未匹配黑名单的命令"。run_bash 现在直接送 AI 审查。
  //   - H3：isWithinWorkingDir 在 workingDir 为空时 return true，导致
  //     未绑定工作目录的会话中 delete_file 任意路径都被自动放行。
  //     delete_file 现在直接送 AI 审查。
  // delete_file、run_bash 已列入 HIGH_RISK_TOOLS，会被外层走 reviewWithAi。
  return null;
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

// safe 模式：使用本地规则审查，不触发 AI
function reviewSafe(request: ToolPermissionRequest): ToolPermissionDecision {
  // 低风险/中风险操作直接放行
  if (LOW_RISK_TOOLS.has(request.toolName) || MEDIUM_RISK_TOOLS.has(request.toolName)) {
    return { allow: true };
  }

  // 删除文件：检查是否在工作目录内
  if (request.toolName === "delete_file") {
    const targetPath = resolveRequestPath(request, "path");
    if (isWithinWorkingDir(targetPath, request.workingDir)) {
      return { allow: true };
    }
    return {
      allow: false,
      reason: "安全模式下，删除操作仅限于工作目录内。",
    };
  }

  // Shell 命令：检查危险模式
  if (request.toolName === "run_bash") {
    const command = String(request.input.command ?? "");
    if (isDangerousCommand(command)) {
      return {
        allow: false,
        reason: "安全模式下，检测到高危命令，已阻止执行。",
      };
    }
    return { allow: true };
  }

  // MCP 工具：默认放行（由工具自身控制）
  if (request.toolName.startsWith("mcp_")) {
    return { allow: true };
  }

  // 未知工具：默认放行
  return { allow: true };
}

function resolveRequestPath(request: ToolPermissionRequest, key: string): string {
  const raw = request.input[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  try {
    // 用 as 而非完整 ToolContext —— resolvePath 仅消费 workingDir 字段。
    // 之前用 as { workingDir?: string } 转换后类型不合 ToolContext，
    // 这里改用最小 cast：只构造 resolvePath 实际使用的字段。
    return resolvePath({ workingDir: request.workingDir } as unknown as Parameters<typeof resolvePath>[0], raw);
  } catch {
    return raw;
  }
}

// 判断目标路径是否在工作目录内
// 安全说明（H3）：曾经 workingDir 为空时 return true，导致未绑定工作目录
// 的会话中 delete_file 的任意路径都被判定为"在工作目录内"自动放行。
// 修正为 return false —— 工作目录未设置即视为"不在工作目录内"，
// 调用方应在 safe/ai_review 模式下对不确定路径一律 deny 或送 AI 审查。
function isWithinWorkingDir(targetPath: string, workingDir?: string): boolean {
  if (!workingDir || !targetPath) return false;
  const normalizedTarget = targetPath.toLowerCase().replace(/\\/g, "/");
  // 确保末尾带 / 防止前缀绕过（如 /project 匹配 /project-evil）
  const normalizedWorkDir = workingDir.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "") + "/";
  return normalizedTarget.startsWith(normalizedWorkDir);
}

// 判断命令是否包含高危模式
function isDangerousCommand(command: string): boolean {
  const dangerousPatterns = [
    /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*|--recursive)\b[^|;&]*\s(\/|~|\$HOME|\\|C:\\)(\s|$)/i,
    /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|C:\\)(\s|$)/i,
    /\b(shutdown|reboot|halt|poweroff)\b/i,
    /\b(mkfs(\.\w+)?|diskpart)\b/i,
    /\bformat\s+[a-z]:/i,
    /\bdd\b[^|;&]*\bof=\/dev\/(sd|hd|nvme|disk|vd)/i,
    />\s*\/dev\/(sd|hd|nvme|disk|vd)/i,
    /:\s*\(\s*\)\s*\{.*:.*\}/i, // fork 炸弹
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-fdx\b/i,
  ];
  return dangerousPatterns.some((pattern) => pattern.test(command));
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
    "reason 用一句简短中文说明允许或拒绝的关键依据。",
    "",
    "优先只输出纯 JSON 对象（不要包含代码块标记）。如果模型能力限制导致不能稳定输出 JSON，至少输出可提取的 allow/reason 键值。",
    "标准允许示例：",
    '{"allow": true, "reason": "常规文件读取操作，风险可接受"}',
    "标准拒绝示例：",
    '{"allow": false, "reason": "递归删除根目录，高危操作"}',
    "退化允许示例：",
    "allow: true\nreason: 常规文件读取操作，风险可接受",
    "退化拒绝示例：",
    "allow: false\nreason: 递归删除根目录，高危操作",
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
      jsonMode: true,
    });
    return parseAiDecision(result);
  } catch (error) {
    return {
      allow: false,
      reason: `AI 自动审查失败，已按安全策略拒绝执行：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function parseAiDecision(content: string): ToolPermissionDecision {
  for (const parsed of parseJsonObjectCandidates(content)) {
    const decision = decisionFromParsedRecord(parsed);
    if (decision) {
      return decision;
    }
  }

  const allow = extractLabeledBoolean(content, ["allow", "allowed", "decision", "result"]);
  if (allow == null) {
    return {
      allow: false,
      reason: "AI 审查结果缺少可识别的 allow 字段，已拒绝执行。",
    };
  }

  const reason = extractLastLabeledValue(content, ["reason", "原因", "说明"]);
  return {
    allow,
    reason: normalizeDecisionReason(allow, reason),
  };
}

function decisionFromParsedRecord(parsed: Record<string, unknown>): ToolPermissionDecision | null {
  const allow =
    typeof parsed.allow === "boolean"
      ? parsed.allow
      : normalizeLooseBoolean(parsed.allow);
  if (allow == null) return null;

  const reason =
    typeof parsed.reason === "string"
      ? parsed.reason
      : typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.explanation === "string"
          ? parsed.explanation
          : null;

  return {
    allow,
    reason: normalizeDecisionReason(allow, reason),
  };
}

function normalizeDecisionReason(allow: boolean, reason: string | null | undefined): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed) return trimmed;
  return allow ? "已通过自动审查。" : "自动审查已拒绝执行。";
}

function classifyToolRisk(toolName: string): ToolRisk {
  if (READ_ONLY_TOOLS.has(toolName)) return toolName.startsWith("web_") ? "network" : "read";
  if (SAFE_STATE_TOOLS.has(toolName)) return "interaction";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (EXECUTE_TOOLS.has(toolName)) return "execute";
  if (toolName.startsWith("mcp_")) return "unknown";
  return "unknown";
}
