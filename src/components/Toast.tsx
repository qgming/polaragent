// Toast 通知组件
// src/components/Toast.tsx

import { useEffect } from "react";
import { X, CheckCircle, AlertCircle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ToastType = "success" | "error" | "info";

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

export function Toast({
  message,
  type = "info",
  duration = 3000,
  onClose,
}: ToastProps) {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  const icons = {
    success: <CheckCircle className="size-5 text-green-500" />,
    error: <AlertCircle className="size-5 text-red-500" />,
    info: <Info className="size-5 text-blue-500" />,
  };

  const bgColors = {
    success: "bg-green-500/10 border-green-500/20",
    error: "bg-red-500/10 border-red-500/20",
    info: "bg-blue-500/10 border-blue-500/20",
  };

  return (
    <div
      className={`flex w-[320px] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border ${bgColors[type]} px-4 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-5`}
    >
      {icons[type]}
      <span className="text-sm font-medium">{message}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="ml-2 h-6 w-6 p-0"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
