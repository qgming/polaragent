// 对话输入工具栏 —— "/" 技能选择 + "@" 上下文（占位）
//
// "/" 按钮：纯图标按钮，点击弹出技能选择下拉（样式与助手选择下拉一致）。
//   列出全部技能（内置 + 已安装，即技能页两类），菜单项只显示名称，
//   hover 用 tooltip 显示该技能介绍。选中后通过 onPickSkill 通知上层插入 chip。
// "@" 按钮：选择文本文件、图片、音频或文档，选中后通过 onPickFile 通知上层插入附件 chip。

import { AtSign, FileText, Image, Music, FileCheck, Slash } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { pickImageFile, pickTextFile, pickAudioFile, pickDocumentFile } from "@/lib/electron/electron-api";
import { useSkillsStore } from "@/stores/skills/skills-store";

// 从绝对路径取文件名（兼容正反斜杠）
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// 工具栏小按钮：常驻圆角浅背景，hover 加深
const toolBtnClass =
  "flex size-7 items-center justify-center rounded-md bg-muted/50 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function ComposerToolbar({
  onPickSkill,
  onPickFile,
}: {
  // 选中某个技能时回调（上层据此在富文本输入区插入 chip）
  onPickSkill: (skill: { id: string; name: string }) => void;
  // 选中某个附件时回调（上层据此在富文本输入区插入附件 chip）
  onPickFile: (file: { path: string; name: string; kind: "text" | "image" | "audio" | "document" }) => void;
}) {
  const { t } = useTranslation("chat");
  // 全部技能（内置 + 已安装），与技能页两类一致；store 为空时回退空列表
  const skills = useSkillsStore((state) => state.skills);

  const handlePickTextFile = async () => {
    const path = await pickTextFile();
    if (path) {
      onPickFile({ path, name: basename(path), kind: "text" });
    }
  };

  const handlePickImageFile = async () => {
    const path = await pickImageFile();
    if (path) {
      onPickFile({ path, name: basename(path), kind: "image" });
    }
  };

  const handlePickAudioFile = async () => {
    const path = await pickAudioFile();
    if (path) {
      onPickFile({ path, name: basename(path), kind: "audio" });
    }
  };

  const handlePickDocumentFile = async () => {
    const path = await pickDocumentFile();
    if (path) {
      onPickFile({ path, name: basename(path), kind: "document" });
    }
  };

  return (
    <div className="flex items-center gap-1">
      {/* "/"：技能选择（下拉样式与助手选择一致） */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button type="button" className={toolBtnClass}>
                <Slash className="size-4" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("toolbar.pickSkill")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-56 overflow-y-auto"
        >
          {skills.length > 0 ? (
            skills.map((skill) => (
              <Tooltip key={skill.id}>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onSelect={() =>
                      onPickSkill({ id: skill.id, name: skill.name })
                    }
                  >
                    <span className="truncate">{skill.name}</span>
                  </DropdownMenuItem>
                </TooltipTrigger>
                {skill.description ? (
                  <TooltipContent side="right" className="max-w-xs">
                    {skill.description}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            ))
          ) : (
            <DropdownMenuItem disabled>{t("toolbar.noSkills")}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* "@"：选择文本或图片附件 */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button type="button" className={toolBtnClass}>
                <AtSign className="size-4" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("toolbar.addAttachment")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={() => void handlePickTextFile()}>
            <FileText className="size-4" />
            <span>{t("toolbar.textFile")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handlePickImageFile()}>
            <Image className="size-4" />
            <span>{t("toolbar.image")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handlePickAudioFile()}>
            <Music className="size-4" />
            <span>{t("toolbar.audio")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handlePickDocumentFile()}>
            <FileCheck className="size-4" />
            <span>{t("toolbar.document")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
