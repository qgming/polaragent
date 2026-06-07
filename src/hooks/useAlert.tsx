// useAlert hook - 命令式调用提示对话框
// src/hooks/useAlert.tsx

import { useState, useCallback, useRef } from "react";
import { AlertDialog, type AlertVariant } from "@/components/ui/alert-dialog";

interface AlertOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: AlertVariant;
}

export function useAlert() {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<AlertOptions>({
    title: "",
    message: "",
  });
  // 使用 ref 存储 resolver，避免作为依赖导致重新渲染
  const resolverRef = useRef<(() => void) | null>(null);

  const alert = useCallback((opts: AlertOptions): Promise<void> => {
    setOptions(opts);
    setIsOpen(true);

    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (resolverRef.current) {
      resolverRef.current();
      resolverRef.current = null;
    }
    setIsOpen(false);
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // 用户按 ESC 或点击背景关闭 = 确认（Alert 只有一个按钮，任何关闭都视为确认）
      handleConfirm();
    }
  }, [handleConfirm]);

  const AlertDialogComponent = useCallback(
    () => (
      <AlertDialog
        open={isOpen}
        onOpenChange={handleOpenChange}
        title={options.title}
        message={options.message}
        confirmLabel={options.confirmLabel}
        variant={options.variant}
        onConfirm={handleConfirm}
      />
    ),
    [isOpen, options, handleConfirm, handleOpenChange],
  );

  return { alert, AlertDialog: AlertDialogComponent };
}
