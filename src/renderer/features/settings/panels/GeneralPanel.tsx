import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Input } from "@/renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import {
  PanelLoading,
  SELECT_NONE,
  Segmented,
  SettingsField,
  SettingsSection,
  SettingsSelect,
  secondaryButton,
  settingsInput,
} from "../settings-shared";

/**
 * 「打开目录」按钮：走主进程的 app.openPath（那里会校验绝对路径再交给系统）。
 * 失败原因挂在该按钮的 tooltip 上，不静默吞掉 —— 打开失败通常意味着目录被删或被占用。
 */
function OpenDirButton({ target, label }: { target: string | null; label: string }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<string | null>(null);

  const handleClick = async () => {
    if (target === null || target === "") return;
    const result = await window.polaragent.app.openPath(target).catch(() => null);
    setReason(result === null || !result.ok ? (result?.reason ?? t("errors.generic")) : null);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            disabled={target === null || target === ""}
            onClick={() => void handleClick()}
          >
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      {reason !== null ? (
        <TooltipContent>{`${t("settings.openFailed")}：${reason}`}</TooltipContent>
      ) : null}
    </Tooltip>
  );
}

/** 面板主体：settings 已就绪后由外层传入，避免内部到处判空 */
function GeneralPanelBody({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  // 滑块拖动过程只更新本地，松开指针或键盘释放时才落盘
  const [chatFontSize, setChatFontSize] = useState(settings.chatFontSize);
  const [dataDir, setDataDir] = useState<string | null>(null);

  // 数据目录：读取一次用于展示；「打开目录」走 app.openPath（见下）
  useEffect(() => {
    void window.polaragent.app
      .getInfo()
      .then((info) => setDataDir(info.dataDir))
      .catch(() => setDataDir(null));
  }, []);

  // 外部（同步/回滚）改变设置时，同步本地编辑值
  useEffect(() => setChatFontSize(settings.chatFontSize), [settings.chatFontSize]);

  // 滑块拖动过程只更新本地，松开指针或键盘释放时才写入
  const commitChatFontSize = () => {
    if (chatFontSize !== settings.chatFontSize) void update({ chatFontSize });
  };

  const handlePickWorkingDir = async () => {
    const dir = await window.polaragent.dialog
      .pickDirectory(settings.defaultWorkingDir ?? undefined)
      .catch(() => null);
    if (dir) void update({ defaultWorkingDir: dir });
  };

  const handlePickLanguage = (language: "zh-CN" | "en-US") => {
    void update({ language });
    // 界面语言立即切换，与设置落盘并行
    void i18n.changeLanguage(language);
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.appearanceSection")}>
        <SettingsField
          label={t("settings.theme")}
          description={t("settings.themeDesc")}
          control={
            <Segmented
              ariaLabel={t("settings.theme")}
              value={settings.theme}
              onChange={(theme) => void update({ theme })}
              options={[
                { value: "light", label: t("app.themeLight") },
                { value: "dark", label: t("app.themeDark") },
                { value: "system", label: t("app.themeSystem") },
              ]}
            />
          }
        />
        <SettingsField
          label={t("settings.density")}
          description={t("settings.densityDesc")}
          control={
            <Segmented
              ariaLabel={t("settings.density")}
              value={settings.density}
              onChange={(density) => void update({ density })}
              options={[
                { value: "comfortable", label: t("settings.densityComfortable") },
                { value: "compact", label: t("settings.densityCompact") },
              ]}
            />
          }
        />
        <SettingsField
          label={t("settings.language")}
          description={t("settings.languageDesc")}
          control={
            <Segmented
              ariaLabel={t("settings.language")}
              value={settings.language}
              onChange={handlePickLanguage}
              options={[
                { value: "zh-CN", label: "简体中文" },
                { value: "en-US", label: "English" },
              ]}
            />
          }
        />
      </SettingsSection>

      {/* 对话排版：不设分区标题，保持与设计稿一致的安静行式布局 */}
      <SettingsSection>
        <SettingsField
          label={t("settings.chatFont")}
          description={t("settings.chatFontDesc")}
          control={
            /*
              原来是一个自由文本输入框，要用户自己敲字体名，留空才回落到默认 ——
              基本没人用，等于一个死设置。改成字体栈下拉：值直接写 CSS 变量引用
              （自定义属性的间接引用会在使用处解析，因此仍然跟随主题令牌），
              空串仍然表示「跟随界面」；Radix Select 不接受空串值，用 SELECT_NONE 哨兵顶上。
              下拉没有「失焦提交」这一步，所以直接落盘（store 是乐观更新）。
            */
            <SettingsSelect
              ariaLabel={t("settings.chatFont")}
              className="w-32"
              value={settings.chatFont === "" ? SELECT_NONE : settings.chatFont}
              onChange={(value) => void update({ chatFont: value === SELECT_NONE ? "" : value })}
              items={[
                { value: SELECT_NONE, label: t("settings.chatFontDefault") },
                { value: "var(--font-sans)", label: t("settings.chatFontSans") },
                { value: "var(--font-display)", label: t("settings.chatFontSerif") },
                { value: "var(--font-mono)", label: t("settings.chatFontMono") },
              ]}
            />
          }
        />
        <SettingsField
          label={t("settings.chatFontSize")}
          description={t("settings.chatFontSizeDesc")}
          htmlFor="settings-chat-font-size"
          control={
            <div className="flex items-center gap-2">
              <input
                id="settings-chat-font-size"
                type="range"
                min={12}
                max={20}
                step={1}
                value={chatFontSize}
                aria-label={t("settings.chatFontSize")}
                onChange={(e) => setChatFontSize(Number(e.target.value))}
                onPointerUp={commitChatFontSize}
                onKeyUp={commitChatFontSize}
                onBlur={commitChatFontSize}
                className="h-1 w-32 cursor-pointer accent-foreground focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:outline-none"
              />
              <span className={cn(typePackage, "w-10 shrink-0 text-right text-foreground/40")}>
                {chatFontSize}px
              </span>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.dataSection")}>
        <SettingsField
          label={t("settings.workingDir")}
          description={t("settings.workingDirDesc")}
          htmlFor="settings-working-dir"
          control={
            <div className="flex items-center gap-2">
              <Input
                id="settings-working-dir"
                readOnly
                value={settings.defaultWorkingDir ?? ""}
                placeholder="—"
                className={cn(settingsInput, "w-56 font-mono")}
              />
              <OpenDirButton target={settings.defaultWorkingDir} label={t("settings.openFolder")} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={secondaryButton}
                onClick={() => void handlePickWorkingDir()}
              >
                {t("settings.pickDirectory")}
              </Button>
            </div>
          }
        />
        <SettingsField
          label={t("settings.dataDir")}
          description={t("settings.dataDirDesc")}
          control={
            <div className="flex items-center gap-2">
              {/* 路径是唯一信息来源，用 mono 截断展示；完整路径在 title 里 */}
              <span
                className={cn(typePackage, "max-w-[240px] truncate text-foreground/40")}
                title={dataDir ?? undefined}
              >
                {dataDir ?? "—"}
              </span>
              <OpenDirButton target={dataDir} label={t("settings.openDataDir")} />
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}

export function GeneralPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <GeneralPanelBody settings={settings} />;
}
