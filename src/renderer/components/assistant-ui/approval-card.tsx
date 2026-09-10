import { CheckCircle2, ChevronDown, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";

/**
 * 审批卡展示类型：在 shared 契约基础上补充已决信息。
 * 并行车道的 store 上线后若以其他字段表达结论，改此处的读取即可；
 * 因扩展字段全部可选，shared 的 ApprovalRequest 可直接赋值。
 */
export interface ApprovalCardRequest extends ApprovalRequest {
  decision?: ApprovalDecision;
  decidedBy?: "user" | "ai";
}

interface ApprovalCardProps {
  request: ApprovalCardRequest;
  onDecide: (decision: ApprovalDecision, note?: string) => void;
}

/**
 * 审批卡（B5）：document 圆角 + 1px 边框，无 store 依赖（props 驱动，便于单测）。
 * 三种形态：用户审批默认态（三按钮）、AI 审批中（脉冲 + 来源标注）、AI 已决态（结论与理由）。
 */
export function ApprovalCard({ request, onDecide }: ApprovalCardProps) {
  const { t } = useTranslation();
  const [argsOpen, setArgsOpen] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState("");

  const decided = request.decision !== undefined;
  const aiReviewing = !decided && request.source === "ai";
  const approved = request.decision === "allow_once" || request.decision === "always_allow";
  const highRisk = request.risk === "high";

  const resetNote = () => {
    setNote("");
    setDenyOpen(false);
  };

  // 参数区：等宽、可折叠、超 3 行截断
  const argsBlock = (
    <button
      type="button"
      onClick={() => setArgsOpen((v) => !v)}
      className="-mx-1 mt-1 flex w-full items-start gap-1 rounded-md px-1 py-0.5 text-left"
    >
      <pre className="min-w-0 flex-1 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        <span className={argsOpen ? "" : "line-clamp-3"}>{request.argsText}</span>
      </pre>
      <ChevronDown
        className={cn(
          "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
          argsOpen && "rotate-180",
        )}
      />
    </button>
  );

  if (aiReviewing) {
    // B5 ③ AI 审批中
    return (
      <div className="rounded-sm border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-brand-text" />
          <span className="text-sm font-medium">{t("approval.aiReviewing")}</span>
          <span className="ml-auto shrink-0 rounded-sm bg-brand-muted px-1.5 py-0.5 font-mono text-[11px] text-brand-text">
            {t("approval.sourceAi")}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          {/* tw-shimmer 需在 CSS 中 @import 才生效，index.css 禁改，改用 animate-pulse */}
          <span className="size-1.5 shrink-0 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
          <span className="truncate">
            {request.toolName} {request.argsText}
          </span>
        </div>
      </div>
    );
  }

  if (decided) {
    // B5 ④⑤ AI 结论：结论 + 理由（引用式左竖线）
    return (
      <div className="rounded-sm border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          {approved ? (
            <CheckCircle2 className="size-4 shrink-0 text-brand-text" />
          ) : (
            <XCircle className="size-4 shrink-0 text-destructive" />
          )}
          <span className="text-sm font-medium">
            {t(approved ? "approval.approved" : "approval.denied")}
          </span>
          {request.decidedBy === "ai" && (
            <span className="ml-auto shrink-0 rounded-sm bg-brand-muted px-1.5 py-0.5 font-mono text-[11px] text-brand-text">
              {t("approval.sourceAi")}
            </span>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {request.toolName} {request.argsText}
        </div>
        {request.reason && (
          <div className="mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            <span className="font-mono text-[11px]">{t("approval.viewReason")}</span>：
            {request.reason}
          </div>
        )}
      </div>
    );
  }

  // B5 ① 用户审批 · 默认态
  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <ShieldAlert className="size-4 shrink-0 text-brand-text" />
        <span className="shrink-0 text-sm font-medium">{t("approval.title")}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{request.toolName}</span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[11px]",
            highRisk ? "bg-muted text-destructive" : "bg-muted text-muted-foreground",
          )}
        >
          {t(highRisk ? "approval.riskHigh" : "approval.riskLow")}
        </span>
      </div>
      <div className="px-3 pb-1 pt-0.5">{argsBlock}</div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={() => onDecide("allow_once")}
          className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground transition-opacity hover:opacity-90"
        >
          {t("approval.allowOnce")}
        </button>
        <button
          type="button"
          onClick={() => onDecide("always_allow")}
          className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
        >
          {t("approval.alwaysAllow")}
        </button>
        <button
          type="button"
          onClick={() => setDenyOpen((v) => !v)}
          className="rounded-md px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-accent"
        >
          {t("approval.denyWithReason")}
        </button>
      </div>
      {denyOpen && (
        <div className="border-t border-border px-3 py-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("approval.reasonPlaceholder")}
            className="min-h-14 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-brand-border"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={resetNote}
              className="rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-accent"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                onDecide("deny", note.trim() || undefined);
                resetNote();
              }}
              className="rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90"
            >
              {t("approval.denyWithReason")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
