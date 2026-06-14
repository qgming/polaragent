import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { MarkdownContent } from "@/components/markdown/MarkdownContent";
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
  getUpdateStatus,
  installUpdate,
  isElectronRuntime,
  onUpdateStatus,
  openExternal,
  type AppUpdateStatus,
} from "@/lib/electron/electron-api";

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
  const toastError = useToast((state) => state.error);
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const handledCheckKeyRef = useRef(0);
  const electronRuntime = isElectronRuntime();

  const displayVersion = status?.latestTag ?? status?.releaseName;
  const releaseNotes = status?.releaseNotes?.trim();
  const isChecking = checking || status?.phase === "checking";
  const canDownload = Boolean(status?.downloaded || status?.updateAvailable);
  const downloadLabel = status?.downloaded
    ? installing ? "正在重启" : "重启安装"
    : isChecking
      ? "检查中"
      : "下载更新";

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
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [electronRuntime, toastError]);

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
    try {
      if (status?.downloaded) {
        setInstalling(true);
        await installUpdate();
        return;
      }

      if (!status?.enabled && status?.releaseUrl) {
        if (electronRuntime) await openExternal(status.releaseUrl);
        else window.open(status.releaseUrl, "_blank", "noopener,noreferrer");
        return;
      }

      await handleCheckUpdates();
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
      setInstalling(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="xl">
        <ModalHeader className="py-5">
          <ModalTitle className="text-xl">
            {displayVersion ? `新版本 ${displayVersion}` : isChecking ? "正在检查更新" : "版本更新"}
          </ModalTitle>
        </ModalHeader>

        <ModalBody>
          <div className="min-h-[260px] rounded-lg border border-border bg-background px-4 py-4">
            {releaseNotes ? (
              <MarkdownContent
                content={releaseNotes}
                variant="compact"
                className="prose-headings:mt-3 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2"
              />
            ) : (
              <div className="flex min-h-[220px] items-center justify-center text-sm text-muted-foreground">
                {isChecking ? "正在获取更新日志..." : "暂未获取到该版本的更新日志。"}
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

        <ModalFooter>
          <Button
            onClick={() => void handleDownloadUpdate()}
            disabled={!electronRuntime || isChecking || installing || !canDownload}
          >
            {isChecking ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {downloadLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
