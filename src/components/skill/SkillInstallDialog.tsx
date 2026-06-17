// Skills 安装对话框

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileArchive, Loader2, Wrench } from "lucide-react";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/useToast";
import { skillLoader } from "@/lib/skill";
import { pickZipFile } from "@/lib/electron/electron-api";

interface SkillInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstallSuccess: () => void;
}

export function SkillInstallDialog({
  isOpen,
  onClose,
  onInstallSuccess,
}: SkillInstallDialogProps) {
  const { t } = useTranslation("skills");
  const [installType, setInstallType] = useState<"git" | "zip" | null>(null);
  const [source, setSource] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  if (!isOpen) return null;

  const handleSelectZip = async () => {
    try {
      const zipPath = await pickZipFile();
      if (zipPath) {
        setSource(zipPath);
        setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("installDialog.selectFileFailed");
      toast.error(message);
      setError(message);
    }
  };

  const handleInstall = async () => {
    if (!installType || !source.trim()) {
      setError(t("installDialog.selectValidSource"));
      return;
    }

    setIsInstalling(true);
    setError(null);

    try {
      let success = false;

      if (installType === "git") {
        success = await skillLoader.installSkillFromGit(source);
      } else {
        success = await skillLoader.installSkillFromZip(source);
      }

      if (success) {
        toast.success(t("installDialog.success"));
        onInstallSuccess();
        onClose();
      } else {
        toast.error(t("installDialog.failed"));
        setError(t("installDialog.failedCheckSource"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("installDialog.failedShort");
      toast.error(message);
      setError(message);
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <Modal open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalContent size="md" showCloseButton={true} className="max-w-lg rounded-lg bg-background">
        <ModalTitle className="sr-only">{t("installDialog.title")}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Wrench className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{t("installDialog.title")}</span>
          {installType && (
            <span className="shrink-0 text-xs text-muted-foreground">
              · {installType === "git" ? t("installDialog.gitRepo") : t("installDialog.localZip")}
            </span>
          )}
        </header>

        <ModalBody className="space-y-4">
          {!installType && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("installDialog.chooseMethod")}</p>

              <button
                onClick={() => setInstallType("git")}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
              >
                <Download className="size-5 text-primary" />
                <div>
                  <p className="font-medium">{t("installDialog.fromGit")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("installDialog.fromGitDesc")}
                  </p>
                </div>
              </button>

              <button
                onClick={() => setInstallType("zip")}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
              >
                <FileArchive className="size-5 text-primary" />
                <div>
                  <p className="font-medium">{t("installDialog.fromZip")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("installDialog.fromZipDesc")}
                  </p>
                </div>
              </button>
            </div>
          )}

          {installType && (
            <div className="space-y-4">
              {installType === "git" ? (
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    {t("installDialog.gitUrl")}
                  </label>
                  <input
                    type="text"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="https://github.com/user/skill-repo.git"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    disabled={isInstalling}
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    {t("installDialog.zipFile")}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={source}
                      readOnly
                      placeholder={t("installDialog.zipPlaceholder")}
                      className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                      disabled={isInstalling}
                    />
                    <Button
                      variant="outline"
                      onClick={handleSelectZip}
                      disabled={isInstalling}
                    >
                      {t("installDialog.chooseFile")}
                    </Button>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                  {error}
                </div>
              )}
            </div>
          )}
        </ModalBody>

        {installType && (
          <ModalFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInstallType(null);
                setSource("");
                setError(null);
              }}
              disabled={isInstalling}
            >
              {t("installDialog.back")}
            </Button>
            <Button
              variant="default"
              onClick={handleInstall}
              disabled={isInstalling || !source.trim()}
            >
              {isInstalling ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("installDialog.installing")}
                </>
              ) : (
                t("installDialog.install")
              )}
            </Button>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}
