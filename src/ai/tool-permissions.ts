// 工具权限审查：接入 pi-agent 的 before_tool 钩子，在真实执行前决定 allow/deny。
// 使用统一轻量调用层，跟随设置中的 provider 路由配置。
//
// 工具面收窄到 pisdk 原生四件套后，风险集合只剩三类：
//   read  只读    —— read
//   write 写文件  —— write / edit
//   execute 执行  —— bash（唯一高风险项）

import { callLlm } from "./llm-call";
import { toolDisplayName } from "./tools";
import { resolveModelService } from "./model-router";
import {
  extractLabeledBoolean,
  extractLastLabeledValue,
  normalizeLooseBoolean,
  parseJsonObjectCandidates,
} from "./structured-output";
import type { ToolPermissionMode } from "@/types/permissions";

export interface ToolPermissionRequest {
  requesterName: string;
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  permissionMode: ToolPermissionMode;
  workingDir?: string;
}

export interface ToolPermissionDecision {
  allow: boolean;
  reason?: string;
}

type ToolRisk = "read" | "write" | "execute" | "unknown";

const READ_ONLY_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const EXECUTE_TOOLS = new Set(["bash"]);

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

  // ai_review 模式：只读直接放行，其余一律交给 AI 审批
  if (mode === "ai_review") {
    if (READ_ONLY_TOOLS.has(request.toolName)) {
      return { allow: true };
    }
    return reviewWithAi(request, mode);
  }

  // safe 模式：使用本地规则
  if (mode === "safe") {
    return reviewSafe(request);
  }

  return { allow: true };
}

function reviewReadonly(request: ToolPermissionRequest): ToolPermissionDecision {
  if (READ_ONLY_TOOLS.has(request.toolName)) {
    return { allow: true };
  }

  const label = toolDisplayName(request.toolName);
  const blockedAction = blockedActionSummary(request.toolName);
  return {
    allow: false,
    reason: `当前工具权限为只读模式，已阻止「${label}」${blockedAction ? `，因为它会${blockedAction}` : ""}。如需执行写入、编辑或命令，请切换权限模式。`,
  };
}

// safe 模式：本地规则审查，不触发 AI。
// 写文件/编辑文件直接放行（目标由工具参数明确指定）；命令则先过危险模式黑名单。
function reviewSafe(request: ToolPermissionRequest): ToolPermissionDecision {
  if (READ_ONLY_TOOLS.has(request.toolName) || WRITE_TOOLS.has(request.toolName)) {
    return { allow: true };
  }

  if (EXECUTE_TOOLS.has(request.toolName)) {
    const command = String(request.input.command ?? "");
    if (isDangerousCommand(command)) {
      return {
        allow: false,
        reason: describeDangerousCommand(command),
      };
    }
    return { allow: true };
  }

  // 未知工具：默认放行
  return { allow: true };
}

function resolveRequestPath(request: ToolPermissionRequest, key: string): string {
  const raw = request.input[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  const normalized = raw.replace(/\\/g, "/");
  const isAbsolute = /^([a-zA-Z]:)?\//.test(normalized);
  if (isAbsolute || !request.workingDir) return normalized;
  return `${request.workingDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${normalized}`;
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
  const service = resolveModelService();
  if (!service) {
    return {
      allow: false,
      reason: "AI 自动审查需要可用模型，但当前没有可用模型服务，已拒绝执行。",
    };
  }

  const systemPrompt = [
    "你是 PolarAgent 的工具权限审批器，需要在工具执行前给出明确审批结论：允许或拒绝。",
    "你不是只有拒绝权，也不是默认放行器；你要基于本次工具名称、参数、工作目录、风险类别，明确判断这次调用是否应当批准。",
    "你不会执行工具，也不要补充执行建议；你只负责审批是否允许继续执行。",
    "当前 Agent 只有四个工具：read（读取文件）、write（写入/覆盖文件）、edit（按 oldText→newText 精确替换）、bash（在工作目录执行 shell 命令）。",
    "默认允许：读取文件、在工作目录或会话目录内写入/编辑明确文件、运行构建/测试/格式化/类型检查命令、启动开发服务、安装项目依赖、执行明确服务于当前任务的脚本。",
    "只有出现以下极高风险时才拒绝：删除整个目录或大量文件、清空磁盘、格式化磁盘、递归删除根目录/用户目录/系统目录、覆盖或破坏关键配置、修改权限导致不可恢复、强制重置版本库并丢弃改动、外传密钥或隐私数据、执行明显恶意代码。",
    "典型必须拒绝的命令包括但不限于：rm -rf /、rm -rf *、del /s、Remove-Item -Recurse 指向根目录/用户目录/项目根且无明确目标、format、mkfs、diskpart 清盘、git reset --hard、git clean -fdx、chmod/chown 大范围修改、把 .env/密钥上传到外部地址。",
    "写入单个明确文件、编辑明确文件、项目内命令执行不应仅因为有副作用而拒绝；只有在目标范围巨大、路径危险、意图明显破坏或会造成不可逆损失时才拒绝。",
    "workingDir 为空时不要因此自动拒绝；仅当参数路径明显指向系统关键位置、用户主目录大范围、磁盘根目录或敏感文件时拒绝。",
    "无论允许还是拒绝，reason 都必须说明审批依据。",
    "如果拒绝，reason 必须点明触发拒绝的具体危险点，至少包含以下之一：具体命令片段、目标路径、删除范围、外传对象、权限提升动作、会被破坏的数据范围。",
    "如果拒绝，不要只写“存在风险”“高危操作”“不安全”“建议谨慎”“建议拒绝”这类通用套话；必须写清楚“什么东西有风险，以及会造成什么后果”。",
    "如果允许，也要简要说明为什么可以批准，例如“项目目录内的常规测试命令”“目标文件位于工作目录内且范围明确”。",
    "",
    "你必须只输出一个 JSON 对象，不要输出解释、代码块、前后缀、Markdown 或任何额外文字。",
    "JSON 必须包含：allow（布尔值 true/false）和 reason（字符串）。allow=true 表示批准执行，allow=false 表示拒绝执行。",
    "错误示例（禁止这样输出）：允许执行。原因是这是常规读文件操作。",
    '错误示例（禁止这样输出）：```json {"allow": false} ```',
    '错误示例（禁止这样输出）：{"allow": false, "reason": "存在安全风险"}',
    "正确示例 1：",
    '{"allow":true,"reason":"项目目录内的常规文件读取操作，范围明确"}',
    "正确示例 2：",
    '{"allow":false,"reason":"命令包含 rm -rf /，会递归删除根目录并造成不可逆破坏"}',
    "如果你一开始输出过非 JSON 内容，必须立刻改为只输出单个 JSON 对象。",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      agent: request.requesterName,
      threadId: request.threadId,
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
      debugLabel: "tool-permission",
    });
    return finalizePermissionDecision(request, parseAiDecision(result));
  } catch (error) {
    return {
      allow: false,
      reason: `AI 自动审查失败，已按安全策略拒绝执行：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function parseAiDecision(content: string): ToolPermissionDecision {
  console.debug("[tool-permission] raw-response", content);

  for (const parsed of parseJsonObjectCandidates(content)) {
    console.debug("[tool-permission] parsed-json-candidate", parsed);
    const decision = decisionFromParsedRecord(parsed);
    if (decision) {
      console.debug("[tool-permission] parsed-decision", decision);
      return decision;
    }
  }

  const veto =
    extractLabeledBoolean(content, ["deny", "denied", "reject", "rejected", "block", "blocked", "拒绝", "禁止", "拦截"]) ??
    inferVetoFromFreeText(content);

  if (veto == null) {
    return {
      allow: true,
      reason: "AI 审批未给出明确允许或拒绝结论，按默认放行处理。",
    };
  }

  if (!veto) {
    const reason =
      extractLastLabeledValue(content, ["reason", "原因", "说明", "备注", "依据"]) ??
      extractReasonFromFreeText(content, true);
    const decision = {
      allow: true,
      reason: normalizeDecisionReason(true, reason),
    };
    console.debug("[tool-permission] fallback-decision", decision);
    return decision;
  }

  const reason =
    extractLastLabeledValue(content, ["reason", "原因", "说明", "备注", "依据"]) ??
    extractReasonFromFreeText(content, false) ??
    extractReasonFromUnlabeledDenyText(content);
  const decision = {
    allow: false,
    reason: normalizeDeniedDecisionReason(reason),
  };
  console.debug("[tool-permission] fallback-decision", decision);
  return decision;
}

function decisionFromParsedRecord(parsed: Record<string, unknown>): ToolPermissionDecision | null {
  const veto = firstBooleanValue([
    parsed.deny,
    parsed.denied,
    parsed.reject,
    parsed.rejected,
    parsed.block,
    parsed.blocked,
  ]);

  if (veto != null) {
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.explanation === "string"
            ? parsed.explanation
            : null;

    return veto
      ? {
          allow: false,
          reason: normalizeDeniedDecisionReason(reason),
        }
      : {
          allow: true,
          reason: normalizeDecisionReason(true, reason),
        };
  }

  const allow = firstBooleanValue([
    parsed.allow,
    parsed.allowed,
    parsed.decision,
    parsed.result,
    parsed.verdict,
  ]);
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
  return allow ? "已通过 AI 审批。" : "AI 审批已拒绝执行。";
}

function inferDecisionFromFreeText(content: string): boolean | null {
  const text = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const labeledVerdictPatterns: Array<{ pattern: RegExp; value: boolean }> = [
    { pattern: /(?:审查结论|结论|结果|最终决定|决定)\s*[:：]?\s*(?:允许|通过|放行|批准|同意)/i, value: true },
    { pattern: /(?:审查结论|结论|结果|最终决定|决定)\s*[:：]?\s*(?:拒绝|禁止|拦截|不通过|不允许)/i, value: false },
  ];
  for (const entry of labeledVerdictPatterns) {
    if (entry.pattern.test(text)) return entry.value;
  }

  const sentencePatterns: Array<{ pattern: RegExp; value: boolean }> = [
    { pattern: /(?:建议|应当|可以|可|应该)?\s*(?:允许执行|允许本次操作|可执行|可以执行|建议放行|建议允许|予以放行)/i, value: true },
    { pattern: /(?:建议|应当|应该)?\s*(?:拒绝执行|拒绝本次操作|禁止执行|阻止执行|不应执行|不建议执行|建议拒绝)/i, value: false },
  ];
  for (const entry of sentencePatterns) {
    if (entry.pattern.test(text)) return entry.value;
  }

  return null;
}

function inferVetoFromFreeText(content: string): boolean | null {
  const allow = inferDecisionFromFreeText(content);
  if (allow == null) return null;
  return !allow;
}

function extractReasonFromFreeText(content: string, allow: boolean): string | null {
  const compact = content.replace(/```(?:json|text)?\s*/gi, "").replace(/\s*```/g, "").trim();
  if (!compact) return null;

  const reasonMatch = compact.match(/(?:原因|说明|理由|依据|because)\s*[:：]\s*([^\r\n]+)/i);
  if (reasonMatch?.[1]) {
    return reasonMatch[1].trim();
  }

  const lines = compact
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.length < 4) continue;
    if (/^(?:allow|allowed|decision|result|结论|审查结论)\s*[:：=]/i.test(line)) continue;
    if (allow && /(?:允许|通过|放行)/.test(line)) return line;
    if (!allow && /(?:拒绝|禁止|拦截|高危|风险)/.test(line)) return line;
  }

  return null;
}

function extractReasonFromUnlabeledDenyText(content: string): string | null {
  const compact = content.replace(/```(?:json|text)?\s*/gi, "").replace(/\s*```/g, "").trim();
  if (!compact) return null;

  const lines = compact
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 4) continue;
    if (/^(?:allow|allowed|decision|result|结论|审查结论)\s*[:：=]/i.test(line)) continue;
    if (/^(?:\{|\[)/.test(line)) continue;
    if (/(?:高危|风险|危险|破坏性|不可逆|敏感|系统目录|根目录|删除大量文件|外传|越权)/.test(line)) {
      return line;
    }
  }

  for (const line of lines) {
    if (line.length < 6) continue;
    if (/^(?:\{|\[)/.test(line)) continue;
    if (/^(?:以下|说明|补充|注意)/.test(line)) continue;
    return line;
  }

  return null;
}

function normalizeFallbackReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;

  const trimmed = reason
    .replace(/^(?:reason|原因|说明|依据|备注)\s*[:：-]?\s*/i, "")
    .trim();
  if (!trimmed) return null;

  if (/^(?:嗯|哦|好的|收到|需要更多信息|信息不足|无法判断|暂时无法判断)[。！!？?\s]*$/i.test(trimmed)) {
    return null;
  }

  return trimmed.replace(/[。；;，,\s]+$/u, "");
}

function normalizeDeniedDecisionReason(reason: string | null | undefined): string {
  const normalized = normalizeFallbackReason(reason);
  if (normalized) return normalized;
  return "AI 审批给出了拒绝结论，但未提供具体风险点；已按拒绝结论阻止执行。";
}

function finalizePermissionDecision(
  request: ToolPermissionRequest,
  decision: ToolPermissionDecision,
): ToolPermissionDecision {
  if (decision.allow) {
    return decision;
  }

  const reason = normalizeDeniedReasonForRequest(request, decision.reason);
  return {
    allow: false,
    reason,
  };
}

function normalizeDeniedReasonForRequest(
  request: ToolPermissionRequest,
  reason: string | null | undefined,
): string {
  const normalized = normalizeFallbackReason(reason);
  if (normalized && !isGenericDeniedReason(normalized)) {
    return normalized;
  }

  return buildSpecificDeniedReason(request);
}

function isGenericDeniedReason(reason: string): boolean {
  const compact = reason.replace(/[。；;！!？?]+$/u, "").trim();
  if (!compact) return true;

  const genericPatterns = [
    /^(?:存在(?:较大)?风险|高危操作|不安全|风险较高|建议拒绝|建议阻止执行|已拒绝执行|不建议执行|存在安全隐患)$/u,
    /^(?:该操作|本次操作|此操作)(?:存在(?:较大)?风险|风险较高|不安全|不建议执行)$/u,
    /^(?:命令|路径|参数)(?:存在(?:较大)?风险|不安全)$/u,
  ];
  if (genericPatterns.some((pattern) => pattern.test(compact))) {
    return true;
  }

  const hasConcreteMarker =
    /[`'"\/\\:.]/.test(compact) ||
    /(根目录|系统目录|工作目录|用户目录|磁盘|文件|命令|目录|路径|密钥|令牌|仓库|改动|数据|外传|上传|删除)/.test(compact);
  return !hasConcreteMarker;
}

function buildSpecificDeniedReason(request: ToolPermissionRequest): string {
  if (request.toolName === "bash") {
    return describeDangerousCommand(String(request.input.command ?? ""));
  }

  if (WRITE_TOOLS.has(request.toolName)) {
    const targetPath = resolveRequestPath(request, "path") || String(request.input.path ?? "");
    return targetPath
      ? `写入操作被拒绝：目标路径「${targetPath}」超出安全边界，需要人工确认后再执行。`
      : "写入操作被拒绝：本次调用未给出明确的写入目标，无法确认影响范围。";
  }

  const risk = classifyToolRisk(request.toolName);
  const inputSummary = summarizeSensitiveInput(request.input);
  return inputSummary
    ? `工具「${toolDisplayName(request.toolName)}」被拒绝，因为参数 ${inputSummary} 对应 ${riskLabel(risk)}操作，存在超出安全边界的副作用，需要人工确认。`
    : `工具「${toolDisplayName(request.toolName)}」被拒绝，因为本次调用涉及 ${riskLabel(risk)}操作，存在超出安全边界的副作用，需要人工确认。`;
}

function blockedActionSummary(toolName: string): string {
  switch (classifyToolRisk(toolName)) {
    case "write":
      return "修改或覆盖文件";
    case "execute":
      return "执行系统命令";
    default:
      return "产生写入或外部副作用";
  }
}

function describeDangerousCommand(command: string): string {
  const trimmed = command.trim();
  const snippet = commandSnippet(trimmed);

  const patterns: Array<{ pattern: RegExp; reason: (match: RegExpMatchArray) => string }> = [
    {
      pattern: /\bgit\s+reset\s+--hard\b/i,
      reason: () => `安全模式下，命令「${snippet}」包含 git reset --hard，会强制丢弃当前工作区改动。`,
    },
    {
      pattern: /\bgit\s+clean\s+-fdx\b/i,
      reason: () => `安全模式下，命令「${snippet}」包含 git clean -fdx，会批量删除未跟踪文件和构建产物。`,
    },
    {
      pattern: /\b(shutdown|reboot|halt|poweroff)\b/i,
      reason: (match) => `安全模式下，命令「${snippet}」包含 ${match[1]}，会直接中断当前系统或进程运行。`,
    },
    {
      pattern: /\b(mkfs(?:\.\w+)?|diskpart)\b/i,
      reason: (match) => `安全模式下，命令「${snippet}」包含 ${match[1]}，会对磁盘或分区执行破坏性操作。`,
    },
    {
      pattern: /\bformat\s+([a-z]:)/i,
      reason: (match) => `安全模式下，命令「${snippet}」尝试格式化磁盘 ${match[1]}，属于不可逆破坏操作。`,
    },
    {
      pattern: /\bdd\b[^|;&]*\bof=(\/dev\/[a-z0-9]+)/i,
      reason: (match) => `安全模式下，命令「${snippet}」会向设备 ${match[1]} 直接写入数据，可能破坏磁盘内容。`,
    },
    {
      pattern: />\s*(\/dev\/[a-z0-9]+)/i,
      reason: (match) => `安全模式下，命令「${snippet}」会把输出重定向到设备 ${match[1]}，可能直接覆盖磁盘内容。`,
    },
    {
      pattern: /:\s*\(\s*\)\s*\{.*:.*\}/i,
      reason: () => `安全模式下，命令「${snippet}」包含 fork bomb 模式，会迅速耗尽系统资源。`,
    },
    {
      pattern: /\b(?:rm|del|Remove-Item)\b[\s\S]{0,120}?((?:\/|~|\$HOME|\\|[A-Za-z]:\\)[^\s"']*)/i,
      reason: (match) => `安全模式下，命令「${snippet}」试图删除或递归处理高风险路径「${match[1]}」，可能造成大范围不可逆删除。`,
    },
  ];

  for (const entry of patterns) {
    const match = trimmed.match(entry.pattern);
    if (match) {
      return entry.reason(match);
    }
  }

  if (!trimmed) {
    return "安全模式下，该命令缺少可审查的具体内容，无法批准执行。";
  }

  return `安全模式下，命令「${snippet}」命中了高危命令规则，存在不可逆副作用或超出工作区边界的风险。`;
}

function summarizeSensitiveInput(
  input: Record<string, unknown>,
  preferredKeys: string[] = ["path", "command"],
): string {
  for (const key of preferredKeys) {
    const value = input[key];
    const summarized = summarizeInputValue(value);
    if (summarized) {
      return `「${key}=${summarized}」`;
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const summarized = summarizeInputValue(value);
    if (summarized) {
      return `「${key}=${summarized}」`;
    }
  }

  return "";
}

function summarizeInputValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? commandSnippet(trimmed) : "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    const first = summarizeInputValue(value[0]);
    return first ? `${first}${value.length > 1 ? ` 等 ${value.length} 项` : ""}` : "";
  }
  return "";
}

function commandSnippet(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function riskLabel(risk: ToolRisk): string {
  switch (risk) {
    case "read":
      return "读取";
    case "write":
      return "写入";
    case "execute":
      return "命令执行";
    default:
      return "未知";
  }
}

function firstBooleanValue(values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    const normalized = normalizeLooseBoolean(value);
    if (normalized != null) return normalized;
  }
  return null;
}

function classifyToolRisk(toolName: string): ToolRisk {
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (EXECUTE_TOOLS.has(toolName)) return "execute";
  return "unknown";
}
