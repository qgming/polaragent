import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import { Brain, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";

/**
 * 推理折叠块（B2 ②）：默认折叠为一行 mono 眉题，运行中标题走脉冲点；
 * 展开后为低对比小字正文，左侧 2px 竖线引用样式。
 * 时长取 message 级 timing（part 内可经 scope 读取），reasoning part 自身无 timing 字段。
 */
export const Reasoning: ReasoningMessagePartComponent = ({ text, status }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // part 作用域内仍可读 message 级元数据；timing.totalStreamTime 为流式总耗时（毫秒）
  const totalMs = useAuiState((s) => s.message.metadata.timing?.totalStreamTime);
  const isRunning = status?.type === "running";
  const seconds = totalMs !== undefined ? totalMs / 1000 : undefined;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Brain className="size-3.5 shrink-0" />
        <span>{t("chat.thinking")}</span>
        {isRunning ? (
          // tw-shimmer 需在 CSS 中 @import 才生效，index.css 禁改，改用 animate-pulse
          <span className="flex items-center gap-1 text-brand-text">
            <span className="size-1.5 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
            {t("chat.running")}
          </span>
        ) : seconds !== undefined ? (
          <span className="tabular-nums">{seconds.toFixed(1)}s</span>
        ) : null}
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-1.5 border-l-2 border-border pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
};
