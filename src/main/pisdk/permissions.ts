// 工具权限：风险评估 + 「始终允许」规则库；规则独立落盘，不污染 settings.json。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessCommand } from "@/main/security/command-guard";

/** always_allow 规则：工具名 + 可选参数片段（缺省表示该工具全部放行） */
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

// 风险常量表写死：只读工具放行，写类工具一律审批，未知工具按高风险兜底
const LOW_RISK_TOOLS = new Set(["read"]);
const HIGH_RISK_TOOLS = new Set(["write", "edit"]);

/**
 * 风险评估：
 * - read → low；
 * - write / edit → high；
 * - bash → 交给 command-guard 黑名单判定，命中即 high；
 * - 未知工具 → high（安全侧默认）。
 */
export function assessToolRisk(toolName: string, args: Record<string, unknown>): "low" | "high" {
  if (LOW_RISK_TOOLS.has(toolName)) return "low";
  if (HIGH_RISK_TOOLS.has(toolName)) return "high";
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return assessCommand(command).risk === "high" ? "high" : "low";
  }
  return "high";
}

/** 单条规则匹配：工具名相等，且（无 pattern 或 argsText 包含 pattern） */
export function matchesPermissionRule(
  rule: PermissionRule,
  toolName: string,
  argsText: string,
): boolean {
  if (rule.toolName !== toolName) return false;
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
