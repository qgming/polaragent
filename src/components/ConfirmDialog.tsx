// 确认对话框组件
// src/components/ConfirmDialog.tsx

import { AlertCircle } from "lucide-react";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

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
        </header>

        <ModalBody className="bg-background">
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </ModalBody>

        <ModalFooter>
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
