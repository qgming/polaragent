// 确认对话框组件
// src/components/ConfirmDialog.tsx

import { AlertCircle } from "lucide-react";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        {/* Icon */}
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          <AlertCircle
            className={`size-6 ${
              variant === "destructive" ? "text-red-500" : "text-primary"
            }`}
          />
        </div>

        {/* Content */}
        <h2 className="mb-2 text-lg font-semibold">{title}</h2>
        <p className="mb-6 text-sm text-muted-foreground">{description}</p>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
