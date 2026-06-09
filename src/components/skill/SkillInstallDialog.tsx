// Skills 安装对话框

import { useState } from "react";
import { Download, FolderOpen, Loader2, Wrench } from "lucide-react";
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
  const [installType, setInstallType] = useState<"git" | "local" | null>(null);
  const [source, setSource] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  if (!isOpen) return null;

  const handleInstall = async () => {
    if (!installType || !source.trim()) {
      setError("请输入有效的源地址");
      return;
    }

    setIsInstalling(true);
    setError(null);

    try {
      let success = false;

      if (installType === "git") {
        success = await skillLoader.installSkillFromGit(source);
      } else {
        success = await skillLoader.installSkillFromLocal(source);
      }

      if (success) {
        toast.success("技能安装成功");
        onInstallSuccess();
        onClose();
      } else {
        toast.error("技能安装失败");
        setError("安装失败，请检查源地址");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "安装失败";
      toast.error(message);
      setError(message);
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <Modal open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalContent size="md" showCloseButton={true} className="max-w-lg rounded-lg bg-background">
        <ModalTitle className="sr-only">安装 Skill</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Wrench className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">安装 Skill</span>
          {installType && (
            <span className="shrink-0 text-xs text-muted-foreground">
              · {installType === "git" ? "Git 仓库" : "本地目录"}
            </span>
          )}
        </header>

        <ModalBody className="space-y-4">
          {!installType && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">选择安装方式：</p>

              <button
                onClick={() => setInstallType("git")}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
              >
                <Download className="size-5 text-primary" />
                <div>
                  <p className="font-medium">从 Git 仓库安装</p>
                  <p className="text-xs text-muted-foreground">
                    从 GitHub、GitLab 等 Git 仓库克隆 Skill
                  </p>
                </div>
              </button>

              <button
                onClick={() => setInstallType("local")}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
              >
                <FolderOpen className="size-5 text-primary" />
                <div>
                  <p className="font-medium">从本地目录安装</p>
                  <p className="text-xs text-muted-foreground">
                    从本地文件系统导入 Skill
                  </p>
                </div>
              </button>
            </div>
          )}

          {installType && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium">
                  {installType === "git" ? "Git 仓库 URL" : "本地目录路径"}
                </label>
                <input
                  type="text"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={
                    installType === "git"
                      ? "https://github.com/user/skill-repo.git"
                      : "C:\\Users\\...\\my-skill"
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  disabled={isInstalling}
                />
              </div>

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
              返回
            </Button>
            <Button
              variant="default"
              onClick={handleInstall}
              disabled={isInstalling || !source.trim()}
            >
              {isInstalling ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  安装中...
                </>
              ) : (
                "安装"
              )}
            </Button>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}
