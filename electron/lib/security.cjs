/**
 * 安全策略中间件
 * 根据用户设置的权限模式，动态控制文件系统和命令执行的访问权限
 * 
 * 四级安全模式：
 * - readonly: 只读，AI 只能读取
 * - safe: 安全，系统阻止高危操作
 * - ai_review: AI 审查，由 AI 自主判断风险（默认）
 * - full: 完全权限，无任何限制
 */

const path = require("node:path");
const os = require("node:os");

// 运行时安全模式（由渲染进程通过 IPC 同步）
let _runtimeMode = null;

/**
 * 设置运行时安全模式（由前端 IPC 调用）
 * @param {'readonly' | 'safe' | 'ai_review' | 'full'} mode
 */
function setSecurityMode(mode) {
  _runtimeMode = mode;
}

/**
 * 获取当前安全模式
 * 优先级：运行时模式 > 环境变量 > 默认值
 * @returns {'readonly' | 'safe' | 'ai_review' | 'full'}
 */
function getSecurityMode() {
  return _runtimeMode || process.env.POLARAGENT_SECURITY_MODE || "ai_review";
}

/**
 * 检查路径是否为系统关键路径
 * @param {string} targetPath - 目标路径
 * @returns {boolean}
 */
function isSystemCriticalPath(targetPath) {
  const normalized = path.normalize(targetPath).toLowerCase();
  
  // Windows 系统路径
  if (process.platform === "win32") {
    const systemPaths = [
      "c:\\windows",
      "c:\\program files",
      "c:\\program files (x86)",
      "c:\\programdata",
      "c:\\users\\default",
      "c:\\users\\public",
      "c:\\$recycle.bin",
    ];
    
    // 检查是否在系统盘根目录（C:\）
    if (/^[a-z]:\\?$/i.test(targetPath)) {
      return true;
    }
    
    return systemPaths.some(sp => normalized.startsWith(sp.toLowerCase()));
  }
  
  // Unix/Linux/macOS 系统路径
  const unixSystemPaths = [
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/var",
    "/sys",
    "/proc",
    "/boot",
    "/dev",
    "/lib",
    "/lib64",
    "/opt",
    "/root",
  ];
  
  // 根目录
  if (normalized === "/") {
    return true;
  }
  
  return unixSystemPaths.some(sp => normalized.startsWith(sp));
}

/**
 * 校验文件路径访问权限
 * @param {string} targetPath - 目标路径
 * @param {'read' | 'write' | 'delete'} operation - 操作类型
 * @returns {{ allowed: boolean, reason?: string, aiReview?: boolean }}
 */
function validateFileAccess(targetPath, operation) {
  const mode = getSecurityMode();
  const resolved = path.resolve(targetPath);
  
  // readonly 模式：只允许读取
  if (mode === "readonly") {
    if (operation !== "read") {
      return {
        allowed: false,
        reason: `只读模式下不允许 ${operation} 操作`,
      };
    }
    return { allowed: true };
  }
  
  // safe 模式：阻止系统关键路径的写入和删除
  if (mode === "safe") {
    if (operation === "write" || operation === "delete") {
      if (isSystemCriticalPath(resolved)) {
        return {
          allowed: false,
          reason: `安全模式下不允许 ${operation} 系统关键路径: ${resolved}`,
        };
      }
    }
    return { allowed: true };
  }
  
  // ai_review 模式：允许操作，但标记为需要 AI 审查
  if (mode === "ai_review") {
    const isSystemPath = isSystemCriticalPath(resolved);
    
    if ((operation === "write" || operation === "delete") && isSystemPath) {
      return {
        allowed: true,
        aiReview: true,  // 标记为需要 AI 审查
        reason: `操作涉及系统关键路径，AI 应自主评估风险: ${resolved}`,
      };
    }
    
    return { allowed: true, aiReview: false };
  }
  
  // full 模式：允许所有操作
  return { allowed: true };
}

/**
 * 校验 Shell 命令执行权限
 * @param {string} command - 命令字符串
 * @returns {{ allowed: boolean, reason?: string, shouldBlock?: boolean, aiReview?: boolean }}
 */
function validateShellCommand(command) {
  const mode = getSecurityMode();
  
  // readonly 模式：不允许执行命令
  if (mode === "readonly") {
    return {
      allowed: false,
      reason: "只读模式下不允许执行 Shell 命令",
    };
  }
  
  // 定义危险命令模式
  const dangerousPatterns = [
    // 递归强删根目录或家目录
    { test: /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*|--recursive)\b[^|;&]*\s(\/|~|\$HOME|\\|C:\\)(\s|$)/i, reason: "检测到删除根目录或家目录的高危操作", level: "critical" },
    { test: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|C:\\)(\s|$)/i, reason: "检测到强制递归删除根目录的高危操作", level: "critical" },
    // 关机/重启
    { test: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "检测到关机/重启命令", level: "critical" },
    // 磁盘格式化
    { test: /\b(mkfs(\.\w+)?|diskpart)\b/i, reason: "检测到磁盘格式化命令", level: "critical" },
    { test: /\bformat\s+[a-z]:/i, reason: "检测到磁盘格式化命令", level: "critical" },
    // 直接写裸磁盘设备
    { test: /\bdd\b[^|;&]*\bof=\/dev\/(sd|hd|nvme|disk|vd)/i, reason: "检测到覆写磁盘设备的高危操作", level: "critical" },
    { test: />\s*\/dev\/(sd|hd|nvme|disk|vd)/i, reason: "检测到向裸磁盘设备重定向写入", level: "critical" },
    // fork 炸弹
    { test: /:\s*\(\s*\)\s*\{.*:.*\}/i, reason: "检测到 fork 炸弹模式", level: "critical" },
    // 递归改根目录权限/属主
    { test: /\bchmod\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\b[^|;&]*\s(\/|C:\\)(\s|$)/i, reason: "检测到递归修改根目录权限", level: "high" },
    { test: /\bchown\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\b[^|;&]*\s(\/|C:\\)(\s|$)/i, reason: "检测到递归修改根目录属主", level: "high" },
  ];
  
  // 检查是否命中危险模式
  let matchedPattern = null;
  for (const pattern of dangerousPatterns) {
    if (pattern.test.test(command)) {
      matchedPattern = pattern;
      break;
    }
  }
  
  // safe 模式：直接阻止危险命令
  if (mode === "safe" && matchedPattern) {
    return {
      allowed: false,
      reason: `命令被安全策略拦截：${matchedPattern.reason}`,
      shouldBlock: true,
    };
  }
  
  // ai_review 模式：允许但标记为需要 AI 审查
  if (mode === "ai_review" && matchedPattern) {
    return {
      allowed: true,
      aiReview: true,
      reason: `检测到高危命令，AI 应自主评估风险：${matchedPattern.reason}`,
      riskLevel: matchedPattern.level,
    };
  }
  
  // full 模式：允许所有命令
  return { allowed: true };
}

/**
 * 检查是否允许访问外部URL
 * @param {string} url - 目标URL
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateExternalAccess(url) {
  const mode = getSecurityMode();
  
  // readonly 模式：允许读取
  if (mode === "readonly") {
    return { allowed: true };
  }
  
  // 所有模式都允许标准协议
  try {
    const parsed = new URL(url);
    const allowedProtocols = ["http:", "https:", "file:"];
    
    if (!allowedProtocols.includes(parsed.protocol)) {
      return {
        allowed: false,
        reason: `不允许的协议: ${parsed.protocol}`,
      };
    }
  } catch {
    return {
      allowed: false,
      reason: "无效的 URL 格式",
    };
  }
  
  return { allowed: true };
}

/**
 * 获取安全模式的友好描述
 * @returns {string}
 */
function getSecurityModeDescription() {
  const mode = getSecurityMode();
  const descriptions = {
    readonly: "只读模式 - AI 只能查看文件和系统信息",
    safe: "安全模式 - 系统会阻止高危命令和关键路径操作",
    ai_review: "AI 审查模式（推荐）- AI 自主评估风险并决定是否执行",
    full: "完全权限 - AI 拥有与用户相同的系统权限",
  };
  return descriptions[mode] || descriptions.ai_review;
}

module.exports = {
  getSecurityMode,
  setSecurityMode,
  validateFileAccess,
  validateShellCommand,
  validateExternalAccess,
  getSecurityModeDescription,
  isSystemCriticalPath,
};
