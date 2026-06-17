// 目标编辑模态窗
// src/components/goal/GoalEditModal.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGoalStore } from "@/stores/goal-store";
import { appendGoalConfig, appendGoalEvent } from "@/lib/session/goal";
import {
  DEFAULT_GOAL_MAX_TURNS,
  type GoalConfig,
  type GoalState,
} from "@/lib/goal/types";

export function GoalEditModal({
  isOpen,
  onClose,
  threadId,
  initialGoal,
}: {
  isOpen: boolean;
  onClose: () => void;
  threadId: string;
  initialGoal?: GoalState;
}) {
  const { t } = useTranslation("common");
  const setGoal = useGoalStore((s) => s.setGoal);
  const [goalText, setGoalText] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [maxTurns, setMaxTurns] = useState(String(DEFAULT_GOAL_MAX_TURNS));
  const [maxTokens, setMaxTokens] = useState("");
  const [maxRuntimeMinutes, setMaxRuntimeMinutes] = useState("");

  // 同步初始值
  useEffect(() => {
    if (isOpen) {
      setGoalText(initialGoal?.goalText ?? "");
      setSuccessCriteria(initialGoal?.successCriteria ?? "");
      setConstraints(initialGoal?.constraints ?? "");
      setMaxTurns(String(initialGoal?.maxTurns ?? DEFAULT_GOAL_MAX_TURNS));
      setMaxTokens(initialGoal?.maxTokens ? String(initialGoal.maxTokens) : "");
      setMaxRuntimeMinutes(
        initialGoal?.maxRuntimeMinutes
          ? String(initialGoal.maxRuntimeMinutes)
          : "",
      );
    }
  }, [isOpen, initialGoal]);

  const handleSave = () => {
    const text = goalText.trim();
    if (!text) return;

    const config: GoalConfig = {
      goalText: text,
      successCriteria: successCriteria.trim() || undefined,
      constraints: constraints.trim() || undefined,
      maxTurns: parsePositiveInteger(maxTurns, DEFAULT_GOAL_MAX_TURNS),
      maxTokens: parsePositiveInteger(maxTokens),
      maxRuntimeMinutes: parsePositiveInteger(maxRuntimeMinutes),
    };

    setGoal(threadId, config);
    void appendGoalConfig(threadId, config);
    void appendGoalEvent(threadId, {
      type: "goal_set",
      status: "ready",
      timestamp: Date.now(),
    });

    onClose();
  };

  const handleCancel = () => {
    setGoalText(initialGoal?.goalText ?? "");
    setSuccessCriteria(initialGoal?.successCriteria ?? "");
    setConstraints(initialGoal?.constraints ?? "");
    setMaxTurns(String(initialGoal?.maxTurns ?? DEFAULT_GOAL_MAX_TURNS));
    setMaxTokens(initialGoal?.maxTokens ? String(initialGoal.maxTokens) : "");
    setMaxRuntimeMinutes(
      initialGoal?.maxRuntimeMinutes
        ? String(initialGoal.maxRuntimeMinutes)
        : "",
    );
    onClose();
  };

  if (!isOpen) return null;

  const isCreating = !initialGoal;

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 z-50 bg-black/50"
        onClick={handleCancel}
      />

      {/* 模态窗 */}
      <div className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg">
        {/* 标题栏 */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
	            {isCreating ? t("goal.createTitle") : t("goal.editTitle")}
          </h2>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 目标内容输入 */}
        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-foreground">
	            {t("goal.goalText")}
          </label>
          <textarea
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
	            placeholder={t("goal.goalTextPlaceholder")}
            rows={6}
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-foreground">
	            {t("goal.successCriteria")}
          </label>
          <textarea
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
	            placeholder={t("goal.successCriteriaPlaceholder")}
            rows={3}
            value={successCriteria}
            onChange={(e) => setSuccessCriteria(e.target.value)}
          />
        </div>

        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-foreground">
	            {t("goal.constraints")}
          </label>
          <textarea
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
	            placeholder={t("goal.constraintsPlaceholder")}
            rows={3}
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
          />
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <label className="block text-sm font-medium text-foreground">
	            {t("goal.maxTurns")}
            <input
              className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              inputMode="numeric"
              min={1}
              placeholder="20"
              type="number"
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium text-foreground">
	            {t("goal.tokenBudget")}
            <input
              className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              inputMode="numeric"
              min={1}
	              placeholder={t("goal.unlimited")}
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium text-foreground">
	            {t("goal.minuteBudget")}
            <input
              className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              inputMode="numeric"
              min={1}
	              placeholder={t("goal.unlimited")}
              type="number"
              value={maxRuntimeMinutes}
              onChange={(e) => setMaxRuntimeMinutes(e.target.value)}
            />
          </label>
        </div>

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-4 text-sm"
            onClick={handleCancel}
          >
	            {t("cancel")}
          </Button>
          <Button
            size="sm"
            className="h-8 px-4 text-sm"
            onClick={handleSave}
            disabled={!goalText.trim()}
          >
	            {isCreating ? t("goal.create") : t("save")}
          </Button>
        </div>
      </div>
    </>
  );
}

function parsePositiveInteger(
  value: string,
  fallback?: number,
): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
