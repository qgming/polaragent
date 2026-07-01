/** 全局常量定义 */

// 超时配置（毫秒）
export const TIMEOUTS = {
  /** 工具默认超时（Bash、浏览器操作等） */
  TOOL_DEFAULT: 30_000,
  /** 图片生成请求超时 */
  IMAGE_GENERATION: 1_800_000,
} as const;

// 缓存 TTL（毫秒）
export const CACHE_TTL = {
  /** 知识库查询缓存 */
  KNOWLEDGE: 5 * 60 * 1000,
  /** 技能市场缓存 */
  SKILLS_MARKET: 24 * 60 * 60 * 1000,
} as const;
