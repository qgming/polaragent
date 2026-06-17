import { AlertTriangle, CheckCircle2, CircleHelp, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { McpInstallCheck } from "@/lib/mcp";

export function McpInstallStatusBadge({
  check,
  compact,
}: {
  check?: McpInstallCheck;
  compact?: boolean;
}) {
  const { t } = useTranslation("tools");
  const status = check?.status ?? "unknown";
  const label =
    status === "installed" && typeof check?.toolCount === "number"
      ? t("installStatus.installedWithCount", { count: check.toolCount })
      : t(`installStatus.${status}`);
  const title = [
    check?.message,
    check?.checkedAt ? t("installStatus.checkedAt", { time: new Date(check.checkedAt).toLocaleString() }) : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  const Icon =
    status === "installed"
      ? CheckCircle2
      : status === "failed"
        ? AlertTriangle
        : status === "checking"
          ? Loader2
          : CircleHelp;

  return (
    <span
      title={title || label}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${statusClass(status)}`}
    >
      <Icon className={`size-3 ${status === "checking" ? "animate-spin" : ""}`} />
      {compact ? null : label}
    </span>
  );
}

function statusClass(status: McpInstallCheck["status"]): string {
  if (status === "installed") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
  if (status === "failed") {
    return "bg-red-500/10 text-red-700 dark:text-red-400";
  }
  if (status === "checking") {
    return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
  }
  return "bg-muted text-muted-foreground";
}
