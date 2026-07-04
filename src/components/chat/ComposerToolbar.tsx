// 对话输入工具栏 —— "/" 技能选择 + "📎" 附件选择
//
// "/" 按钮：纯图标按钮，点击弹出技能选择下拉。
//   技能按分组排列：已安装最上方 → 内置第二 → 全局最下。
//   每个分组有分类标题，每个技能名下方默认显示一行描述。
//   选中后通过 onPickSkill 通知上层插入 chip。
// "📎" 按钮：选择文本文件、图片、音频或文档，选中后通过 onPickFile 通知上层插入附件 chip。

import { Paperclip, FileText, Image, Music, FileCheck, Slash } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { pickImageFile, pickTextFile, pickAudioFile, pickDocumentFile } from "@/lib/electron/electron-api";
import { summarizeSkillDescription } from "@/lib/skill";
import { useSkillsStore } from "@/stores/skills/skills-store";
import type { SkillConfig } from "@/types/config";

// 从绝对路径取文件名（兼容正反斜杠）
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// 截断描述为一行，避免过长
function truncateDesc(text: string, max = 60): string {
  if (!text) return "";
  return summarizeSkillDescription(text, max);
}

// 技能分组排序：已安装 → 内置 → 全局
type SkillGroup = { key: "custom" | "builtin" | "global"; skills: SkillConfig[] };

function groupAndSortSkills(skills: SkillConfig[]): SkillGroup[] {
  const custom: SkillConfig[] = [];
  const builtin: SkillConfig[] = [];
  const global: SkillConfig[] = [];

  for (const skill of skills) {
    if (skill.type === "custom") custom.push(skill);
    else if (skill.type === "global") global.push(skill);
    else builtin.push(skill);
  }

  const groups: SkillGroup[] = [];
  if (custom.length > 0) groups.push({ key: "custom", skills: custom });
  if (builtin.length > 0) groups.push({ key: "builtin", skills: builtin });
  if (global.length > 0) groups.push({ key: "global", skills: global });
  return groups;
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
  // 全部技能（内置 + 已安装 + 全局），与技能页一致；store 为空时回退空列表
  const skills = useSkillsStore((state) => state.skills);

  // 按分组排序
  const groups = useMemo(() => groupAndSortSkills(skills), [skills]);

  // 分组标题映射
  const groupLabel: Record<SkillGroup["key"], string> = {
    custom: t("toolbar.skillGroupCustom"),
    builtin: t("toolbar.skillGroupBuiltin"),
    global: t("toolbar.skillGroupGlobal"),
  };

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
          className="max-h-72 w-64 overflow-x-hidden overflow-y-auto"
        >
          {groups.length > 0 ? (
            groups.map((group, gi) => (
              <div key={group.key}>
                {gi > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-xs font-semibold text-muted-foreground">
                  {groupLabel[group.key]}
                </DropdownMenuLabel>
                {group.skills.map((skill) => (
                  <DropdownMenuItem
                    key={skill.id}
                    onSelect={() =>
                      onPickSkill({ id: skill.id, name: skill.name })
                    }
                    className="flex min-w-0 flex-col items-start gap-0.5 overflow-hidden py-2"
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="w-full truncate text-sm font-medium">{skill.name}</span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        {skill.name}
                      </TooltipContent>
                    </Tooltip>
                    {skill.description ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="w-full truncate text-xs text-muted-foreground">
                            {truncateDesc(skill.description, 50)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          {skill.description}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </div>
            ))
          ) : (
            <DropdownMenuItem disabled>{t("toolbar.noSkills")}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 📎：选择文本或图片附件 */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button type="button" className={toolBtnClass}>
                <Paperclip className="size-4" />
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
