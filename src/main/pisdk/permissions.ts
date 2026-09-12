// 工具权限：风险评估 + 「始终允许」规则库；规则独立落盘，不污染 settings.json。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessCommand } from "@/main/security/command-guard";
import { isMcpToolName } from "@/shared/contracts/mcp";
import { BACKGROUND_JOB_TOOL_NAMES } from "./tools/jobs";

/**
 * always_allow 规则：工具名 + 可选参数片段（缺省表示该工具全部放行）。
 *
 * toolName 以 `*` 结尾时按**前缀**匹配（`mcp__<server>__*` = 该 server 的全部工具）。
 * 这是 MCP 的前置要求：外部工具名由 server 决定、数量不可预知，逐工具写规则等于
 * 每次调用都要点一次审批卡（见 docs/agent-tools-and-upgrade-guide.md 的 P2-3）。
 * 内置工具名不含 `*`，因此行为与扩展前完全一致。
 */
export interface PermissionRule {
  toolName: string;
  /** 命中条件为 argsText.includes(pattern)；缺省表示不做参数限定 */
  pattern?: string;
  createdAt: number;
}

export interface PermissionRuleStore {
  list(): Promise<PermissionRule[]>;
  add(rule: PermissionRule): Promise<void>;
  /** 移除规则；pattern 缺省表示移除该工具的全部规则 */
  remove(toolName: string, pattern?: string): Promise<void>;
  matches(toolName: string, argsText: string): Promise<boolean>;
}

// 风险常量表写死：只读工具放行，写类工具一律审批，未知工具按高风险兜底。
// ask_user 也在低风险里：它只是弹一张提问卡、不触碰工作区，归入高风险会让每次提问
// 都先弹一张「批准提问」的审批卡 —— 用户得连点两次才能回答一个问题。
// job_output / job_list / job_kill 同理：它们只读**自己会话**的作业状态，或杀掉自己起的进程
// （作业本来就活不过会话结束），归入高风险会让模型每次看日志都要用户点一次批准卡。
// bash_background 不在这里 —— 它与 bash 同级，交给 command-guard 判定。
const LOW_RISK_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "todo",
  "ask_user",
  BACKGROUND_JOB_TOOL_NAMES.output,
  BACKGROUND_JOB_TOOL_NAMES.list,
  BACKGROUND_JOB_TOOL_NAMES.kill,
]);
const HIGH_RISK_TOOLS = new Set(["write", "edit"]);
/** 会用 shell 跑命令的工具：风险由命令内容决定，与 bash 同一套判定 */
const SHELL_TOOLS = new Set(["bash", BACKGROUND_JOB_TOOL_NAMES.bashBackground]);

/**
 * 风险评估：
 * - read / grep / glob / todo / ask_user / job_output / job_list / job_kill → low
 *   （只读、只记录状态、纯 UI 交互，或只操作本会话的作业，都不触碰工作区文件）；
 * - write / edit → high；
 * - bash / bash_background → 交给 command-guard 黑名单判定，命中即 high；
 * - MCP 外部工具（mcp__<server>__<tool>）→ 一律 high。名字与行为都由外部 server 决定，
 *   这里无法逐个体检；放行只能靠 mcp__<server>__* 前缀规则（用户点「始终允许」时写入）
 *   或 permissionMode 的 full / ai_review。只读提示（readOnlyHint）是 server 的自我声明，
 *   不构成安全依据，故不用它降级。
 * - 未知工具 → high（安全侧默认）。
 */
export function assessToolRisk(toolName: string, args: Record<string, unknown>): "low" | "high" {
  if (LOW_RISK_TOOLS.has(toolName)) return "low";
  if (HIGH_RISK_TOOLS.has(toolName)) return "high";
  if (isMcpToolName(toolName)) return "high";
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof args.command === "string" ? args.command : "";
    return assessCommand(command).risk === "high" ? "high" : "low";
  }
  return "high";
}

/**
 * 单条规则匹配：工具名命中（相等，或以 `*` 结尾时按前缀）且（无 pattern 或 argsText 包含它）。
 */
export function matchesPermissionRule(
  rule: PermissionRule,
  toolName: string,
  argsText: string,
): boolean {
  const name = rule.toolName;
  if (name.endsWith("*")) {
    // 前缀规则：mcp__<server>__* 覆盖该 server 的全部工具（不含 serverId 本身）
    const prefix = name.slice(0, -1);
    if (prefix === "" || !toolName.startsWith(prefix)) return false;
  } else if (name !== toolName) {
    return false;
  }
  const pattern = rule.pattern;
  if (pattern === undefined || pattern === "") return true;
  return argsText.includes(pattern);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 容错解析单条规则：字段非法时丢弃，避免坏数据阻断整个规则库 */
function sanitizeRule(value: unknown): PermissionRule | undefined {
  if (!isRecord(value)) return undefined;
  const toolName = typeof value.toolName === "string" ? value.toolName : "";
  if (toolName === "") return undefined;
  return {
    toolName,
    ...(typeof value.pattern === "string" && value.pattern !== ""
      ? { pattern: value.pattern }
      : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}

/** 创建规则库：持久化到 {baseDir}/permission-rules.json，内存缓存避免重复读盘 */
export function createPermissionRuleStore(baseDir: string): PermissionRuleStore {
  const filePath = path.join(baseDir, "permission-rules.json");
  let cache: PermissionRule[] | undefined;
  // 串行化写入，避免并发 add 覆盖彼此的落盘结果
  let writeChain: Promise<void> = Promise.resolve();

  async function load(): Promise<PermissionRule[]> {
    if (cache) return cache;
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      const list = isRecord(raw) && Array.isArray(raw.rules) ? raw.rules : [];
      cache = list
        .map((item) => sanitizeRule(item))
        .filter((item): item is PermissionRule => item !== undefined);
    } catch {
      // 文件不存在或损坏时视为空规则库
      cache = [];
    }
    return cache;
  }

  async function persist(rules: PermissionRule[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const payload = `${JSON.stringify({ rules }, null, 2)}\n`;
    // 先写临时文件再 rename，避免中断留下半截 JSON
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  }

  return {
    list: async () => [...(await load())],
    add: async (rule) => {
      const rules = await load();
      if (
        !rules.some(
          (existing) => existing.toolName === rule.toolName && existing.pattern === rule.pattern,
        )
      ) {
        rules.push(rule);
      }
      const snapshot = [...rules];
      writeChain = writeChain.catch(() => undefined).then(() => persist(snapshot));
      await writeChain;
    },
    remove: async (toolName, pattern) => {
      const rules = await load();
      const kept = rules.filter(
        (rule) =>
          !(rule.toolName === toolName && (pattern === undefined || rule.pattern === pattern)),
      );
      if (kept.length === rules.length) return;
      // 原地替换缓存内容，保证同一实例的后续读取立即反映删除
      rules.length = 0;
      rules.push(...kept);
      const snapshot = [...kept];
      writeChain = writeChain.catch(() => undefined).then(() => persist(snapshot));
      await writeChain;
    },
    matches: async (toolName, argsText) => {
      const rules = await load();
      return rules.some((rule) => matchesPermissionRule(rule, toolName, argsText));
    },
  };
}

// 进程内唯一实例：运行时权限门与设置面板共用，避免两份缓存不同步
let sharedRuleStore: PermissionRuleStore | null = null;

/** 取共享规则库；baseDir 只在首次调用时生效 */
export function getSharedPermissionRuleStore(baseDir: string): PermissionRuleStore {
  sharedRuleStore ??= createPermissionRuleStore(baseDir);
  return sharedRuleStore;
}
