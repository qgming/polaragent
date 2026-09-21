"use client";

import { CircleGaugeIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { AgentMode, PermissionMode } from "@/shared/contracts";
import { resolveEffectiveModelRef } from "@/shared/model-ref";
import { useActiveWorkingDir } from "../chat/use-slash-commands";
import { CopyValueButton, SessionSection } from "./session-section";

/** 权限三模式的词条沿用 composer 的权限 chip（同一个设置项，不另写一套文案） */
const PERMISSION_KEYS: Record<PermissionMode, string> = {
  default: "chat.permissionDefault",
  ai_review: "chat.permissionAiReview",
  full: "chat.permissionFull",
};

/** 智能体模式的词条同理沿用 composer 的模式 chip */
const AGENT_MODE_KEYS: Record<AgentMode, string> = {
  standard: "chat.agentModeStandard",
  orchestrate: "chat.agentModeOrchestrate",
};

/**
 * 「环境信息」区块：这个会话跑在哪儿、用哪个模型、什么权限、是谁。
 *
 * 每一行都取与真正干活的那一处同源的判定：
 *   · 工作目录 —— useActiveWorkingDir（就是会话绑定的 cwd，见主进程 resolveWorkingDir）
 *   · 模型 —— resolveEffectiveModelRef（与 Composer 的模型 chip、主进程发请求用的是同一个）
 *   · 权限 —— settings.permissionMode（就是主进程权限门读的那一个字段）
 *
 * 会话 id 也列出来并给复制入口：报 bug / 找日志时要的正是它。
 * git 分支**没有**列：渲染层与契约里都还没有这条取数路径，不为它新造 IPC（见交付报告）。
 */
export function EnvironmentSection() {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  /** 会话级模型绑定（null = 跟随默认）；与 Composer 读同一个字段 */
  const boundModel = useChatStore((state) =>
    state.activeSessionId === null
      ? null
      : (state.sessions.find((session) => session.id === state.activeSessionId)?.model ?? null),
  );
  const settings = useSettingsStore((state) => state.settings);
  const workingDir = useActiveWorkingDir();

  const modelLabel = useMemo(() => {
    if (settings === null) return null;
    const ref = resolveEffectiveModelRef(settings, boundModel);
    if (ref === null) return null;
    const model = settings.services
      .find((service) => service.id === ref.serviceId)
      ?.models.find((entry) => entry.id === ref.modelId);
    // 没填显示名时行内只剩模型 id，没必要重复一遍
    return model?.name ?? model?.id ?? ref.modelId;
  }, [settings, boundModel]);

  const permission = settings?.permissionMode ?? "default";

  /**
   * 会话绑定的智能体模式（null = 跟随设置默认）；与 Composer 的模式 chip 读同一个字段。
   *
   * 显示的是**生效值**：主进程装配系统提示时的判定正是
   * `readAgentMode(id) ?? settings.agentMode`（runtime 的 composeMainPrompt），
   * 所以这一行也能用来核对「我以为在编排模式，实际发出去的是哪个」。
   */
  const boundAgentMode = useChatStore((state) =>
    state.activeSessionId === null
      ? undefined
      : state.sessions.find((session) => session.id === state.activeSessionId)?.agentMode,
  );
  const agentMode: AgentMode = boundAgentMode ?? settings?.agentMode ?? "standard";

  return (
    <SessionSection
      slot="environment-panel"
      icon={CircleGaugeIcon}
      title={t("sessionPanel.environment")}
      toggleLabel={t("sessionPanel.environmentToggle")}
    >
      <dl data-slot="environment-list" className="flex flex-col px-2.5 pb-2">
        <ValueRow
          label={t("sessionPanel.workingDir")}
          value={workingDir ?? null}
          copyLabel={t("sessionPanel.copyValue")}
        />
        <ValueRow
          label={t("sessionPanel.model")}
          value={modelLabel}
          copyLabel={t("sessionPanel.copyValue")}
        />
        <ValueRow label={t("sessionPanel.permission")} value={t(PERMISSION_KEYS[permission])} />
        <ValueRow label={t("sessionPanel.agentMode")} value={t(AGENT_MODE_KEYS[agentMode])} />
        <ValueRow
          label={t("sessionPanel.sessionId")}
          value={activeSessionId}
          copyLabel={t("sessionPanel.copySessionId")}
        />
      </dl>
    </SessionSection>
  );
}

/**
 * 一行「标签 + 值（+ 复制）」。
 * 值缺失时给「未指定」这类兜底文案，而不是留一行空白 —— 用户要能分清
 * 「没有这个信息」与「这个信息为空」。
 */
function ValueRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string | null;
  copyLabel?: string;
}) {
  const { t } = useTranslation();

  return (
    <div data-slot="environment-row" className="flex min-w-0 items-center gap-2 py-0.5">
      <dt className="text-ink-4 w-16 shrink-0 text-[11.5px]">{label}</dt>
      <dd
        className={cn(
          typePackage,
          "min-w-0 flex-1 truncate",
          value === null ? "text-ink-4" : "text-ink-2",
        )}
        // 路径可能很长：完整值留在 title 里，行内只留能看清的一段
        title={value ?? undefined}
        dir="ltr"
      >
        {value ?? t("sessionPanel.unset")}
      </dd>
      {value !== null && copyLabel !== undefined && (
        <CopyValueButton value={value} label={copyLabel} />
      )}
    </div>
  );
}
