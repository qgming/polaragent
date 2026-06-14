// 自动更新监听器：处理后台自动检查时的弹窗逻辑
// src/components/updates/AutoUpdateHandler.tsx

import { useEffect, useRef, useState } from "react";

import { UpdateNotesModal } from "@/components/updates/UpdateNotesModal";
import {
  getUpdateStatus,
  isElectronRuntime,
  onUpdateStatus,
} from "@/lib/electron/electron-api";

export function AutoUpdateHandler() {
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const promptedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectronRuntime()) return undefined;

    let disposed = false;
    void getUpdateStatus().catch(() => {
      // 静默失败，不打扰用户
    });

    const unsubscribe = onUpdateStatus((nextStatus) => {
      if (disposed) return;

      const versionKey = nextStatus.latestTag ?? nextStatus.latestVersion ?? nextStatus.releaseName;
      if (
        nextStatus.triggeredBy === "auto" &&
        nextStatus.phase === "update-available" &&
        nextStatus.updateAvailable &&
        versionKey &&
        promptedVersionRef.current !== versionKey
      ) {
        promptedVersionRef.current = versionKey;
        setUpdateModalOpen(true);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return (
    <UpdateNotesModal
      open={updateModalOpen}
      onOpenChange={setUpdateModalOpen}
      checkOnOpenKey={0}
    />
  );
}
