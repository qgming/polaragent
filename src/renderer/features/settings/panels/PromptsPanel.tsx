import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { Input } from "@/renderer/components/ui/input";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Textarea } from "@/renderer/components/ui/textarea";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { PromptTemplateInfo, PromptTemplateWriteRequest } from "@/shared/contracts/prompts";
import { normalizePromptName, PROMPT_NAME_PATTERN } from "@/shared/contracts/prompts";
import type { SkillSource } from "@/shared/contracts/skills";
import {
  AddButton,
  ipcErrorMessage,
  PanelLoading,
  PanelToolbar,
  Segmented,
  SettingsDialog,
  SettingsSection,
  secondaryButton,
  settingsInput,
  settingsTextarea,
} from "../settings-shared";

/** 空态文案：系统（内置）与用户（磁盘扫描）各自一份，别让「没有」显得像坏了 */
function PromptsEmpty({ source }: { source: SkillSource }) {
  const { t } = useTranslation();
  return (
    <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-ink-3">
      {source === "builtin" ? t("settings.promptsSystemEmpty") : t("settings.promptTemplatesEmpty")}
      <span className="mt-1 block text-xs text-ink-4">
        {source === "builtin"
          ? t("settings.promptsSystemEmptyHint")
          : t("settings.promptTemplatesEmptyHint")}
      </span>
    </p>
  );
}

/**
 * 内置提示的**只读**查看器。
 *
 * 为什么不复用 PromptEditor：内置提示住在应用目录里，改它等于改应用自身，而且升级时会被整包
 * 替换 —— 用户改过的那份会无声消失。所以这里不提供保存与删除，只在末尾说清「怎么才能改到它」：
 * 新建一份**同名**提示（同名时数据目录那一份胜出，见主进程 list 的去重顺序）。
 *
 * 与「内置技能不可删除」同一条原则：不是不给改，而是把改的入口指向那个改得住的地方。
 */
function PromptViewer({ info, onClose }: { info: PromptTemplateInfo; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingsDialog
      title={t("settings.promptView")}
      description={t("settings.promptViewDesc")}
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className={typePackage}>{t("settings.promptName")}</div>
          <p className={cn(mono, "text-[13px]")}>{info.name}</p>
        </div>

        {info.description === "" ? null : (
          <div className="space-y-1.5">
            <div className={typePackage}>{t("settings.promptDescription")}</div>
            <p className="text-[13px]">{info.description}</p>
          </div>
        )}

        <div className="space-y-1.5">
          <div className={typePackage}>{t("settings.promptContent")}</div>
          {/* 正文用等宽、保留换行：它是要被原样发出去的提示词，排版即语义 */}
          <p
            className={cn(
              mono,
              "rounded-xl border border-border/60 p-3 whitespace-pre-wrap text-xs leading-relaxed",
            )}
          >
            {info.content}
          </p>
        </div>

        <p className="text-xs text-ink-3">{t("settings.promptViewHint")}</p>
        <p className={cn(mono, "truncate text-ink-4")} title={info.dir}>
          {info.dir}
        </p>
      </div>
    </SettingsDialog>
  );
}

/**
 * 模板编辑器：新建与点击已有模板共用同一个弹窗。
 *
 * 用列表里的解析结果（描述 + 正文）当初始值，而不是回读文件原文 —— 列表显示的就是内核解析出来的
 * 那一份，编辑框与列表永远不会对不上；保存时按同样的结构重新序列化（frontmatter 只写描述）。
 */
function PromptEditor({
  info,
  onClose,
  onSaved,
}: {
  /** null = 新建 */
  info: PromptTemplateInfo | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(info?.name ?? "");
  const [description, setDescription] = useState(info?.description ?? "");
  const [content, setContent] = useState(info?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const normalizedName = normalizePromptName(name);
  const nameValid = PROMPT_NAME_PATTERN.test(normalizedName);
  const contentValid = content.trim() !== "";
  const canSave = nameValid && contentValid && !busy;

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    const request: PromptTemplateWriteRequest = {
      ...(info === null ? {} : { originalName: info.name }),
      name: normalizedName,
      description,
      content,
    };
    try {
      await window.oint.prompts.write(request);
      await onSaved();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setConfirmRemove(false);
    if (info === null) return;
    setBusy(true);
    setError(null);
    try {
      await window.oint.prompts.remove(info.name);
      await onSaved();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsDialog
        title={info === null ? t("settings.promptNew") : t("settings.promptEdit")}
        description={t("settings.promptEditorDesc")}
        onClose={onClose}
        footer={
          <>
            {info === null ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={secondaryButton}
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                {t("common.delete")}
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="button" size="sm" disabled={!canSave} onClick={() => void handleSave()}>
                {busy ? t("common.loading") : t("common.save")}
              </Button>
            </div>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className={typePackage}>{t("settings.promptName")}</div>
            <Input
              value={name}
              aria-label={t("settings.promptName")}
              placeholder="plan"
              className={cn(settingsInput, "font-mono")}
              onChange={(event) => setName(event.target.value)}
            />
            <p className={cn("text-xs", nameValid ? "text-ink-3" : "text-destructive")}>
              {nameValid ? t("settings.promptNameHint") : t("settings.promptNameInvalid")}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className={typePackage}>{t("settings.promptDescription")}</div>
            <Input
              value={description}
              aria-label={t("settings.promptDescription")}
              placeholder={t("settings.promptDescriptionHint")}
              className={settingsInput}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className={typePackage}>{t("settings.promptContent")}</div>
            <Textarea
              value={content}
              aria-label={t("settings.promptContent")}
              rows={10}
              placeholder={
                "先只读探索，给出实现计划：\n\n1. 要改哪些文件…\n2. 怎么验证…\n\n在我确认前不要动手。\n"
              }
              className={cn(settingsTextarea, "font-mono text-xs")}
              onChange={(event) => setContent(event.target.value)}
            />
            {contentValid ? null : (
              <p className="text-xs text-destructive">{t("settings.promptContentRequired")}</p>
            )}
          </div>

          {error === null ? null : <p className="text-[13px] text-destructive">{error}</p>}
        </div>
      </SettingsDialog>

      {/* 删除二次确认：模板文件会被直接删掉 */}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="rounded-xl">
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>
              {t("settings.promptRemoveDesc", { name: info?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleRemove()}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PromptsPanelBody() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<PromptTemplateInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  // 提示来源切换：系统 = 随应用内置，用户 = 自己放进数据目录的
  // （面板不带会话，项目级 .oint/prompts 只在会话的斜杠菜单里出现）
  const [source, setSource] = useState<SkillSource>("user");
  const [editor, setEditor] = useState<{ info: PromptTemplateInfo | null } | null>(null);

  const refresh = useCallback(async () => {
    setFailed(false);
    setTemplates(null);
    try {
      setTemplates(await window.oint.prompts.list());
    } catch {
      setFailed(true);
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = (templates ?? []).filter((template) => template.source === source);

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("settings.promptTemplatesList")}
        description={t("settings.promptTemplatesDesc")}
      >
        <PanelToolbar
          action={
            source === "user" ? (
              <AddButton
                label={t("settings.promptNew")}
                onClick={() => setEditor({ info: null })}
              />
            ) : undefined
          }
        >
          <Segmented<SkillSource>
            ariaLabel={t("settings.sourceLabel")}
            value={source}
            onChange={setSource}
            options={[
              { value: "builtin", label: t("settings.sourceTabSystem") },
              { value: "user", label: t("settings.sourceTabUser") },
            ]}
          />
        </PanelToolbar>
        {failed ? (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-destructive">{t("errors.loadFailed")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void refresh()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : templates === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : visible.length === 0 ? (
          <PromptsEmpty source={source} />
        ) : (
          <div className="space-y-2">
            {visible.map((template) => (
              <button
                key={template.name}
                type="button"
                className="block w-full cursor-pointer rounded-xl border border-border/60 p-3 text-left transition-colors hover:bg-foreground/[0.03]"
                onClick={() => setEditor({ info: template })}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{template.name}</span>
                  {template.source === "builtin" ? (
                    <Badge
                      variant="outline"
                      className={cn(mono, "border-border/60 px-1.5 text-ink-4")}
                    >
                      {t("settings.promptSystemBadge")}
                    </Badge>
                  ) : null}
                </span>
                {template.description === "" ? null : (
                  <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{template.description}</p>
                )}
                {/* 正文可能很长：只给固定行数的等宽预览并裁掉溢出，展开查看在弹窗里做 */}
                <p className={cn(mono, "mt-1 line-clamp-4 whitespace-pre-wrap text-ink-4")}>
                  {template.content}
                </p>
                <p className={cn(mono, "mt-1 block truncate text-ink-4")} title={template.dir}>
                  {template.dir}
                </p>
              </button>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 内置提示只看不改（点开的是只读查看器），用户提示走原来的编辑器 */}
      {editor === null ? null : editor.info?.source === "builtin" ? (
        <PromptViewer info={editor.info} onClose={() => setEditor(null)} />
      ) : (
        <PromptEditor
          info={editor.info}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

export function PromptsPanel() {
  // 与其余面板同一个加载口径：设置就绪前先给占位，避免面板闪一下
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <PromptsPanelBody />;
}
