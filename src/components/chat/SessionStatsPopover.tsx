// 会话用量统计浮层面板
// 从 chatStore 读取当前活跃会话的消息数据进行聚合统计。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useChatStore } from "@/stores/chat-store";
import { useConfigStore } from "@/stores/config-store";
import { DEFAULT_COMPACTION_SETTINGS } from "@/lib/session/compaction";
import type { ChatMessage } from "@/lib/chat";
import { cn } from "@/lib/utils";

// 格式化数字：1234 → "1,234"
function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

// 无活跃会话时的稳定空数组，避免每次渲染产生新引用击穿 useMemo
const EMPTY_MESSAGES: ChatMessage[] = [];

export function SessionStatsPopover() {
  const { t } = useTranslation("chat");
  // 只订阅当前活跃会话对象：其它后台会话的流式更新不会触发本组件重渲染
  const activeThread = useChatStore((state) =>
    state.threads.find((thread) => thread.id === state.activeThreadId),
  );
  const providers = useConfigStore((state) => state.providers);

  const messages = activeThread?.messages ?? EMPTY_MESSAGES;

  // 所有供应商的模型配置拉平，便于按模型 id 查找上下文窗口
  const allModels = useMemo(
    () => providers?.providers?.flatMap((provider) => provider.models) ?? [],
    [providers],
  );

  const stats = useMemo(() => {
    const assistantMessages = messages.filter(
      (msg) => msg.role === "assistant" && msg.status === "complete",
    );

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalTokens = 0;
    let toolCallCount = 0;

    // 按模型分组
    const byModel = new Map<string, { tokens: number; count: number }>();

    for (const msg of assistantMessages) {
      const input = msg.inputTokens ?? 0;
      const output = msg.outputTokens ?? 0;
      const cacheRead = msg.cacheReadTokens ?? 0;
      const total = msg.tokenCount ?? (input + output);

      totalInput += input;
      totalOutput += output;
      totalCacheRead += cacheRead;
      totalTokens += total;

      // 统计工具调用（segments 中 kind 为 "tool" 的段）
      if (msg.segments) {
        toolCallCount += msg.segments.filter(
          (seg) => seg.kind === "tool",
        ).length;
      }

      const model = msg.model || "unknown";
      const existing = byModel.get(model) ?? { tokens: 0, count: 0 };
      existing.tokens += total;
      existing.count += 1;
      byModel.set(model, existing);
    }

    // 对话轮次 = 用户消息数
    const turnCount = messages.filter((msg) => msg.role === "user").length;

    // 会话时长
    const firstMessageTime = messages.length > 0 ? messages[0].createdAt : 0;
    const lastMessageTime =
      messages.length > 0 ? messages[messages.length - 1].createdAt : 0;
    const durationMs = lastMessageTime - firstMessageTime;

    // 当前上下文 token：取最后一条 assistant 消息的 contextTokens
    // （官方口径：最后一轮 usage 的 totalTokens || 四字段和）
    const lastAssistant = assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1]
      : null;
    const currentContextTokens = lastAssistant?.contextTokens ?? lastAssistant?.inputTokens ?? totalInput;

    // 上下文窗口大小
    const modelConfig = allModels.find(
      (m) => m.id === (lastAssistant?.model ?? ""),
    );
    const contextWindow = modelConfig?.contextWindow ?? 128000;

    // 压缩阈值：与自动压缩判断（shouldCompact）同源的 reserveTokens
    const compactionThreshold = contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;

    return {
      totalTokens,
      totalInput,
      totalOutput,
      totalCacheRead,
      turnCount,
      toolCallCount,
      // 按 token 用量降序，在 memo 内排序，避免每次渲染原地突变缓存数组
      byModel: Array.from(byModel.entries()).sort((a, b) => b[1].tokens - a[1].tokens),
      durationMs,
      compactionThreshold,
      currentContextTokens,
      avgTokensPerReply:
        assistantMessages.length > 0
          ? Math.round(totalTokens / assistantMessages.length)
          : 0,
    };
  }, [messages, allModels]);

  // 无活跃会话时显示空状态
  if (!activeThread || messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
        {t("stats.empty")}
      </div>
    );
  }

  const totalAll = stats.totalTokens;

  // 格式化时长
  const durationMinutes = Math.round(stats.durationMs / 60000);
  const durationText =
    durationMinutes < 1
      ? t("stats.lessThanMinute")
      : `${durationMinutes} ${t("stats.minutes")}`;

  // 缓存率（token 级别）：缓存读取的 token 占实际总输入 token 的比例
  // 实际总输入 = input + cacheRead（新输入 + 缓存读取）
  const cacheReadRate = (stats.totalInput + stats.totalCacheRead) > 0
    ? (stats.totalCacheRead / (stats.totalInput + stats.totalCacheRead)) * 100
    : 0;

  return (
    <div className="divide-y divide-border">
      {/* 标题 */}
      <div className="px-4 py-3">
        <h3 className="text-sm font-semibold">{t("stats.title")}</h3>
      </div>

      {/* Token 总量 */}
      <div className="space-y-2.5 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t("stats.totalTokens")}</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatNumber(totalAll)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t("stats.totalInput")}</span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatNumber(stats.totalInput)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t("stats.totalOutput")}</span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatNumber(stats.totalOutput)}
          </span>
        </div>
      </div>

      {/* 缓存命中率 */}
      <div className="space-y-2 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t("stats.cacheHitRate")}</span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {cacheReadRate.toFixed(1)}%
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              cacheReadRate > 50
                ? "bg-emerald-500"
                : cacheReadRate > 20
                  ? "bg-amber-500"
                  : "bg-muted-foreground/40",
            )}
            style={{
              width: `${Math.min(100, cacheReadRate)}%`,
            }}
          />
        </div>
      </div>

      {/* 上下文压缩 */}
      <div className="space-y-2 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t("stats.compaction")}</span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatNumber(stats.currentContextTokens)} / {formatNumber(stats.compactionThreshold)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              stats.currentContextTokens / stats.compactionThreshold > 0.8
                ? "bg-destructive"
                : stats.currentContextTokens / stats.compactionThreshold > 0.5
                  ? "bg-amber-500"
                  : "bg-emerald-500",
            )}
            style={{
              width: `${Math.min(100, (stats.currentContextTokens / stats.compactionThreshold) * 100)}%`,
            }}
          />
        </div>
      </div>

      {/* 对话概览 */}
      <div className="grid grid-cols-2 gap-3 px-4 py-3">
        <StatItem label={t("stats.turns")} value={String(stats.turnCount)} />
        <StatItem label={t("stats.toolCalls")} value={String(stats.toolCallCount)} />
        <StatItem
          label={t("stats.avgPerReply")}
          value={formatNumber(stats.avgTokensPerReply)}
        />
        <StatItem label={t("stats.duration")} value={durationText} />
      </div>

      {/* 按模型分组 */}
      {stats.byModel.length > 1 ? (
        <div className="space-y-1.5 px-4 py-3">
          <span className="text-xs text-muted-foreground">{t("stats.byModel")}</span>
          {stats.byModel.map(([model, data]) => (
            <div
              key={model}
              className="flex items-center justify-between text-xs"
            >
              <span className="truncate text-muted-foreground">{model}</span>
              <span className="ml-2 shrink-0 tabular-nums">
                {formatNumber(data.tokens)} tokens
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
