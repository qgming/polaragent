// 关于软件面板
// src/components/settings/AboutPanel.tsx

import { AlertCircle, CheckCircle2, Download, ExternalLink, PackageCheck, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/useToast";
import {
  checkForUpdates,
  getUpdateStatus,
  installUpdate,
  isElectronRuntime,
  onUpdateStatus,
  openUpdateReleases,
  type AppUpdatePhase,
  type AppUpdateStatus,
} from "@/lib/electron/electron-api";
import { cn } from "@/lib/utils";
import { PageTitle } from "./settings-shared";
import logo from "@/assets/logo.png";

function platformLabel(status: AppUpdateStatus | null) {
  if (!status) return "GitHub Releases";
  const platformMap: Record<string, string> = {
    darwin: "macOS",
    win32: "Windows",
    linux: "Linux",
  };
  return `${platformMap[status.platform] ?? status.platform} ${status.arch}`;
}

function statusTone(phase: AppUpdatePhase | undefined) {
  if (phase === "downloaded" || phase === "not-available") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (phase === "available" || phase === "checking") {
    return "border-primary/20 bg-primary/10 text-primary";
  }
  if (phase === "error" || phase === "unsupported") {
    return "border-destructive/20 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted text-muted-foreground";
}

function UpdateStatusIcon({ phase }: { phase: AppUpdatePhase | undefined }) {
  if (phase === "checking") return <RefreshCw className="size-4 animate-spin" />;
  if (phase === "downloaded" || phase === "not-available") return <CheckCircle2 className="size-4" />;
  if (phase === "available") return <Download className="size-4" />;
  if (phase === "error" || phase === "unsupported") return <AlertCircle className="size-4" />;
  return <PackageCheck className="size-4" />;
}

export function AboutPanel() {
  const toastError = useToast((state) => state.error);
  const toastInfo = useToast((state) => state.info);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  const electronRuntime = isElectronRuntime();
  const version = updateStatus?.currentVersion ?? "0.1.0";
  const phase = updateStatus?.phase;
  const isChecking = checking || phase === "checking";
  const updateMessage = electronRuntime
    ? updateStatus?.message ?? "正在读取版本信息"
    : "当前环境未连接 Electron 主进程";
  const updateDetail = updateStatus
    ? `${updateStatus.repository} · ${platformLabel(updateStatus)}`
    : `qgming/polaragent · ${platformLabel(null)}`;

  useEffect(() => {
    if (!isElectronRuntime()) return undefined;

    let disposed = false;
    void getUpdateStatus()
      .then((status) => {
        if (!disposed) setUpdateStatus(status);
      })
      .catch((error) => {
        if (!disposed) toastError(error instanceof Error ? error.message : String(error));
      });

    const unsubscribe = onUpdateStatus((status) => {
      setUpdateStatus(status);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [toastError]);

  async function handleCheckUpdates() {
    if (!electronRuntime) {
      toastInfo("当前环境无法检查更新");
      return;
    }

    setChecking(true);
    try {
      const nextStatus = await checkForUpdates();
      setUpdateStatus(nextStatus);
      if (nextStatus.phase === "disabled" || nextStatus.phase === "unsupported") {
        toastInfo(nextStatus.message);
      }
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  async function handleInstallUpdate() {
    setInstalling(true);
    try {
      await installUpdate();
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
      setInstalling(false);
    }
  }

  async function handleOpenReleases() {
    try {
      if (!electronRuntime) {
        window.open("https://github.com/qgming/polaragent/releases", "_blank", "noopener,noreferrer");
        return;
      }
      await openUpdateReleases();
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section>
      <PageTitle title="关于软件" description="PolarAgent 的版本与应用信息。" />

      {/* 主卡片 - Logo 和基本信息 */}
      <div className="mt-8 rounded-xl border border-border bg-gradient-to-br from-card to-muted/20">
        <div className="px-8 py-8">
          {/* Logo 和名称布局 */}
          <div className="flex items-center gap-6">
            {/* 左侧 Logo - 纯 logo，无边框无背景 */}
            <div className="size-20 shrink-0">
              <img src={logo} alt="PolarAgent Logo" className="size-full object-contain" />
            </div>

            {/* 右侧名称和版本 */}
            <div className="flex flex-1 items-center gap-3">
              <h2 className="text-2xl font-bold tracking-tight">PolarAgent</h2>
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                {version}
              </span>
            </div>
          </div>

          {/* 下方介绍 - 无背景卡片 */}
          <div className="mt-6">
            <p className="text-sm leading-relaxed text-muted-foreground">
              面向本地工作的 AI Agent 桌面应用，支持普通会话、团队协作、技能与工具扩展。
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium", statusTone(phase))}>
                <UpdateStatusIcon phase={phase} />
                {updateMessage}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{updateDetail}</p>
            {updateStatus?.error ? (
              <p className="mt-1 text-xs text-destructive">{updateStatus.error}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {updateStatus?.downloaded ? (
              <Button onClick={() => void handleInstallUpdate()} disabled={installing}>
                <Download className="size-4" />
                {installing ? "正在重启" : "重启安装"}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void handleCheckUpdates()}
              disabled={!electronRuntime || isChecking}
            >
              <RefreshCw className={cn("size-4", isChecking && "animate-spin")} />
              {isChecking ? "检查中" : "检查更新"}
            </Button>
            <Button variant="ghost" onClick={() => void handleOpenReleases()}>
              <ExternalLink className="size-4" />
              发布页
            </Button>
          </div>
        </div>
      </div>

      {/* 底部版权 */}
      <div className="mt-8 text-center">
        <p className="text-xs text-muted-foreground">
          © 2025 PolarAgent. All rights reserved.
        </p>
      </div>
    </section>
  );
}
