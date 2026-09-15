import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Switch } from "@/renderer/components/ui/switch";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillDetail, SkillInfo, SkillSource } from "@/shared/contracts/skills";
import {
  AddButton,
  ipcErrorMessage,
  PanelLoading,
  PanelToolbar,
  Segmented,
  SettingsDialog,
  SettingsSection,
  secondaryButton,
} from "../settings-shared";

/** 空态文案：系统（内置）与用户（磁盘扫描）各自一份，别让「没有」显得像坏了 */
function SkillsEmpty({ source }: { source: SkillSource }) {
  const { t } = useTranslation();
  return (
    <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-ink-3">
      {source === "builtin" ? t("settings.skillsSystemEmpty") : t("settings.skillsEmpty")}
      <span className="mt-1 block text-xs text-ink-4">
        {source === "builtin" ? t("settings.skillsSystemEmptyHint") : t("settings.skillsEmptyHint")}
      </span>
    </p>
  );
}

/** 技能详情：名称 / 描述 / 路径 + SKILL.md 原文；底部给删除（导入错了要能撤） */
function SkillDetailDialog({
  detail,
  onClose,
  onRemove,
}: {
  detail: SkillDetail;
  onClose: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsDialog
      title={detail.name}
      description={t("settings.skillDetailDesc", { name: detail.name })}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" size="sm" className={secondaryButton} onClick={onRemove}>
            {t("common.delete")}
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {detail.description === "" ? null : (
          <p className="text-[13px] text-ink-3">{detail.description}</p>
        )}
        <p className={cn(mono, "break-all text-ink-4")}>{detail.filePath}</p>
        {/* 原文可能很长：正文区自己滚动，整段铺开会把弹窗撑爆 */}
        <pre className="app-scrollbar max-h-[46vh] overflow-auto rounded-xl border border-border/60 p-3 text-xs whitespace-pre-wrap text-ink-2">
          {detail.content}
        </pre>
      </div>
    </SettingsDialog>
  );
}

function SkillsPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  // 技能来源切换：系统 = 随应用内置，用户 = 自己放进数据目录的
  // （面板不带会话，项目级 .oint/skills 只在会话的斜杠菜单里出现）
  const [source, setSource] = useState<SkillSource>("user");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SkillInfo | null>(null);

  const refresh = useCallback(async () => {
    setFailed(false);
    setSkills(null);
    try {
      setSkills(await window.oint.skills.list());
    } catch {
      setFailed(true);
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggleSkill = (name: string, enabled: boolean) => {
    const disabled = new Set(settings.disabledSkillNames);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    void update({ disabledSkillNames: [...disabled] });
  };

  /** 导入 zip：取消不动任何状态；导完把「写了多少文件 / 认出多少技能」如实报出来 */
  const handleImport = async () => {
    setImporting(true);
    setNotice(null);
    try {
      const result = await window.oint.skills.import();
      if (result.canceled) return;
      await refresh();
      const summary = t("settings.skillImportDone", {
        files: result.files,
        skills: result.skills,
      });
      const extra = result.skills === 0 ? [t("settings.skillImportNoSkill")] : [];
      const problems = [...extra, ...result.diagnostics];
      setNotice({
        tone: problems.length === 0 ? "ok" : "error",
        text: problems.length === 0 ? summary : `${summary}；${problems.join("；")}`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `${t("settings.skillImportFailed")}${ipcErrorMessage(error)}`,
      });
    } finally {
      setImporting(false);
    }
  };

  const handleOpenDetail = async (skill: SkillInfo) => {
    setDetailError(null);
    try {
      setDetail(await window.oint.skills.read(skill.name));
    } catch (error) {
      setDetailError(ipcErrorMessage(error));
    }
  };

  const handleRemove = async (skill: SkillInfo) => {
    setConfirmRemove(null);
    setDetail(null);
    setNotice(null);
    try {
      await window.oint.skills.remove(skill.name);
    } catch (error) {
      setNotice({ tone: "error", text: ipcErrorMessage(error) });
      return;
    }
    await refresh();
  };

  const visible = (skills ?? []).filter((skill) => skill.source === source);

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.skillsList")} description={t("settings.skillsListDesc")}>
        <PanelToolbar
          action={
            source === "user" ? (
              <AddButton
                label={t("settings.skillImport")}
                disabled={importing}
                onClick={() => void handleImport()}
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
        {notice === null ? null : (
          <p
            className={cn(
              "text-[13px]",
              notice.tone === "ok" ? "text-ink-3" : "text-destructive",
            )}
          >
            {notice.text}
          </p>
        )}
        {/* 打开详情失败（例如文件被手工删了）单独提示：列表还在，不能整个面板报错 */}
        {detailError === null ? null : <p className="text-[13px] text-destructive">{detailError}</p>}
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
        ) : skills === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : visible.length === 0 ? (
          <SkillsEmpty source={source} />
        ) : (
          <div className="space-y-2">
            {visible.map((skill) => {
              // 设置中的禁用名单是唯一事实来源，避免列表快照过期
              const enabled = !settings.disabledSkillNames.includes(skill.name);
              return (
                <div
                  key={skill.filePath}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border/60 p-3 transition-colors hover:bg-foreground/[0.03]"
                >
                  {/* 整块信息区就是「查看详情」的入口：点击打开与新增同一个弹窗组件 */}
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    onClick={() => void handleOpenDetail(skill)}
                  >
                    <span className="truncate text-[13.5px] font-medium">{skill.name}</span>
                    <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{skill.description}</p>
                    <p className={cn(mono, "mt-1 truncate text-ink-4")} title={skill.filePath}>
                      {skill.filePath}
                    </p>
                  </button>
                  <Switch
                    size="sm"
                    aria-label={
                      enabled
                        ? `${skill.name} · ${t("settings.skillEnabled")}`
                        : `${skill.name} · ${t("settings.skillDisabled")}`
                    }
                    checked={enabled}
                    onCheckedChange={(checked) => handleToggleSkill(skill.name, checked)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {detail === null ? null : (
        <SkillDetailDialog
          detail={detail}
          onClose={() => setDetail(null)}
          onRemove={() => {
            const row = (skills ?? []).find((item) => item.name === detail.name);
            if (row !== undefined) setConfirmRemove(row);
          }}
        />
      )}

      {/* 删除二次确认：技能目录会被整个删掉，值得确认一次 */}
      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
      >
        <DialogContent className="rounded-xl">
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>
              {t("settings.skillRemoveDesc", { name: confirmRemove?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (confirmRemove !== null) void handleRemove(confirmRemove);
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SkillsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <SkillsPanelBody settings={settings} />;
}
