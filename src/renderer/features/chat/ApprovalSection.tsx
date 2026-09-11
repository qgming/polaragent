import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ApprovalCard,
  type ApprovalState,
} from "@/renderer/components/assistant-ui/elements/approval-card";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { Textarea } from "@/renderer/components/ui/textarea";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";

interface ApprovalSectionProps {
  requests: ApprovalRequest[];
  onResolve?: (id: string, decision: ApprovalDecision, note?: string) => void;
}

/**
 * 审批区：每条待审批请求渲染一张 Elements 的审批卡，挂在消息流尾部。
 * 卡片的状态来自请求本身 —— AI 预审进行中走 running，其余走 request；
 * store 在用户/AI 定夺后即把请求移出列表，所以不留已决态。
 */
export function ApprovalSection({ requests, onResolve }: ApprovalSectionProps) {
  const { t } = useTranslation();
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (requests.length === 0) return null;

  const closeDeny = () => {
    setNote("");
    setDenyFor(null);
  };

  return (
    <div className="flex flex-col gap-2 px-2 pt-2">
      {/*
        审批卡会随定夺从 store 列表里消失。CSS 无法延迟卸载，卡片会硬闪一下，
        所以这里用 motion 的退出动画：这是本应用唯一必须靠 JS 才能做对的动效。
        reducedMotion="user" 下位移与缩放被抑制，只保留透明度变化（见 App.tsx 的 MotionConfig）。
      */}
      <AnimatePresence initial={false}>
        {requests.map((request) => {
          const state: ApprovalState = request.source === "ai" ? "running" : "request";
          const risk = t(request.risk === "high" ? "approval.riskHigh" : "approval.riskLow");
          const source = request.source === "ai" ? ` · ${t("approval.sourceAi")}` : "";

          return (
            <motion.div
              key={request.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            >
              <ApprovalCard
                state={state}
                title={t("approval.title")}
                subtitle={`${request.toolName} · ${risk}${source}`}
                command={request.argsText}
                onAllowOnce={() => onResolve?.(request.id, "allow_once")}
                onAlwaysAllow={() => onResolve?.(request.id, "always_allow")}
                onDeny={() => setDenyFor(request.id)}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* 拒绝理由是可选的；写进会话记录，也进 AI 审批的学习上下文 */}
      <Dialog
        open={denyFor !== null}
        onOpenChange={(open) => {
          if (!open) closeDeny();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("approval.denyWithReason")}</DialogTitle>
            <DialogDescription>{t("approval.reasonPlaceholder")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("approval.reasonPlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDeny}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (denyFor !== null) onResolve?.(denyFor, "deny", note.trim() || undefined);
                closeDeny();
              }}
            >
              {t("approval.denyWithReason")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
