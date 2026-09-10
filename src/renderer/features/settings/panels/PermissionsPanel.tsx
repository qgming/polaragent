import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { PermissionMode } from "@/shared/contracts/common";
import type { PermissionRuleView } from "@/shared/contracts/permissions";
import type { Settings } from "@/shared/contracts/settings";
import { NativeSelect, PanelLoading, SettingsField, SettingsSection } from "../settings-shared";

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
    : "";

  const handleApprovalModelChange = (value: string) => {
    if (value === "") {
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
        <div className="space-y-2">
          {MODES.map((mode) => {
            const selected = settings.permissionMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                aria-pressed={selected}
                onClick={() => void update({ permissionMode: mode.value })}
                className={cn(
                  "block w-full rounded-lg border p-3 text-left transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                  selected ? "border-brand bg-brand-muted" : "border-border hover:bg-accent",
                )}
              >
                <span className="block text-sm font-medium">{t(mode.labelKey)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(mode.descKey)}
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
          className={cn("space-y-4", !aiReviewActive && "pointer-events-none opacity-50")}
        >
          <SettingsField
            label={t("settings.aiApprovalModel")}
            description={t("settings.aiApprovalModelDesc")}
            control={
              <NativeSelect
                ariaLabel={t("settings.aiApprovalModel")}
                value={approvalModelValue}
                onChange={handleApprovalModelChange}
                className="w-72"
              >
                {/* 空值 = 跟随默认模型 */}
                <option value="">{t("settings.defaultModel")}</option>
                {settings.services.flatMap((service) =>
                  service.models.map((model) => (
                    <option
                      key={`${service.id}${MODEL_VALUE_SEPARATOR}${model.id}`}
                      value={`${service.id}${MODEL_VALUE_SEPARATOR}${model.id}`}
                    >
                      {`${service.name} · ${model.name ?? model.id}`}
                    </option>
                  )),
                )}
              </NativeSelect>
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
            <p className="text-sm text-destructive">{t("errors.loadFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refreshRules()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : rules === null ? (
          <PanelLoading />
        ) : rules.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">
            {t("settings.permissionRulesEmpty")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_1fr_150px_36px] items-center gap-2 border-border border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              <span>{t("settings.ruleTool")}</span>
              <span>{t("settings.rulePattern")}</span>
              <span>{t("settings.ruleCreatedAt")}</span>
              <span />
            </div>
            {rules.map((rule) => (
              <div
                key={`${rule.toolName}${MODEL_VALUE_SEPARATOR}${rule.pattern ?? ""}`}
                className="grid grid-cols-[1fr_1fr_150px_36px] items-center gap-2 border-border border-b px-3 py-2 text-sm transition-colors last:border-b-0 hover:bg-accent"
              >
                <span className="truncate font-mono text-xs">{rule.toolName}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {rule.pattern ?? "—"}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatRuleTime(rule.createdAt)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("settings.removeRule")}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void handleRemoveRule(rule)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
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
