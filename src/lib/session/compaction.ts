// 智能上下文压缩 - 基于 token 数而非消息数
import type { AgentHarness } from "@earendil-works/pi-agent-core";

/**
 * 智能压缩：基于 token 估算动态触发
 * @param harness AgentHarness 实例
 * @param _keepRecentTokens 保留最近的 token 数（预留参数）
 * @returns 是否执行了压缩
 */
export async function autoCompactIfNeeded(
  harness: AgentHarness,
  _keepRecentTokens: number = 32000,
): Promise<boolean> {
  try {
    const session = (harness as any).session;
    if (!session?.getContext) return false;

    const context = await session.getContext();
    const messages = context?.messages || [];
    if (messages.length === 0) return false;

    // 估算当前上下文 token 数
    let estimatedTokens = 0;
    for (const msg of messages) {
      // 简单估算：每个字符约 0.25 tokens（中文约 0.5-1 token/字）
      const textLength = JSON.stringify(msg).length;
      estimatedTokens += Math.ceil(textLength * 0.3);
    }

    // 获取模型的 context window
    const model = harness.getModel();
    const contextWindow = (model as any).contextWindow || 128000;

    // 压缩阈值：使用 80% context window 或 100K，取较小值
    const compactionThreshold = Math.min(contextWindow * 0.8, 100000);

    if (estimatedTokens > compactionThreshold) {
      console.log(
        `[压缩] 触发压缩: ${estimatedTokens} tokens > ${compactionThreshold} (${messages.length} 条消息)`
      );
      await harness.compact();
      return true;
    }

    return false;
  } catch (error) {
    console.warn("[压缩] 失败，继续执行:", error);
    return false;
  }
}
