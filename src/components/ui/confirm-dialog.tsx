// 通用 Confirm 对话框组件
// src/components/ui/confirm-dialog.tsx

import { AlertTriangle } from "lucide-react";
import { Modal, ModalBody, ModalContent, ModalTitle } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConfirmVariant = "default" | "destructive";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="sm" className="max-w-[420px]">
        <ModalTitle className="sr-only">{title}</ModalTitle>
        <ModalBody className="px-6 py-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <div
              className={cn(
                "flex size-12 items-center justify-center rounded-full",
                variant === "destructive" ? "bg-red-500/10" : "bg-amber-500/10",
              )}
            >
              <AlertTriangle
                className={cn(
                  "size-6",
                  variant === "destructive" ? "text-red-500" : "text-amber-500",
                )}
              />
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
            </div>

            <div className="flex w-full gap-3">
              <Button onClick={handleCancel} variant="outline" className="flex-1">
                {cancelLabel}
              </Button>
              <Button
                onClick={handleConfirm}
                variant={variant === "destructive" ? "destructive" : "default"}
                className="flex-1"
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
