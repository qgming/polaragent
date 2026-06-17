// 关于软件面板
// src/components/settings/AboutPanel.tsx

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { UpdateNotesModal } from "@/components/updates/UpdateNotesModal";
import { useToast } from "@/hooks/useToast";
import {
  checkForUpdates,
  getUpdateStatus,
  isElectronRuntime,
  onUpdateStatus,
  type AppUpdateStatus,
} from "@/lib/electron/electron-api";
import { PageTitle } from "./settings-shared";
import logo from "@/assets/logo.png";

export function AboutPanel() {
  const { t } = useTranslation("settings");
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(
    null,
  );
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const version = updateStatus?.currentVersion ?? "0.1.0";
  const isChecking = checking || updateStatus?.phase === "checking";

  useEffect(() => {
    if (!isElectronRuntime()) return undefined;

    let disposed = false;
    void getUpdateStatus()
      .then((status) => {
        if (!disposed) setUpdateStatus(status);
      })
      .catch((error) => {
        if (!disposed)
          toastError(error instanceof Error ? error.message : String(error));
      });

    const unsubscribe = onUpdateStatus((status) => {
      if (disposed) return;
      setUpdateStatus(status);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [toastError]);

  async function handleCheckUpdates() {
    if (!isElectronRuntime()) return;

    setChecking(true);
    try {
      const status = await checkForUpdates();
      setUpdateStatus(status);
      if (status.phase === "up-to-date") {
        toastSuccess(t("about.upToDate"));
        return;
      }
      if (status.updateAvailable) {
        setUpdateModalOpen(true);
        return;
      }
      if (status.phase === "check-error") {
        toastError(status.error || t("about.checkFailed"));
        return;
      }
      toastError(status.message || t("about.noUpdate"));
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section>
      <PageTitle title={t("about.title")} description={t("about.description")} />

      {/* 主卡片 - Logo 和基本信息 */}
      <div className="mt-8 rounded-xl border border-border bg-gradient-to-br from-card to-muted/20">
        <div className="px-8 py-8">
          {/* Logo 和名称布局 */}
          <div className="flex items-center gap-6">
            {/* 左侧 Logo - 纯 logo，无边框无背景 */}
            <div className="size-20 shrink-0">
              <img
                src={logo}
                alt="PolarAgent Logo"
                className="size-full object-contain"
              />
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
              {t("about.appDescription")}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-5 py-4">
        <span className="text-sm font-medium">{t("about.checkUpdate")}</span>
        <Button
          variant="outline"
          onClick={() => void handleCheckUpdates()}
          disabled={isChecking}
        >
          <RefreshCw
            className={isChecking ? "size-4 animate-spin" : "size-4"}
          />
          {isChecking ? t("about.checking") : t("about.checkUpdate")}
        </Button>
      </div>

      <UpdateNotesModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        checkOnOpenKey={0}
      />

      {/* 底部版权 */}
      <div className="mt-8 text-center">
        <p className="text-xs text-muted-foreground">
          © 2026 PolarAgent. All rights reserved.
        </p>
      </div>
    </section>
  );
}
