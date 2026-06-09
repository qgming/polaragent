import { AlertTriangle, CheckCircle2, CircleHelp, Loader2 } from "lucide-react";

import type { McpInstallCheck } from "@/lib/mcp";

export function McpInstallStatusBadge({
  check,
  compact,
}: {
  check?: McpInstallCheck;
  compact?: boolean;
}) {
  const status = check?.status ?? "unknown";
  const label = statusLabel(status, check?.toolCount);
  const title = [check?.message, formatCheckedAt(check?.checkedAt)]
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

function statusLabel(status: McpInstallCheck["status"], toolCount?: number): string {
  if (status === "checking") return "检测中";
  if (status === "installed") return `可用${typeof toolCount === "number" ? ` · ${toolCount}` : ""}`;
  if (status === "failed") return "失败";
  return "未检测";
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

function formatCheckedAt(timestamp?: number): string | undefined {
  if (!timestamp) return undefined;
  return `检测时间：${new Date(timestamp).toLocaleString()}`;
}
