import { CircleAlert, Wifi } from "lucide-react";
import { createContext, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatRetryState } from "@/shared/contracts/chat";

/** Only the request represented by the tail feedback suppresses its per-message error rows. */
export const RequestRetryContext = createContext<string | null>(null);

export function RequestErrorDetails({
  label,
  error,
  reconnecting = false,
}: {
  label: string;
  error: string;
  reconnecting?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    <div data-slot="request-error-details" className="min-w-0 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
        className="flex max-w-full items-center gap-2 rounded-md py-1 text-start text-ink-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
      >
        <Wifi aria-hidden="true" className="size-4 shrink-0" />
        <span
          role={reconnecting ? "status" : undefined}
          aria-live={reconnecting ? "polite" : undefined}
        >
          {label}
        </span>
      </button>
      {expanded && (
        <pre
          id={detailsId}
          dir="auto"
          className="app-scrollbar mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-foreground/[0.03] p-3 font-mono text-xs leading-relaxed text-ink-2 [overflow-wrap:anywhere]"
        >
          {error}
        </pre>
      )}
    </div>
  );
}

export function RequestRetryStatus({
  retry,
}: {
  retry: ChatRetryState | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (retry?.phase !== "retrying") return null;
  return (
    <RequestErrorDetails
      key={retry.generationId}
      label={t("chat.requestReconnecting", { count: retry.attempt, limit: retry.maxAttempts })}
      error={retry.error || t("errors.generic")}
      reconnecting
    />
  );
}

export function RequestFailureCard({
  retry,
}: {
  retry: ChatRetryState | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (retry?.phase !== "failed") return null;
  return (
    <div
      role="alert"
      data-slot="request-failure-card"
      className="min-w-0 rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <div className="flex items-center gap-2 font-medium">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
        <span>
          {retry.attempt >= retry.maxAttempts
            ? t("chat.requestRetriesExhausted", { count: retry.attempt })
            : retry.attempt > 0
              ? t("chat.requestFailedAfterRetries", { count: retry.attempt })
              : t("chat.requestFailed")}
        </span>
      </div>
      <pre
        dir="auto"
        className="app-scrollbar mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]"
      >
        {retry.error || t("errors.generic")}
      </pre>
    </div>
  );
}
