// 通用模态窗组件：基于 Radix Dialog 封装，提供「固定头部 / 可滚动主体 / 固定底部」三段式布局
// 后续所有居中弹窗（含简单确认框、复杂编辑器）都复用此组件
// src/components/ui/modal.tsx

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type * as React from "react";

import { cn } from "@/lib/utils";

// 不同宽度档位，按内容复杂度选用
const sizeClass = {
  sm: "sm:max-w-[420px]",
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[640px]",
  xl: "sm:max-w-[760px]",
  "2xl": "sm:max-w-[880px]",
} as const;

type ModalSize = keyof typeof sizeClass;

// 根：受控 open / onOpenChange
function Modal(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="modal" {...props} />;
}

function ModalTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>,
) {
  return <DialogPrimitive.Trigger data-slot="modal-trigger" {...props} />;
}

function ModalClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="modal-close" {...props} />;
}

function ModalOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="modal-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/45 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

// 居中卡片容器：flex 纵向三段式，最大高度 85vh，超出由 ModalBody 内部滚动
function ModalContent({
  className,
  children,
  size = "md",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: ModalSize;
  showCloseButton?: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <DialogPrimitive.Portal data-slot="modal-portal">
      <ModalOverlay />
      <DialogPrimitive.Content
        data-slot="modal-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          sizeClass[size],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="absolute top-4 right-4 rounded-sm opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none">
            <X className="size-5" />
	            <span className="sr-only">{t("close")}</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// 固定头部：不随主体滚动
function ModalHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-header"
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-b border-border px-6 py-4 pr-12",
        className,
      )}
      {...props}
    />
  );
}

// 可滚动主体：撑满剩余空间并内部滚动
function ModalBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-body"
      className={cn("app-scrollbar min-h-0 flex-1 overflow-y-auto p-6", className)}
      {...props}
    />
  );
}

// 固定底部：按钮区，默认右对齐
function ModalFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-footer"
      className={cn(
        "flex shrink-0 items-center justify-end gap-3 border-t border-border px-6 py-4",
        className,
      )}
      {...props}
    />
  );
}

function ModalTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="modal-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function ModalDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="modal-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  ModalTitle,
  ModalTrigger,
  type ModalSize,
};
