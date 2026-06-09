// 对话流执行块组件
//
// 复刻 QoderWork 的执行轨迹展示：
//   - StepTrace：「查看 N 个步骤」可折叠的工具调用轨迹
//   - ThinkingBlock：「深度思考」可折叠的推理过程
//   - TaskDoneMark：「任务已完成」绿色标记

import { useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronRight,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Loader2,
  MessageCircleDashed,
  XCircle,
  Brain,
  Wrench,
} from "lucide-react";

import { AudioBar } from "@/components/chat/AudioBar";
import { cn } from "@/lib/utils";
import type { StepItem } from "@/stores/task-monitor-store";
import type { Segment } from "@/stores/chat-store";

// 工具步骤轨迹：默认折叠，标题显示步骤数
export function StepTrace({ steps }: { steps: StepItem[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 py-0.2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wrench className="size-4 shrink-0" />
        <span>查看 {steps.length} 个步骤</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 space-y-1 border-l border-border py-1 pl-3">
          {steps.map((step) => (
            <div
              key={step.id}
              className="flex items-center gap-2 py-0.5 text-sm"
            >
              <StepIcon status={step.status} />
              <span
                className={cn(
                  step.status === "error"
                    ? "text-destructive"
                    : "text-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StepIcon({ status }: { status: StepItem["status"] }) {
  if (status === "running") {
    return <Loader2 className="size-4 shrink-0 animate-spin text-[#9b6fe0]" />;
  }
  if (status === "error") {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  return <CheckCircle2 className="size-4 shrink-0 text-[#9b6fe0]" />;
}

// 深度思考块：折叠的灰色推理文本
export function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  if (!content.trim()) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="size-4 shrink-0" />
        <span>深度思考</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 border-l border-border pl-3 text-sm italic leading-6 text-muted-foreground">
          {content}
        </div>
      ) : null}
    </div>
  );
}

// 任务完成标记
export function TaskDoneMark({ summary }: { summary: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[#5b3a9e]">
      <CircleDot className="size-4" />
      <span className="font-medium">任务已完成</span>
      <span className="text-muted-foreground">{summary}</span>
    </div>
  );
}

// segment 中工具段的状态图标
function ToolStatusIcon({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") {
    return <Loader2 className="size-4 shrink-0 animate-spin text-[#9b6fe0]" />;
  }
  if (status === "error") {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  return <CheckCircle2 className="size-4 shrink-0 text-[#9b6fe0]" />;
}

export type ToolSeg = Extract<Segment, { kind: "tool" }>;

// 单个「深度思考」可折叠行
export function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="size-4 shrink-0" />
        <span>深度思考</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 border-l border-border pl-3 text-sm italic leading-6 text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  );
}

// 运行中用户插入的引导已被 agent 当前循环接收。
export function GuidanceRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <MessageCircleDashed className="size-4 shrink-0" />
        <span>对话已引导</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 border-l border-border pl-3 text-sm leading-6 text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  );
}

// 单个工具步骤项：有结果文本时可点击展开查看（限高、内部滚动）
export function ToolStepItem({ tool }: { tool: ToolSeg }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(tool.resultText && tool.resultText.trim());

  // 检查是否是 speech_synthesis 工具，且有 audioPath
  const isSpeechSynthesis = tool.toolName === "speech_synthesis";
  const audioDetails = (tool as any).details; // details 是 any 类型，运行时从工具返回值获取
  const audioPath = audioDetails?.audioPath;
  const audioDuration = audioDetails?.duration;

  return (
    <div className="text-sm">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          // 文字与右侧箭头颜色与「深度思考」一致：默认 muted、hover 变 foreground、整行继承
          "group flex w-full items-center gap-2 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        {/* 左侧状态图标保留颜色区分（紫色/错误红） */}
        <ToolStatusIcon status={tool.status} />
        <span
          className={cn(
            // 仅错误态保留独立红色；正常态跟随整行文字色（muted→hover foreground）
            tool.status === "error" && "text-destructive",
          )}
        >
          {tool.label}
        </span>
        {expandable ? (
          <ChevronRight
            className={cn(
              "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        ) : null}
      </button>
      {/* 语音合成工具：直接显示音频条（微信风格） */}
      {isSpeechSynthesis && audioPath && tool.status === "done" ? (
        <div className="ml-6 mt-2">
          <AudioBar audioPath={audioPath} duration={audioDuration} variant="assistant" />
        </div>
      ) : null}
      {expandable && open ? (
        <pre className="app-scrollbar mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
          {tool.resultText}
        </pre>
      ) : null}
    </div>
  );
}

// 连续的工具段聚合为「查看 N 个步骤」可折叠行
export function ToolStepsRow({ tools }: { tools: ToolSeg[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wrench className="size-4 shrink-0" />
        <span>查看 {tools.length} 个步骤</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 space-y-1 border-l border-border py-1 pl-3">
          {tools.map((tool) => (
            <ToolStepItem key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type TaskStatus = "pending" | "in_progress" | "completed";

// 任务折叠头部图标：固定用 ClipboardList 单色，跟随按钮文字颜色，
// 与深度思考(Brain)/工具(Wrench)折叠的图标风格一致。
function TaskGroupIcon() {
  return <ClipboardList className="size-4 shrink-0" />;
}

// 任务折叠块：按 update_todos 的某条待办分组，外层可折叠，
// 内部内容（思考行 / 平铺工具步骤 / 正文）由调用方组装为 children 传入。
// 形态与「深度思考 / 查看 N 个步骤」一致：一行（状态图标 + 标题 + hover 箭头），
// 不用卡片背景；展开内容用 ml-6 border-l 左缩进。
// 默认展开规则：已完成的收起，进行中/待开始的展开。
export function TaskGroup({
  title,
  status,
  defaultOpen,
  children,
}: {
  title: string;
  status: TaskStatus;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? status !== "completed");

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <TaskGroupIcon />
        <span>{title}</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 space-y-1 border-l border-border py-1 pl-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}
