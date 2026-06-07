import { Check, MessageCircleQuestion, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  cancelAskUserRequest,
  submitAskUserResponse,
} from "@/ai/ask-user";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalTitle,
} from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { useAskUserStore } from "@/stores/ask-user-store";

export function AskUserModal() {
  const request = useAskUserStore((state) => state.activeRequest);
  const queuedCount = useAskUserStore((state) => state.queuedRequests.length);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [textValue, setTextValue] = useState("");
  const [customValue, setCustomValue] = useState("");

  useEffect(() => {
    setSelectedIds([]);
    setTextValue("");
    setCustomValue("");
  }, [request?.requestId]);

  if (!request) return null;

  const selectedOptions = request.options.filter((option) =>
    selectedIds.includes(option.id),
  );
  const trimmedText = textValue.trim();
  const trimmedCustom = customValue.trim();
  const canSubmit =
    request.mode === "text"
      ? trimmedText.length > 0
      : selectedIds.length > 0 || trimmedCustom.length > 0;

  const toggleOption = (id: string) => {
    setSelectedIds((current) => {
      if (request.mode === "single") {
        return current.includes(id) ? [] : [id];
      }
      return current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
    });
  };

  const submit = () => {
    if (!canSubmit) return;
    submitAskUserResponse(request.requestId, {
      selectedOptionIds: selectedOptions.map((option) => option.id),
      selectedOptions: selectedOptions.map((option) => option.label),
      text: request.mode === "text" ? trimmedText : "",
      customText: trimmedCustom,
    });
  };

  const cancel = () => {
    cancelAskUserRequest(request.requestId);
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <ModalContent size="md" showCloseButton={false} className="max-h-[calc(100vh-4rem)] rounded-lg bg-background">
        <ModalTitle className="sr-only">需要你的输入</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <MessageCircleQuestion className="size-4 shrink-0 text-[#7b5ac8]" />
          <span className="min-w-0 truncate text-sm font-medium">需要你的输入</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            · {request.requesterName}
            {queuedCount > 0 ? ` · 还有 ${queuedCount} 个请求` : ""}
          </span>

          <div className="ml-auto flex h-full items-center gap-0.5">
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              title="提交回复"
              className="flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              提交回复
            </button>
            <button
              type="button"
              onClick={cancel}
              title="取消"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <ModalBody className="space-y-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-6 text-foreground">
            {request.prompt}
          </div>

          {request.mode === "text" ? (
            <textarea
              value={textValue}
              onChange={(event) => setTextValue(event.target.value)}
              placeholder="输入回复"
              className="app-scrollbar min-h-[120px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-6 outline-none transition-colors focus:border-[#9b6fe0]"
              autoFocus
            />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                {request.options.map((option) => {
                  const active = selectedIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggleOption(option.id)}
                      className={cn(
                        "flex min-h-9 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        active
                          ? "border-[#9b6fe0] bg-[#9b6fe0]/10 text-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center border text-[10px]",
                          request.mode === "single"
                            ? "rounded-full"
                            : "rounded-[4px]",
                          active
                            ? "border-[#9b6fe0] bg-[#9b6fe0] text-white"
                            : "border-border",
                        )}
                      >
                        {active ? <Check className="size-3" /> : null}
                      </span>
                      <span className="min-w-0 break-words leading-5">
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {request.allowCustomInput ? (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    {request.customInputLabel || "其他 / 补充输入"}
                  </label>
                  <textarea
                    value={customValue}
                    onChange={(event) => setCustomValue(event.target.value)}
                    placeholder="可以输入选项之外的信息"
                    className="app-scrollbar min-h-[88px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-6 outline-none transition-colors focus:border-[#9b6fe0]"
                  />
                </div>
              ) : null}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
