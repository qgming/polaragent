// 通用 Alert 对话框组件
// src/components/ui/alert-dialog.tsx

import { AlertTriangle, Info, CheckCircle2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal, ModalBody, ModalContent, ModalTitle } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AlertVariant = "info" | "warning" | "success" | "error";

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: AlertVariant;
  onConfirm?: () => void;
}

const variantConfig = {
  info: {
    icon: Info,
    iconClass: "text-blue-500",
    bgClass: "bg-blue-500/10",
  },
  warning: {
    icon: AlertTriangle,
    iconClass: "text-amber-500",
    bgClass: "bg-amber-500/10",
  },
  success: {
    icon: CheckCircle2,
    iconClass: "text-green-500",
    bgClass: "bg-green-500/10",
  },
  error: {
    icon: XCircle,
    iconClass: "text-red-500",
    bgClass: "bg-red-500/10",
  },
};

export function AlertDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  variant = "info",
  onConfirm,
}: AlertDialogProps) {
  const { t } = useTranslation("common");
  const config = variantConfig[variant];
  const Icon = config.icon;

  const handleConfirm = () => {
    onConfirm?.();
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="sm" className="max-w-[420px]">
        <ModalTitle className="sr-only">{title}</ModalTitle>
        <ModalBody className="px-6 py-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className={cn("flex size-12 items-center justify-center rounded-full", config.bgClass)}>
              <Icon className={cn("size-6", config.iconClass)} />
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
            </div>

            <Button onClick={handleConfirm} className="w-full">
	              {confirmLabel ?? t("alert.ok")}
            </Button>
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
