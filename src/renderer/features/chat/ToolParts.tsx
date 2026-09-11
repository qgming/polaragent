"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import {
  FileTextIcon,
  type LucideIcon,
  PenLineIcon,
  SquarePenIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeDiff } from "@/renderer/components/assistant-ui/elements/code-diff";
import { TerminalBlock } from "@/renderer/components/assistant-ui/elements/terminal-block";
import { ToolCall } from "@/renderer/components/assistant-ui/elements/tool-call";
import { ToolFallback } from "@/renderer/components/assistant-ui/elements/tool-fallback.aui";
import {
  type TimelineStep,
  ToolTimeline,
} from "@/renderer/components/assistant-ui/elements/tool-timeline";
import {
  bashCommand,
  bashOutput,
  type EditDiff,
  resolveToolDetail,
  type ToolDetail,
  type ToolRow,
  toolChip,
  toolResultText,
  toolRows,
} from "./tool-presentation";

/** 工具名 → 图标；本应用只暴露 bash/read/write/edit 四个原生工具，未登记的一律用终端图标 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: TerminalIcon,
  read: FileTextIcon,
  write: SquarePenIcon,
  edit: PenLineIcon,
};

const DEFAULT_ICON = TerminalIcon;

/** 工具名 → 词条键（收尾态 / 进行态）；未登记的工具落到通用「调用」 */
const TOOL_LABELS: Record<string, { resting: string; active: string }> = {
  bash: { resting: "tools.bash", active: "tools.bashActive" },
  read: { resting: "tools.read", active: "tools.readActive" },
  write: { resting: "tools.write", active: "tools.writeActive" },
  edit: { resting: "tools.edit", active: "tools.editActive" },
};

const FALLBACK_LABELS = { resting: "tools.call", active: "tools.callActive" };

/** bash 的详情：命令作标题、末尾输出作正文、运行中转圈、完成打勾 */
function TerminalDetail({
  args,
  result,
  running,
}: {
  args: unknown;
  result: unknown;
  running: boolean;
}) {
  const { t } = useTranslation();
  const { lines, omitted } = useMemo(() => bashOutput(result), [result]);
  const shown = useMemo(
    () => (omitted > 0 ? [t("tools.bashLinesOmitted", { count: omitted }), ...lines] : lines),
    [lines, omitted, t],
  );

  return (
    <TerminalBlock
      command={bashCommand(args)}
      lines={shown}
      visibleCount={shown.length}
      done={!running}
    />
  );
}

/** edit 的详情：文件名 + 增减行数 + 逐行 diff */
function DiffDetail({ diff }: { diff: EditDiff }) {
  const { t } = useTranslation();
  const lines = useMemo(
    () =>
      diff.omitted > 0
        ? [
            ...diff.lines,
            {
              kind: "context" as const,
              text: t("tools.diffLinesOmitted", { count: diff.omitted }),
            },
          ]
        : diff.lines,
    [diff, t],
  );

  return (
    <CodeDiff
      filename={diff.filename}
      additions={diff.additions}
      deletions={diff.deletions}
      lines={lines}
      cycle={0}
    />
  );
}

/** 已解析的详情 → 具体组件 */
function ResolvedDetail({
  detail,
  args,
  result,
  running,
}: {
  detail: ToolDetail;
  args: unknown;
  result: unknown;
  running: boolean;
}) {
  if (detail.kind === "diff") return <DiffDetail diff={detail.diff} />;
  return <TerminalDetail args={args} result={result} running={running} />;
}

/** 从 part 字段解析并渲染详情；没有更贴的组件时返回 null（调用侧据此决定是否让出内置面板） */
function PartDetail({
  toolName,
  args,
  result,
  details,
  isError,
  running,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  details: unknown;
  isError: boolean;
  running: boolean;
}) {
  const detail = useMemo(
    () => resolveToolDetail(toolName, details, isError),
    [toolName, details, isError],
  );
  if (detail === null) return null;
  return <ResolvedDetail detail={detail} args={args} result={result} running={running} />;
}

/**
 * 时间线里某一步的详情。
 *
 * 订阅以展开状态为闸门：未展开时选择器恒返回 undefined，流式期间既不重渲染也不读 part。
 * bash 输出上限 256KB，若每一步都无条件订阅，一次工具输出之后的每个 token 都会把整段输出再读一遍。
 */
function StepDetail({ index, open }: { index: number; open: boolean }) {
  const part = useAuiState((s) => (open ? s.message.parts[index] : undefined));
  if (!open || part === undefined || part.type !== "tool-call") return null;

  return (
    <PartDetail
      toolName={part.toolName}
      args={part.args}
      result={part.result}
      details={part.artifact}
      isError={part.isError === true}
      running={part.status.type === "running"}
    />
  );
}

/**
 * 单个工具调用。折叠行始终是官方 ToolCall，rich 组件只作为它的 `detail` 出现在展开的面板里：
 *
 * - 失败 → 整行走 ToolFallback（ToolCall 的收尾标记只有绿勾，报错会被读成成功）
 * - edit 有可解析的 patch → detail 用 CodeDiff
 * - bash → detail 用 TerminalBlock
 * - 其余（read / write / 未知）→ 不给 detail，保留内置的 Request/Result 文本面板
 *
 * edit 的补丁走 assistant-ui 的 `artifact` 槽位（见 message-converter 的映射）。
 */
export const ToolCallPart: ToolCallMessagePartComponent = (props) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const isError = props.isError === true;
  const detail = useMemo(
    () => resolveToolDetail(props.toolName, props.artifact, isError),
    [props.toolName, props.artifact, isError],
  );

  if (isError) return <ToolFallback {...props} />;

  const labels = TOOL_LABELS[props.toolName] ?? FALLBACK_LABELS;
  return (
    <ToolCall
      label={t(labels.resting)}
      activeLabel={t(labels.active)}
      query={toolChip(props.args)}
      request={props.argsText}
      result={toolResultText(props.result)}
      running={props.status.type === "running"}
      open={open}
      onOpenChange={setOpen}
      detail={
        detail === null ? undefined : (
          <ResolvedDetail
            detail={detail}
            args={props.args}
            result={props.result}
            running={props.status.type === "running"}
          />
        )
      }
    />
  );
};

/**
 * 一次运行里连续的工具调用。
 *
 * 多步且全部成功时收成官方 ToolTimeline 的一条轨迹；单步、或其中一步失败时逐条展开——
 * 一个调用多包一层折叠没有信息量，而失败不该被藏进折叠行里。
 * 成组时每步仍各自可展开，展开的是该步自己的 rich 详情。
 */
export function ToolRunGroup({
  indices,
  children,
}: {
  indices: readonly number[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 汇总快照走 JSON 字符串：原始值，useAuiState 的 Object.is 才比得准（选数组字段每次都是新引用）。
  // 它按 token 重算，所以刻意不含 result —— 大块文本不能进这个快照，
  // 各步的输出由 StepDetail 在展开时才去读。
  const signature = useAuiState((s) => JSON.stringify(toolRows(s.message.parts, indices)));
  const streaming = useAuiState((s) => s.message.status?.type === "running");
  const rows = useMemo(() => JSON.parse(signature) as ToolRow[], [signature]);
  if (rows.length < 2 || rows.some((row) => row.failed)) {
    return <div className="flex flex-col gap-1.5">{children}</div>;
  }

  const steps: TimelineStep[] = rows.map((row) => ({
    verb: t((TOOL_LABELS[row.name] ?? FALLBACK_LABELS).resting),
    chip: row.chip,
    icon: TOOL_ICONS[row.name] ?? DEFAULT_ICON,
    detail: (stepOpen: boolean) => <StepDetail index={row.partIndex} open={stepOpen} />,
  }));

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={streaming}
      open={open}
      onOpenChange={setOpen}
      restingLabel={t("tools.groupCount", { count: steps.length })}
      activeLabel={t("tools.groupActive")}
      stats={[]}
    />
  );
}
