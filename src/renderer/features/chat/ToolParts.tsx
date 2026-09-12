"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import {
  FileSearchIcon,
  FileTextIcon,
  ListTodoIcon,
  type LucideIcon,
  PenLineIcon,
  SquarePenIcon,
  TerminalIcon,
  TextSearchIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeDiff } from "@/renderer/components/assistant-ui/elements/code-diff";
import { paper } from "@/renderer/components/assistant-ui/elements/surfaces";
import { TerminalBlock } from "@/renderer/components/assistant-ui/elements/terminal-block";
import { type TodoItem, TodoList } from "@/renderer/components/assistant-ui/elements/todo-list";
import { ToolCall } from "@/renderer/components/assistant-ui/elements/tool-call";
import {
  type TimelineStep,
  ToolTimeline,
} from "@/renderer/components/assistant-ui/elements/tool-timeline";
import { cn } from "@/renderer/lib/utils";
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

/** 工具名 → 图标；未登记的一律用终端图标 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: TerminalIcon,
  read: FileTextIcon,
  write: SquarePenIcon,
  edit: PenLineIcon,
  grep: TextSearchIcon,
  glob: FileSearchIcon,
  todo: ListTodoIcon,
};

const DEFAULT_ICON = TerminalIcon;

/** 工具名 → 词条键（收尾态 / 进行态）；未登记的工具落到通用「调用」 */
const TOOL_LABELS: Record<string, { resting: string; active: string }> = {
  bash: { resting: "tools.bash", active: "tools.bashActive" },
  read: { resting: "tools.read", active: "tools.readActive" },
  write: { resting: "tools.write", active: "tools.writeActive" },
  edit: { resting: "tools.edit", active: "tools.editActive" },
  grep: { resting: "tools.grep", active: "tools.grepActive" },
  glob: { resting: "tools.glob", active: "tools.globActive" },
  todo: { resting: "tools.todo", active: "tools.todoActive" },
};

const FALLBACK_LABELS = { resting: "tools.call", active: "tools.callActive" };

/** 工具进行态的词条键；未登记的工具落到通用「调用」。给消息尾部的运行指示器复用 */
export function toolActiveLabelKey(toolName: string): string {
  return (TOOL_LABELS[toolName] ?? FALLBACK_LABELS).active;
}

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

/** todo 清单：与 TerminalBlock / CodeDiff 一样自带 paper 面与圆角，工具流里各详情外观保持一致 */
function TodoDetail({ items, revision }: { items: TodoItem[]; revision?: number }) {
  const { t } = useTranslation();
  return (
    <div className={cn(paper, "w-full overflow-hidden rounded-2xl p-3")}>
      <TodoList items={items} revision={revision} title={t("chat.todos")} />
    </div>
  );
}

/** 已解析的详情 → 具体组件（TodoList 的 prop 叫 items，映射已在纯逻辑层做完） */
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
  if (detail.kind === "todo") {
    return <TodoDetail items={detail.items} revision={detail.revision} />;
  }
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
    () => resolveToolDetail(toolName, details, isError, args),
    [toolName, details, isError, args],
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
 * 单个工具调用：折叠行**统一**走官方 ToolCall，成功与失败的差别只体现在它的收尾标记与行色上
 * （`isError` → 红叉 + 整行转红）。rich 组件只作为它的 `detail` 出现在展开的面板里：
 *
 * - edit 有可解析的 patch → detail 用 CodeDiff
 * - bash → detail 用 TerminalBlock
 * - todo 有清单 → detail 用 TodoList（details 未到时用工具参数里的清单兜底）
 * - 失败、以及其余（read / write / grep / glob / 未知）→ 不给 detail，保留内置的
 *   Request/Result 文本面板 —— 工具的错误文案本来就在 result 里，展开就能看到
 *
 * 之前失败态是整行走 vendored ToolFallback：它的标记由 part 的 status 决定，而 aui 的 status
 * 只表达「跑没跑完」，于是失败也会渲染成绿勾 —— 读起来就是成功。失败标记现在由 ToolCall 的
 * isError 承担，不依赖 aui 的状态推导。
 *
 * edit 的补丁与 todo 的清单都走 assistant-ui 的 `artifact` 槽位（见 message-converter 的映射）。
 */
export const ToolCallPart: ToolCallMessagePartComponent = (props) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const isError = props.isError === true;
  const detail = useMemo(
    () => resolveToolDetail(props.toolName, props.artifact, isError, props.args),
    [props.toolName, props.artifact, isError, props.args],
  );

  const labels = TOOL_LABELS[props.toolName] ?? FALLBACK_LABELS;
  return (
    <ToolCall
      label={t(labels.resting)}
      activeLabel={t(labels.active)}
      query={toolChip(props.args)}
      request={props.argsText}
      result={toolResultText(props.result)}
      running={props.status.type === "running"}
      isError={isError}
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
    // 直接给 children：父容器是 flex + gap，包一层 flex 会再叠一道 gap
    return <>{children}</>;
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
