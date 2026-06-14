// 关于软件面板
// src/components/settings/AboutPanel.tsx

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { UpdateNotesModal } from "@/components/updates/UpdateNotesModal";
import { useToast } from "@/hooks/useToast";
import {
  getUpdateStatus,
  isElectronRuntime,
  onUpdateStatus,
  type AppUpdateStatus,
} from "@/lib/electron/electron-api";
import { PageTitle } from "./settings-shared";
import logo from "@/assets/logo.png";

export function AboutPanel() {
  const toastError = useToast((state) => state.error);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateCheckKey, setUpdateCheckKey] = useState(0);

  const version = updateStatus?.currentVersion ?? "0.1.0";
  const isChecking = updateStatus?.phase === "checking";

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

  function handleCheckUpdates() {
    setUpdateModalOpen(true);
    setUpdateCheckKey((key) => key + 1);
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

      <div className="mt-6 flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-5 py-4">
        <span className="text-sm font-medium">检查更新</span>
        <Button variant="outline" onClick={() => void handleCheckUpdates()} disabled={isChecking}>
          <RefreshCw className={isChecking ? "size-4 animate-spin" : "size-4"} />
          {isChecking ? "检查中" : "检查更新"}
        </Button>
      </div>

      <UpdateNotesModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        checkOnOpenKey={updateCheckKey}
      />

      {/* 底部版权 */}
      <div className="mt-8 text-center">
        <p className="text-xs text-muted-foreground">
          © 2025 PolarAgent. All rights reserved.
        </p>
      </div>
    </section>
  );
}
