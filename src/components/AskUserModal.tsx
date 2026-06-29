import { Check, ListChecks, MessageCircleQuestion, PencilLine } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  cancelAskUserRequest,
  submitAskUserResponse,
} from "@/ai/ask-user";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/markdown/MarkdownContent";
import { cn } from "@/lib/utils";
import { useAskUserStore } from "@/stores/ask-user-store";

export function AskUserModal() {
  const { t } = useTranslation("common");
  const request = useAskUserStore((state) => state.activeRequest);
  const queuedCount = useAskUserStore((state) => state.queuedRequests.length);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customSelected, setCustomSelected] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [customValue, setCustomValue] = useState("");

  useEffect(() => {
    setSelectedIds([]);
    setCustomSelected(false);
    setTextValue("");
    setCustomValue("");
  }, [request?.requestId]);

  if (!request) return null;

  const isInputMode = request.mode === "input";
  const isMultipleMode = request.mode === "multiple";
  const selectedOptions = request.options.filter((option) =>
    selectedIds.includes(option.id),
  );
  const trimmedText = textValue.trim();
  const trimmedCustom = customValue.trim();
  const hasCustomAnswer = customSelected && trimmedCustom.length > 0;
  const canSubmit =
    isInputMode
      ? trimmedText.length > 0
      : selectedIds.length > 0 || hasCustomAnswer;

  const modeLabel =
    request.mode === "multiple"
      ? t("askUser.multipleMode")
      : request.mode === "single"
        ? t("askUser.singleMode")
        : t("askUser.inputMode");
  const customLabel =
    request.customOptionLabel || t("askUser.customOptionLabel");

  const toggleOption = (id: string) => {
    setSelectedIds((current) => {
      if (!isMultipleMode) {
        setCustomSelected(false);
        return [id];
      }
      return current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
    });
  };

  const selectCustom = () => {
    setCustomSelected(true);
    if (!isMultipleMode) {
      setSelectedIds([]);
    }
  };

  const submit = () => {
    if (!canSubmit) return;
    submitAskUserResponse(request.requestId, {
      selectedOptionIds: selectedOptions.map((option) => option.id),
      selectedOptions: selectedOptions.map((option) => option.label),
      text: isInputMode ? trimmedText : "",
      customText: hasCustomAnswer ? trimmedCustom : "",
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
      <ModalContent size="lg" showCloseButton={true} className="max-h-[calc(100vh-4rem)] rounded-xl border-border bg-background shadow-2xl">
        <ModalTitle className="sr-only">{t("askUser.title")}</ModalTitle>
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-background pl-4 pr-12">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <MessageCircleQuestion className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold">{t("askUser.title")}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {modeLabel}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {request.requesterName}
              {queuedCount > 0 ? ` · ${t("askUser.queuedCount", { count: queuedCount })}` : ""}
            </div>
          </div>
        </header>

        <ModalBody className="space-y-5 px-5 py-5">
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
            <MarkdownContent
              content={request.prompt}
              variant="compact"
              className="prose-p:my-1 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2 text-sm"
            />
          </div>

          {isInputMode ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <PencilLine className="size-3.5" />
                {t("askUser.inputLabel")}
              </label>
              <textarea
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={t("askUser.replyPlaceholder")}
                className="app-scrollbar min-h-[150px] w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-6 outline-none transition-colors focus:border-accent-foreground/50 focus:ring-2 focus:ring-accent/40"
                autoFocus
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ListChecks className="size-3.5" />
                {isMultipleMode ? t("askUser.multipleHint") : t("askUser.singleHint")}
              </div>
              <div className="grid gap-2">
                {request.options.map((option) => {
                  const active = selectedIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggleOption(option.id)}
                      className={cn(
                        "group flex min-h-11 w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors",
                        active
                          ? "border-accent-foreground/45 bg-accent text-accent-foreground"
                          : "border-border bg-background text-foreground hover:border-accent-foreground/25 hover:bg-muted/60",
                      )}
                      aria-pressed={active}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center border text-[10px] transition-colors",
                          isMultipleMode
                            ? "rounded-[4px]"
                            : "rounded-full",
                          active
                            ? "border-accent-foreground bg-accent-foreground text-background"
                            : "border-border bg-background group-hover:border-accent-foreground/35",
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

                <div
                  className={cn(
                    "rounded-xl border px-3 py-2.5 transition-colors",
                    customSelected
                      ? "border-accent-foreground/45 bg-accent text-accent-foreground"
                      : "border-border bg-background hover:border-accent-foreground/25 hover:bg-muted/60",
                  )}
                  onClick={selectCustom}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center border text-[10px] transition-colors",
                        isMultipleMode
                          ? "rounded-[4px]"
                          : "rounded-full",
                        customSelected
                          ? "border-accent-foreground bg-accent-foreground text-background"
                          : "border-border bg-background",
                      )}
                    >
                      {customSelected ? <Check className="size-3" /> : null}
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="text-sm font-medium leading-5">
                        {customLabel}
                      </div>
                      <textarea
                        value={customValue}
                        onFocus={selectCustom}
                        onChange={(event) => {
                          setCustomValue(event.target.value);
                          if (event.target.value.trim()) {
                            selectCustom();
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                            event.preventDefault();
                            submit();
                          }
                        }}
                        placeholder={t("askUser.customOptionPlaceholder")}
                        className={cn(
                          "app-scrollbar min-h-[76px] w-full resize-none rounded-lg border px-3 py-2 text-sm leading-6 outline-none transition-colors",
                          customSelected
                            ? "border-accent-foreground/35 bg-background/80 text-foreground placeholder:text-muted-foreground"
                            : "border-border bg-muted/30 text-foreground placeholder:text-muted-foreground focus:border-accent-foreground/50 focus:ring-2 focus:ring-accent/40",
                        )}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          <Button variant="outline" onClick={cancel}>
            {t("cancel")}
          </Button>
          <Button variant="default" onClick={submit} disabled={!canSubmit}>
            {t("askUser.submit")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
