// Toast 通知组件
// src/components/Toast.tsx

import { useEffect } from "react";
import { CheckCircle, AlertCircle, Info } from "lucide-react";

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
      className={`flex w-[320px] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border ${bgColors[type]} px-4 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-5 cursor-pointer`}
      onClick={onClose}
      role="alert"
      aria-live="polite"
    >
      {icons[type]}
      <span className="flex-1 text-sm font-medium">{message}</span>
    </div>
  );
}
