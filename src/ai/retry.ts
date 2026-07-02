// 重试工具 —— 供 agent.ts 和 llm-call.ts 共用

/** 固定 5 次重试的延迟序列（毫秒） */
export const RETRY_DELAYS = [300, 800, 1500, 2000, 3000] as const;
export const MAX_RETRIES = RETRY_DELAYS.length; // 5

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
