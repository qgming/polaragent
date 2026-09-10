import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { Copy, Ellipsis, FileDown, GitBranch, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/renderer/components/ui/dropdown-menu";
import { useChatStore } from "@/renderer/stores/chat-store";

const buttonClass =
  "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/**
 * 消息底部操作栏（B2 ①⑤）：复制 / 重试（仅最后一条助手消息）/ 分支 / 更多。
 * 常态低存在感（opacity-0），消息 hover 或键盘聚焦时出现。
 * 分支：按并行车道冻结签名调用 useChatStore.getState().forkSession(activeSessionId, entryId)，
 * entryId 由 converter 车道写入 message.metadata.custom.entryId（通道已核实可用）。
 */
export function MessageActionBar() {
  const { t } = useTranslation();

  // 并行车道的真实签名：forkSession(id: string, entryId: string)；activeSessionId 可为 null
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const entryId = useAuiState((s) => s.message.metadata.custom.entryId);

  const canBranch = activeSessionId !== null && typeof entryId === "string" && entryId !== "";

  const handleBranch = () => {
    if (activeSessionId === null || typeof entryId !== "string" || entryId === "") return;
    void useChatStore.getState().forkSession(activeSessionId, entryId);
  };

  // 重试仅对最后一条助手消息可见（库自身的 disabled 兜底非助手消息）
  const showReload = useAuiState((s) => s.message.role === "assistant" && s.message.isLast);

  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      hideWhenRunning
      className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
    >
      <ActionBarPrimitive.Copy copiedDuration={2000} className={buttonClass}>
        <Copy className="size-3.5" />
        <span className="sr-only">{t("common.copy")}</span>
      </ActionBarPrimitive.Copy>
      {showReload && (
        <ActionBarPrimitive.Reload className={buttonClass}>
          <RefreshCw className="size-3.5" />
          <span className="sr-only">{t("common.retry")}</span>
        </ActionBarPrimitive.Reload>
      )}
      <button
        type="button"
        onClick={handleBranch}
        disabled={!canBranch}
        title={t("chat.branch")}
        className={buttonClass}
      >
        <GitBranch className="size-3.5" />
        <span className="sr-only">{t("chat.branch")}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={`${buttonClass} outline-none`}
          aria-label={t("common.more")}
        >
          <Ellipsis className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-36">
          {/* 导出 Markdown 占位：后续 checkpoint 接入文件导出 */}
          <DropdownMenuItem onClick={() => {}}>
            <FileDown className="size-4" />
            {t("chat.exportMarkdown")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ActionBarPrimitive.Root>
  );
}
