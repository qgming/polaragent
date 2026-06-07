// useConfirm hook - 命令式调用确认对话框
// src/hooks/useConfirm.tsx

import { useState, useCallback, useRef } from "react";
import { ConfirmDialog, type ConfirmVariant } from "@/components/ui/confirm-dialog";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

export function useConfirm() {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({
    title: "",
    message: "",
  });
  // 使用 ref 存储 resolver，避免作为依赖导致重新渲染
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    setIsOpen(true);

    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (resolverRef.current) {
      resolverRef.current(true);
      resolverRef.current = null;
    }
    setIsOpen(false);
  }, []);

  const handleCancel = useCallback(() => {
    if (resolverRef.current) {
      resolverRef.current(false);
      resolverRef.current = null;
    }
    setIsOpen(false);
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // 用户按 ESC 或点击背景关闭 = 取消
      handleCancel();
    }
  }, [handleCancel]);

  const ConfirmDialogComponent = useCallback(
    () => (
      <ConfirmDialog
        open={isOpen}
        onOpenChange={handleOpenChange}
        title={options.title}
        message={options.message}
        confirmLabel={options.confirmLabel}
        cancelLabel={options.cancelLabel}
        variant={options.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    ),
    [isOpen, options, handleConfirm, handleCancel, handleOpenChange],
  );

  return { confirm, ConfirmDialog: ConfirmDialogComponent };
}
