// 项目编辑弹窗：新建/编辑项目（输入项目名称、项目提示词和工作目录）
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import type { ProjectConfig } from "@/types/config";

interface ProjectEditorModalProps {
  // 编辑模式时传入现有项目配置，新建模式为 null
  project: ProjectConfig | null;
  onClose: () => void;
  onSave: (project: ProjectConfig) => void;
}

export function ProjectEditorModal({
  project,
  onClose,
  onSave,
}: ProjectEditorModalProps) {
  const { t } = useTranslation("common");
  const isEditing = project !== null;

  // 表单状态：编辑模式用现有值初始化，新建模式用空值
  const [name, setName] = useState(project?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(project?.systemPrompt ?? "");
  const [workingDir, setWorkingDir] = useState(project?.workingDir ?? "");

  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (dir) setWorkingDir(dir);
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const now = Date.now();
    const id = project?.id ?? `project-${crypto.randomUUID()}`;

    const result: ProjectConfig = {
      id,
      name: trimmedName,
      systemPrompt: systemPrompt.trim(),
      workingDir: workingDir.trim() || undefined,  // 空字符串转 undefined
      createdAt: project?.createdAt ?? now,
      updatedAt: now,
    };

    onSave(result);
  };

  const canSave = name.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t("sidebar.editProject") : t("sidebar.createProject")}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t("sidebar.editProjectDescription")
              : t("sidebar.createProjectDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 项目名称 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("sidebar.projectName")}
            </label>
            <input
              autoFocus
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) {
                  e.preventDefault();
                  handleSave();
                }
              }}
              placeholder={t("sidebar.projectNamePlaceholder")}
              value={name}
            />
          </div>

          {/* 项目工作目录 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("sidebar.projectWorkingDir")}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handlePickDir}
                className="flex h-10 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm transition-colors hover:bg-muted"
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span
                  className={`truncate ${workingDir ? "text-foreground" : "text-muted-foreground"}`}
                  title={workingDir || undefined}
                >
                  {workingDir
                    ? workingDir.split(/[\\/]/).filter(Boolean).pop() || workingDir
                    : t("sidebar.projectWorkingDirPlaceholder")}
                </span>
              </button>
              {workingDir ? (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-10 shrink-0"
                  onClick={() => setWorkingDir("")}
                  title={t("sidebar.clearWorkingDir")}
                >
                  ✕
                </Button>
              ) : null}
            </div>
          </div>

          {/* 项目提示词 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("sidebar.projectPrompt")}
            </label>
            <textarea
              className="min-h-[120px] w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("sidebar.projectPromptPlaceholder")}
              value={systemPrompt}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button
            disabled={!canSave}
            onClick={handleSave}
            type="button"
          >
            {isEditing ? t("save") : t("sidebar.createProject")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
