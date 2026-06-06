// Skills 安装对话框
// src/components/SkillInstallDialog.tsx

import { useState } from "react";
import { Download, FolderOpen, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/useToast";
import { skillLoader } from "@/lib/skill-loader";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">安装 Skill</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isInstalling}
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Install Type Selection */}
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

        {/* Install Form */}
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

            <div className="flex gap-2">
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
                onClick={handleInstall}
                disabled={isInstalling || !source.trim()}
                className="flex-1"
              >
                {isInstalling ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    安装中...
                  </>
                ) : (
                  "安装"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
