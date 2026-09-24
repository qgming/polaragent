"use client";

/**
 * 数据统计面板：概览 → 活动热力图 → 每日趋势 → 模型用量。
 *
 * 四块从上往下依次回答四个问题：**一共用了多少 / 什么时候在用 / 最近几天怎么变的 /
 * 花在哪个模型上**。顺序不是随意的：先给总量与峰值这类「一句话总结」，
 * 再给需要动手读的图。
 *
 * 数据只有一条来源（`stats-store`），报告自带全部有记录的日子 ——
 * 所以切换口径（每日/每周/累计）与时间范围（近 7 / 30 日）都是**本地切片**，
 * 不重新请求：切一次闪一次的图表比慢一点的图表更让人怀疑数据。
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { typeSection } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Segmented } from "@/renderer/features/settings/settings-shared";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { useStatsStore } from "@/renderer/stores/stats-store";
import { HeatGraph, HeatLegend } from "../charts/heat-graph";
import { type DonutSlice, ModelUsageDonut } from "../charts/model-donut";
import { TokenTrendChart } from "../charts/token-trend-chart";
import {
  formatDayLabel,
  formatDuration,
  formatFullDate,
  formatMonthLabel,
  formatPercent,
  formatTokens,
  localeOf,
} from "../format";
import {
  type HeatMode,
  heatCells,
  modelLabel,
  modelLegendRows,
  OTHER_MODELS_KEY,
  rangeDates,
  seriesColorAt,
  trendSeries,
} from "../series";

/** 时间范围：近 7 日 / 近 30 日（参考界面的两档） */
type TrendRange = "7" | "30";
/** 趋势图最多画几条线（第 5 个色槽留给图例里的「其他」） */
const TREND_SERIES_LIMIT = 4;
/** 卡片外观：比背景略深的一层 + 细边。四处统一用它，避免每块自己调一遍灰度 */
const card =
  "rounded-xl border border-border/60 bg-foreground/[0.02] p-4 dark:bg-foreground/[0.03]";

export function StatsPanel() {
  const { t, i18n } = useTranslation();
  const language = localeOf(i18n.language);

  const report = useStatsStore((state) => state.report);
  const error = useStatsStore((state) => state.error);
  const load = useStatsStore((state) => state.load);
  const services = useSettingsStore((state) => state.settings?.services);

  const [heatMode, setHeatMode] = useState<HeatMode>("daily");
  const [range, setRange] = useState<TrendRange>("7");

  /**
   * 模型键 → 显示名。
   *
   * 优先用设置里那条模型配置的名字（用户自己起的，或者从目录匹配来的）；
   * 服务或模型已经被删掉时回落到模型 id —— 统计里仍留着历史用过的模型，
   * 它们不该因为一次清理配置就变成问号。
   */
  const labelOf = useCallback(
    (key: string): string => {
      if (key === OTHER_MODELS_KEY) return t("stats.otherModels");
      return modelLabel(key, (serviceId, modelId) => {
        const service = services?.find((entry) => entry.id === serviceId);
        const model = service?.models.find((entry) => entry.id === modelId);
        const name = model?.name?.trim();
        return name === undefined || name === "" ? null : name;
      });
    },
    [services, t],
  );

  const cells = useMemo(
    () => heatCells(report?.days ?? [], heatMode, report?.today ?? ""),
    [report?.days, report?.today, heatMode],
  );

  const trendDates = useMemo(
    () => rangeDates(report?.today ?? "", Number(range)),
    [report?.today, range],
  );

  const legend = useMemo(
    () => modelLegendRows(report?.models ?? [], TREND_SERIES_LIMIT),
    [report?.models],
  );

  const trend = useMemo(
    () =>
      trendSeries(
        report?.days ?? [],
        trendDates,
        legend.filter((row) => row.key !== OTHER_MODELS_KEY).map((row) => row.key),
      ),
    [report?.days, trendDates, legend],
  );

  const donutSlices = useMemo<DonutSlice[]>(
    () =>
      legend.map((row) => ({
        key: row.key,
        label: labelOf(row.key),
        tokens: row.tokens,
        share: row.share,
        colorIndex: row.colorIndex,
      })),
    [legend, labelOf],
  );

  if (error !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 py-10">
        <p className="text-[13px] text-ink-3">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (report === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-10">
        <p className="text-[13px] text-ink-3">{t("stats.loading")}</p>
      </div>
    );
  }

  const hasAnyData = report.totalTokens > 0;
  const hasTrendData = trend.some((entry) => entry.points.some((value) => value > 0));

  return (
    <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
      {/* ── 概览：五个读数 ───────────────────────────────────────────────── */}
      <div
        data-slot="stats-summary"
        className={cn(card, "grid grid-cols-2 gap-y-4 sm:grid-cols-5 sm:gap-y-0")}
      >
        <StatCell
          value={formatTokens(report.totalTokens, language)}
          label={t("stats.totalTokens")}
        />
        <StatCell
          value={formatTokens(report.peak.tokens, language)}
          label={t("stats.peakTokens")}
        />
        <StatCell
          value={formatDuration(report.longestSession.ms, t)}
          label={t("stats.longestChat")}
        />
        <StatCell
          value={t("stats.days", { count: report.streak.current })}
          label={t("stats.currentStreak")}
        />
        <StatCell
          value={t("stats.days", { count: report.streak.longest })}
          label={t("stats.longestStreak")}
        />
      </div>

      {/* ── Token 活动：年度热力图 ───────────────────────────────────────── */}
      <section data-slot="stats-activity" className={cn(card, "mt-4")}>
        <div className="flex items-center justify-between gap-3">
          <h3 className={cn(typeSection, "text-[15px] text-foreground")}>
            {t("stats.tokenActivity")}
          </h3>
          <Segmented<HeatMode>
            ariaLabel={t("stats.tokenActivity")}
            value={heatMode}
            onChange={setHeatMode}
            options={[
              { value: "daily", label: t("stats.modeDaily") },
              { value: "weekly", label: t("stats.modeWeekly") },
              { value: "cumulative", label: t("stats.modeCumulative") },
            ]}
          />
        </div>

        <div className="mt-3.5 overflow-x-auto">
          <HeatGraph
            cells={cells}
            today={report.today}
            summary={t("stats.heatSummary", {
              days: report.activeDays,
              total: formatTokens(report.totalTokens, language),
            })}
            renderTooltip={(date, value) =>
              t("stats.heatCell", {
                tokens: formatTokens(value, language),
                date: formatFullDate(date, language),
              })
            }
            renderMonth={(date) => formatMonthLabel(date, language)}
          />
        </div>

        <div className="mt-2 flex justify-end">
          <HeatLegend less={t("stats.heatLess")} more={t("stats.heatMore")} />
        </div>
      </section>

      {/* ── 每日趋势：按模型拆线 ─────────────────────────────────────────── */}
      <section data-slot="stats-trend" className={cn(card, "mt-4")}>
        <div className="flex items-center justify-between gap-3">
          <h3 className={cn(typeSection, "text-[15px] text-foreground")}>
            {t("stats.dailyTrend")}
          </h3>
          <Segmented<TrendRange>
            ariaLabel={t("stats.dailyTrend")}
            value={range}
            onChange={setRange}
            options={[
              { value: "7", label: t("stats.range7") },
              { value: "30", label: t("stats.range30") },
            ]}
          />
        </div>

        {/* 图例：与折线同色的圆点 + 模型名。画 4 条线、第 5 个色槽给「其他」 */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {legend.map((row) => (
            <span key={row.key} className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", seriesColorAt(row.colorIndex).dot)}
              />
              <span className="text-ink-2 max-w-40 truncate" title={labelOf(row.key)}>
                {labelOf(row.key)}
              </span>
            </span>
          ))}
        </div>

        <div className="mt-2">
          {hasTrendData ? (
            <TokenTrendChart
              dates={trendDates}
              series={trend.map((entry) => ({
                key: entry.key,
                label: labelOf(entry.key),
                points: entry.points,
                colorIndex: entry.colorIndex,
              }))}
              renderValue={(value) => formatTokens(value, language)}
              renderDate={(date) => formatDayLabel(date, language)}
              emptyLabel={t("stats.emptyTrend")}
            />
          ) : (
            <p className="py-10 text-center text-[13px] text-ink-4">{t("stats.emptyTrend")}</p>
          )}
        </div>
      </section>

      {/* ── 模型用量：环图 + 明细 ────────────────────────────────────────── */}
      <section data-slot="stats-models" className={cn(card, "mt-4")}>
        <h3 className={cn(typeSection, "text-[15px] text-foreground")}>{t("stats.modelUsage")}</h3>
        <div className="mt-3">
          {hasAnyData ? (
            <ModelUsageDonut
              slices={donutSlices}
              totalLabel={formatTokens(report.totalTokens, language)}
              totalCaption={t("stats.tokensUnit")}
              /*
                明细行也用概略量级（万 / 亿，英文那边 K / M / B）而不是逐位数字：
                图例是拿来看比例的，`124,000,000` 这种九位数反而要数位才读得出大小。
                与卡片、环心、悬浮提示同一套读数，四处不会出现两种写法。
              */
              renderTokens={(tokens) =>
                `${formatTokens(tokens, language)} ${t("stats.tokensUnit")}`
              }
              renderShare={(share) => formatPercent(share, language)}
              summary={t("stats.donutSummary")}
              colorOf={seriesColorAt}
            />
          ) : (
            <p className="py-10 text-center text-[13px] text-ink-4">{t("stats.empty")}</p>
          )}
        </div>
      </section>

      {/*
        口径与进度：统计最容易被误读的就是「这个数字是怎么来的」。
        这里给出会话数、种类拆分、活跃天数与生成时刻；历史还在折叠时一并说明进度。
      */}
      <p
        data-slot="stats-scope"
        className="text-ink-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
      >
        <span>{t("stats.scopeSessions", { count: report.sessions.total })}</span>
        {report.sessions.subagent.sessions > 0 && (
          <span>
            {t("stats.scopeSubagent", {
              count: report.sessions.subagent.sessions,
              tokens: formatTokens(report.sessions.subagent.tokens, language),
            })}
          </span>
        )}
        <span>{t("stats.scopeActiveDays", { count: report.activeDays })}</span>
        {report.scanning.active && (
          <span className="text-ink-3">
            {t("stats.scanning", {
              done: report.scanning.scanned,
              total: report.scanning.total,
            })}
          </span>
        )}
        <span className="ms-auto">
          {t("stats.cacheRead", {
            tokens: formatTokens(report.totals.cacheReadTokens, language),
          })}
        </span>
      </p>
    </div>
  );
}

/**
 * 一个读数：数值在上、标签在下，**没有第三行**。
 *
 * 曾经有过一行副读数（「含缓存读取与写入」「峰值出现在哪天」「最长那次是哪个会话」），
 * 用户要求去掉：这一排是「一眼扫过去」的读数，多一行小字会让每个数字都要多看半秒；
 * 而那三条信息在下面各自那张图/表里本来就有（口径在页脚、峰值在热力图、最长会话在会话列表）。
 */
function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center px-2 text-center sm:border-border/50 sm:not-first:border-s">
      <span className="text-[17px] leading-6 font-medium tabular-nums">{value}</span>
      <span className="text-ink-4 mt-1 text-[11px]">{label}</span>
    </div>
  );
}
