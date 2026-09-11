import { Check, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { field, ghostButton } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow, typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { PermissionMode } from "@/shared/contracts/common";
import type { PermissionRuleView } from "@/shared/contracts/permissions";
import type { Settings } from "@/shared/contracts/settings";
import {
  PanelLoading,
  SELECT_NONE,
  SettingsField,
  SettingsSection,
  SettingsSelect,
  secondaryButton,
} from "../settings-shared";

const MODEL_VALUE_SEPARATOR = "::";

// 三模式：标题借用 chat.* 词条，描述用 settings.* 词条（与 Composer 权限 chip 保持一致）
const MODES: readonly {
  value: PermissionMode;
  labelKey: "chat.permissionDefault" | "chat.permissionAiReview" | "chat.permissionFull";
  descKey:
    | "settings.permissionDefaultDesc"
    | "settings.permissionAiReviewDesc"
    | "settings.permissionFullDesc";
}[] = [
  {
    value: "default",
    labelKey: "chat.permissionDefault",
    descKey: "settings.permissionDefaultDesc",
  },
  {
    value: "ai_review",
    labelKey: "chat.permissionAiReview",
    descKey: "settings.permissionAiReviewDesc",
  },
  { value: "full", labelKey: "chat.permissionFull", descKey: "settings.permissionFullDesc" },
];

function PermissionsPanelBody({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [rules, setRules] = useState<PermissionRuleView[] | null>(null);
  const [rulesFailed, setRulesFailed] = useState(false);

  const refreshRules = useCallback(async () => {
    setRulesFailed(false);
    try {
      setRules(await window.polaragent.permissions.listRules());
    } catch {
      setRulesFailed(true);
      setRules([]);
    }
  }, []);

  useEffect(() => {
    void refreshRules();
  }, [refreshRules]);

  const handleRemoveRule = async (rule: PermissionRuleView) => {
    await window.polaragent.permissions.removeRule(rule.toolName, rule.pattern).catch(() => {});
    await refreshRules();
  };

  // 规则时间用本地化短格式，避免自造日期拼接
  const formatRuleTime = (timestamp: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(
      timestamp,
    );

  const aiReviewActive = settings.permissionMode === "ai_review";
  const approvalModelValue = settings.aiApprovalModel
    ? `${settings.aiApprovalModel.serviceId}${MODEL_VALUE_SEPARATOR}${settings.aiApprovalModel.modelId}`
    : SELECT_NONE;

  // 下拉项的值不允许为空串，「跟随默认模型」走 SELECT_NONE 哨兵
  const approvalModelItems = [
    { value: SELECT_NONE, label: t("settings.defaultModel") },
    ...settings.services.flatMap((service) =>
      service.models.map((model) => ({
        value: `${service.id}${MODEL_VALUE_SEPARATOR}${model.id}`,
        label: `${service.name} · ${model.name ?? model.id}`,
      })),
    ),
  ];

  const handleApprovalModelChange = (value: string) => {
    if (value === SELECT_NONE) {
      void update({ aiApprovalModel: null });
      return;
    }
    const index = value.indexOf(MODEL_VALUE_SEPARATOR);
    const serviceId = value.slice(0, index);
    const modelId = value.slice(index + MODEL_VALUE_SEPARATOR.length);
    if (serviceId && modelId) void update({ aiApprovalModel: { serviceId, modelId } });
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.permissionMode")}>
        <div className="space-y-1">
          {MODES.map((mode) => {
            const selected = settings.permissionMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                aria-pressed={selected}
                onClick={() => void update({ permissionMode: mode.value })}
                className={cn(
                  "flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left outline-none transition-colors",
                  "focus-visible:ring-1 focus-visible:ring-foreground/20",
                  selected ? field : "hover:bg-foreground/[0.04]",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13.5px] font-medium">{t(mode.labelKey)}</span>
                  <span className="mt-0.5 text-xs text-foreground/45">{t(mode.descKey)}</span>
                </span>
                {/* 选中态用墨色勾，不再用品牌色描边 */}
                <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                  {selected ? <Check className="size-3.5 text-foreground/70" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {/* AI 审批模型：仅在「帮我审批」模式下可用，其余模式整体灰显 */}
      <SettingsSection>
        <div
          aria-disabled={!aiReviewActive}
          className={cn("space-y-3.5", !aiReviewActive && "pointer-events-none opacity-50")}
        >
          <SettingsField
            label={t("settings.aiApprovalModel")}
            description={t("settings.aiApprovalModelDesc")}
            control={
              <SettingsSelect
                ariaLabel={t("settings.aiApprovalModel")}
                value={approvalModelValue}
                items={approvalModelItems}
                onChange={handleApprovalModelChange}
                className="w-72"
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.permissionRules")}
        description={t("settings.permissionRulesDesc")}
      >
        {rulesFailed ? (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-destructive">{t("errors.loadFailed")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void refreshRules()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : rules === null ? (
          <PanelLoading />
        ) : rules.length === 0 ? (
          <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-foreground/45">
            {t("settings.permissionRulesEmpty")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/60">
            <div className="grid grid-cols-[1fr_1fr_150px_36px] items-center gap-2 border-border/60 border-b px-3 py-2">
              <span className={typeEyebrow}>{t("settings.ruleTool")}</span>
              <span className={typeEyebrow}>{t("settings.rulePattern")}</span>
              <span className={typeEyebrow}>{t("settings.ruleCreatedAt")}</span>
              <span />
            </div>
            {rules.map((rule) => (
              <div
                key={`${rule.toolName}${MODEL_VALUE_SEPARATOR}${rule.pattern ?? ""}`}
                className="grid grid-cols-[1fr_1fr_150px_36px] items-center gap-2 border-border/60 border-b px-3 py-1.5 transition-colors last:border-b-0 hover:bg-foreground/[0.04]"
              >
                <span className={cn(typePackage, "truncate")}>{rule.toolName}</span>
                <span className={cn(typePackage, "truncate text-foreground/45")}>
                  {rule.pattern ?? "—"}
                </span>
                <span className={cn(typePackage, "text-foreground/45")}>
                  {formatRuleTime(rule.createdAt)}
                </span>
                <button
                  type="button"
                  aria-label={t("settings.removeRule")}
                  className={cn(ghostButton, "size-6 hover:text-destructive")}
                  onClick={() => void handleRemoveRule(rule)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

export function PermissionsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <PermissionsPanelBody settings={settings} />;
}
