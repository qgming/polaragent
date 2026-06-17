import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "@/components/ui/modal";
import { useToast } from "@/hooks/useToast";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
  isElectronRuntime,
  onUpdateStatus,
  openExternal,
  type AppUpdateStatus,
} from "@/lib/electron/electron-api";

import { ReleaseNotesRenderer } from "./ReleaseNotesRenderer";

interface UpdateNotesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkOnOpenKey?: number;
}

export function UpdateNotesModal({
  open,
  onOpenChange,
  checkOnOpenKey = 0,
}: UpdateNotesModalProps) {
  const { t } = useTranslation("common");
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const handledCheckKeyRef = useRef(0);
  const electronRuntime = isElectronRuntime();

  const displayVersion = status?.latestTag ?? status?.releaseName;
  const releaseNotes = status?.releaseNotes?.trim();
  const isChecking = checking || status?.phase === "checking";
  const isDownloading = downloading || status?.phase === "downloading";
  const canDownload = status?.updateAvailable && !status?.downloaded && status?.enabled;
  const canInstall = status?.downloaded;

  useEffect(() => {
    if (!electronRuntime) return undefined;

    let disposed = false;
    void getUpdateStatus()
      .then((nextStatus) => {
        if (!disposed) setStatus(nextStatus);
      })
      .catch((error) => {
        if (!disposed) toastError(error instanceof Error ? error.message : String(error));
      });

    const unsubscribe = onUpdateStatus((nextStatus) => {
      setStatus(nextStatus);

      // 下载完成后 toast 提示
      if (nextStatus.phase === "downloaded") {
        toastSuccess(t("update.downloadedToast"));
        setDownloading(false);
      }

      // 下载失败 toast 提示
      if (nextStatus.phase === "download-error" || nextStatus.phase === "download-unavailable") {
        toastError(nextStatus.message || t("update.downloadFailed"));
        setDownloading(false);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [electronRuntime, t, toastError, toastSuccess]);

  const handleCheckUpdates = useCallback(async () => {
    if (!electronRuntime) return;

    setChecking(true);
    try {
      const nextStatus = await checkForUpdates();
      setStatus(nextStatus);
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, [electronRuntime, toastError]);

  useEffect(() => {
    if (!open || checkOnOpenKey <= 0 || handledCheckKeyRef.current === checkOnOpenKey) return;
    handledCheckKeyRef.current = checkOnOpenKey;
    void handleCheckUpdates();
  }, [checkOnOpenKey, handleCheckUpdates, open]);

  async function handleDownloadUpdate() {
    if (!electronRuntime) return;

    try {
      if (canInstall) {
        // 已下载完成，重启安装
        setInstalling(true);
        await installUpdate();
        return;
      }

      if (canDownload) {
        // 触发下载
        setDownloading(true);
        await downloadUpdate();
        return;
      }

      // 平台不支持或开发环境，打开发布页
      if (status?.releaseUrl) {
        await openExternal(status.releaseUrl);
        return;
      }
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
      setDownloading(false);
      setInstalling(false);
    }
  }

  async function handleOpenReleases() {
    if (!status?.releaseUrl) return;

    try {
      if (electronRuntime) {
        await openExternal(status.releaseUrl);
      } else {
        window.open(status.releaseUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  }

  const getActionButtonLabel = () => {
    if (installing) return t("update.restarting");
    if (canInstall) return t("update.restartInstall");
    if (isDownloading) return t("update.downloading");
    if (canDownload) return t("update.updateNow");
    return t("update.openRelease");
  };

  const getActionButtonIcon = () => {
    if (isChecking || isDownloading || installing) {
      return <RefreshCw className="size-4 animate-spin" />;
    }
    if (canDownload || canInstall) {
      return <Download className="size-4" />;
    }
    return <ExternalLink className="size-4" />;
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="xl">
        <ModalHeader className="py-5">
          <ModalTitle className="text-xl">
            {displayVersion ? t("update.newVersion", { version: displayVersion }) : isChecking ? t("update.checking") : t("update.title")}
          </ModalTitle>
        </ModalHeader>

        <ModalBody>
          <div className="min-h-[260px] rounded-lg border border-border bg-background px-4 py-4">
            {releaseNotes ? (
              <ReleaseNotesRenderer content={releaseNotes} />
            ) : (
              <div className="flex min-h-[220px] items-center justify-center text-sm text-muted-foreground">
                {isChecking ? t("update.fetchingNotes") : t("update.noNotes")}
              </div>
            )}
            {status?.releaseNotesError ? (
              <p className="mt-3 text-xs text-destructive">{status.releaseNotesError}</p>
            ) : null}
            {status?.error ? (
              <p className="mt-3 text-xs text-destructive">{status.error}</p>
            ) : null}
          </div>
        </ModalBody>

        <ModalFooter className="gap-2">
          {status?.releaseUrl ? (
            <Button variant="outline" onClick={() => void handleOpenReleases()}>
              <ExternalLink className="size-4" />
	              {t("update.openRelease")}
            </Button>
          ) : null}
          <Button
            onClick={() => void handleDownloadUpdate()}
            disabled={!electronRuntime || isChecking || isDownloading || installing || (!canDownload && !canInstall && !status?.releaseUrl)}
          >
            {getActionButtonIcon()}
            {getActionButtonLabel()}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
