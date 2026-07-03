/**
 * 工具权限模式 - 控制 AI 对系统的访问级别
 * 
 * - readonly: 只读模式，AI 只能读取文件和执行查询操作
 * - safe: 安全模式（推荐），阻止高危操作（删根目录、格式化磁盘等），适合日常使用
 * - ai_review: AI 审批模式，按工具参数逐次审批，并给出明确允许或拒绝依据
 * - full: 完全权限，AI 拥有与用户相同的系统权限，适合高级用户和自动化任务
 */
export type ToolPermissionMode = "readonly" | "safe" | "ai_review" | "full";

export const DEFAULT_TOOL_PERMISSION_MODE: ToolPermissionMode = "ai_review";

/**
 * 安全级别配置
 */
export interface SecurityLevel {
  mode: ToolPermissionMode;
  description: string;
  allowedOperations: {
    fileWrite: boolean;           // 写入文件
    fileDelete: boolean;          // 删除文件
    shellExec: boolean;           // 执行 Shell 命令
    systemPaths: boolean;         // 访问系统路径（如 /、C:\）
    dangerousCommands: boolean;   // 危险命令（rm -rf /、format 等）
    networkAccess: boolean;       // 网络访问
    processControl: boolean;      // 进程控制（kill、shutdown）
  };
  aiControlled: boolean;          // 是否由 AI 自主判断
}

/**
 * 安全级别定义
 */
export const SECURITY_LEVELS: Record<ToolPermissionMode, SecurityLevel> = {
  readonly: {
    mode: "readonly",
    description: "只读模式 - AI 只能查看文件和系统信息，无法修改任何内容",
    allowedOperations: {
      fileWrite: false,
      fileDelete: false,
      shellExec: false,
      systemPaths: true,  // 可以读取系统路径
      dangerousCommands: false,
      networkAccess: true, // 可以访问网络（查询）
      processControl: false,
    },
    aiControlled: false,
  },
  safe: {
    mode: "safe",
    description: "安全模式 - AI 可以执行大多数操作，但系统会阻止高危命令和系统关键路径",
    allowedOperations: {
      fileWrite: true,
      fileDelete: true,    // 可以删除，但限制在工作目录内
      shellExec: true,
      systemPaths: false,  // 不允许直接操作系统根目录
      dangerousCommands: false, // 阻止 rm -rf /、format、shutdown 等
      networkAccess: true,
      processControl: false,
    },
    aiControlled: false,
  },
  ai_review: {
    mode: "ai_review",
    description: "AI 审批模式（推荐）- 执行前逐次审批，并说明允许或拒绝的具体依据",
    allowedOperations: {
      fileWrite: true,
      fileDelete: true,
      shellExec: true,
      systemPaths: true,   // AI 可访问系统路径，但会自主判断风险
      dangerousCommands: true, // AI 可执行危险命令，但会在执行前评估风险
      networkAccess: true,
      processControl: true, // AI 可控制进程，但会谨慎判断
    },
    aiControlled: true,  // 由 AI 自主决策
  },
  full: {
    mode: "full",
    description: "完全权限 - AI 拥有与用户相同的系统权限，可执行任何操作（无任何限制）",
    allowedOperations: {
      fileWrite: true,
      fileDelete: true,
      shellExec: true,
      systemPaths: true,   // 允许访问所有路径
      dangerousCommands: true, // 允许危险命令
      networkAccess: true,
      processControl: true,
    },
    aiControlled: false,
  },
};
