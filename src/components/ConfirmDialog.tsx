// 确认对话框组件
// src/components/ConfirmDialog.tsx

import { AlertCircle, X } from "lucide-react";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalTitle,
} from "@/components/ui/modal";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  return (
    <Modal open={isOpen} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <ModalContent size="sm" showCloseButton={false} className="max-w-md rounded-lg bg-background">
        <ModalTitle className="sr-only">{title}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <AlertCircle className={`size-4 shrink-0 ${variant === "destructive" ? "text-destructive" : "text-[#7b5ac8]"}`} />
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>

          <div className="ml-auto flex h-full items-center gap-0.5">
            <button
              type="button"
              onClick={onConfirm}
              title={confirmLabel}
              className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
                variant === "destructive"
                  ? "text-destructive hover:bg-destructive hover:text-white"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              title={cancelLabel}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <ModalBody className="bg-background">
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
