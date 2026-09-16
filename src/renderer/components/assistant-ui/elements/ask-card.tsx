"use client";

import { ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { type ComponentProps, type FormEvent, useState } from "react";
import { Button } from "@/renderer/components/ui/button";
import { Input } from "@/renderer/components/ui/input";
import { cn } from "@/renderer/lib/utils";
import type { AskAnswerItem, AskQuestion } from "@/shared/contracts/interaction";
import { field, inkButton, paper } from "./surfaces";

/** 卡片文案：调用方传本地化文案，缺省回落英文（元素单独使用时也立得住） */
export interface AskCardLabels {
  /** 卡片标题 */
  title?: string;
  /** 「模型正在等待你的回答」那一行 */
  waiting?: string;
  /** 每题自由输入框的占位符 */
  placeholder?: string;
  /** 多选题的提示 */
  multiSelect?: string;
  /** 「第 x / y 题」；交给调用方做本地化与插值 */
  progressOf?: (current: number, total: number) => string;
  /** 非最后一题的主按钮：进入下一题 */
  next?: string;
  /** 回到上一题 */
  back?: string;
  /** 最后一题的主按钮：提交全部回答 */
  submit?: string;
  /** 已提交：父组件把请求移出列表前的一瞬间显示，也防住重复提交 */
  submitted?: string;
  /** 未留任何作答时，提示这一题可以跳过 */
  skipHint?: string;
}

const DEFAULT_LABELS: Required<AskCardLabels> = {
  title: "Your answer is needed",
  waiting: "The model is waiting for your answer",
  placeholder: "Or type an answer…",
  multiSelect: "Select any",
  progressOf: (current, total) => `Question ${current} of ${total}`,
  next: "Next",
  back: "Back",
  submit: "Submit answers",
  submitted: "Submitted",
  skipHint: "You can leave this one blank and go on",
};

/** 单题的作答草稿：勾选的选项 + 自由输入，两者可以并存 */
interface AnswerDraft {
  selected: string[];
  text: string;
}

function emptyDrafts(questions: readonly AskQuestion[]): Record<string, AnswerDraft> {
  return Object.fromEntries(
    questions.map((question) => [question.id, { selected: [], text: "" } satisfies AnswerDraft]),
  );
}

/** 选项字母：A、B、C …… 超过 26 个（不该出现）就回落到序号，别去拼不可见字符 */
function optionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function isAnswered(draft: AnswerDraft | undefined): boolean {
  return draft !== undefined && (draft.selected.length > 0 || draft.text.trim() !== "");
}

/**
 * 草稿 → 契约的回答项：每题都给一条（没作答的空数组），自由输入去掉首尾空白，
 * 空串视为「没写」而不回传。
 */
function toAnswers(
  questions: readonly AskQuestion[],
  drafts: Record<string, AnswerDraft>,
): AskAnswerItem[] {
  return questions.map((question) => {
    const draft = drafts[question.id] ?? { selected: [], text: "" };
    const text = draft.text.trim();
    return text === ""
      ? { questionId: question.id, selected: draft.selected }
      : { questionId: question.id, selected: draft.selected, text };
  });
}

/**
 * 提问卡：**一次只显示一题**（步进式）。
 *
 * 为什么改成分步：一次摊开三四题时，用户会先扫一遍再决定怎么答，答到一半还容易漏掉
 * 中间那题；分步把「当前这题」放到视觉焦点上，同时用上一题/下一题提供回头修改的路径。
 *
 * 交互约定：
 * - 选项带字母前缀（A、B、C、D……），点击即选中；多选可叠加，单选再点一次取消；
 * - 每题**始终**有一个自由输入框（「其他」这类约定由界面兜住，不交给模型写进 options）；
 * - 上一题在首题禁用；非最后一题的主按钮是「下一题」，最后一题是「提交回答」；
 * - 回车 = 主按钮（非最后一题进入下一题，最后一题提交）——卡片是一个 form，
 *   所以「回车提交」这条链对原生表单也成立；
 * - 作答草稿在步进之间保留，回头改过的答案以最后一次为准。
 *
 * 作答状态由卡片自己持有；父级（AskSection）在提交后把请求从 store 里移走，卡片随即卸载。
 */
export function AskCard({
  questions,
  labels,
  className,
  onSubmit,
  ...props
}: Omit<ComponentProps<"form">, "children" | "onSubmit"> & {
  questions: AskQuestion[];
  labels?: AskCardLabels;
  onSubmit?: (answers: AskAnswerItem[]) => void;
}) {
  const text = { ...DEFAULT_LABELS, ...labels };
  const [drafts, setDrafts] = useState(() => emptyDrafts(questions));
  const [index, setIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  const total = questions.length;
  const current = questions[Math.min(index, Math.max(total - 1, 0))];
  const answeredAny = questions.some((question) => isAnswered(drafts[question.id]));

  if (current === undefined) return null;

  const draft = drafts[current.id] ?? { selected: [], text: "" };
  const options = current.options ?? [];
  const isLast = index >= total - 1;

  const goTo = (next: number) => {
    setIndex(Math.min(Math.max(next, 0), total - 1));
  };

  const toggleOption = (question: AskQuestion, option: string) => {
    setDrafts((state) => {
      const item = state[question.id] ?? { selected: [], text: "" };
      // 多选：点一下加/减；单选：点一下换，再点一次取消（取消后回到「没有作答」）
      const selected = item.selected.includes(option)
        ? item.selected.filter((value) => value !== option)
        : question.multiSelect === true
          ? [...item.selected, option]
          : [option];
      return { ...state, [question.id]: { ...item, selected } };
    });
  };

  const setText = (questionId: string, value: string) => {
    setDrafts((state) => ({
      ...state,
      [questionId]: { selected: state[questionId]?.selected ?? [], text: value },
    }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitted) return;
    // 回车 / 主按钮：非最后一题只前进，最后一题才提交
    if (!isLast) {
      goTo(index + 1);
      return;
    }
    if (!answeredAny) return;
    setSubmitted(true);
    onSubmit?.(toAnswers(questions, drafts));
  };

  return (
    <form
      data-slot="ask-card"
      // 宽度跟着容器走（原先是 max-w-md）：卡片固定在输入框上方，与 Composer 同宽 ——
      // 更窄会让人以为它是另一条独立的东西，而不是「该你说话了」这件事的一部分
      className={cn(paper, "flex w-full flex-col gap-3.5 rounded-[20px] p-4", className)}
      onSubmit={handleSubmit}
      {...props}
    >
      <div className="flex items-center gap-3">
        <span className="bg-foreground/[0.05] text-ink-3 flex size-9 shrink-0 items-center justify-center rounded-xl">
          <MessageCircleQuestion className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <p className="text-[13.5px] font-medium">{text.title}</p>
          <p className="text-ink-3 text-xs">{text.waiting}</p>
        </div>
      </div>

      {/* 进度：文字 + 可点的圆点（回头改某一题不必反复点上一题） */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-ink-3 text-[11px] tabular-nums">{text.progressOf(index + 1, total)}</p>
        {total > 1 && (
          <div
            role="group"
            aria-label={text.progressOf(1, total)}
            className="flex items-center gap-1"
          >
            {questions.map((question, position) => {
              const active = position === index;
              return (
                <button
                  key={question.id}
                  type="button"
                  aria-current={active ? "step" : undefined}
                  aria-label={question.header}
                  onClick={() => goTo(position)}
                  className={cn(
                    "size-1.5 rounded-full transition-[background-color,scale,width] duration-150 motion-reduce:transition-none",
                    active
                      ? "bg-foreground/70 w-3"
                      : isAnswered(drafts[question.id])
                        ? "bg-foreground/35 hover:bg-foreground/50"
                        : "bg-foreground/15 hover:bg-foreground/30",
                  )}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <p className="text-[13px] font-medium">{current.header}</p>
          {/* 多选是隐形约定，给一行小字说清，别让用户点第二个选项时才发现 */}
          {current.multiSelect === true && options.length > 0 && (
            <span className="text-ink-4 text-[11px]">{text.multiSelect}</span>
          )}
        </div>
        <p className="text-ink-2 text-xs leading-relaxed">{current.question}</p>

        {options.length > 0 && (
          <div role="group" aria-label={current.header} className="flex flex-col gap-1.5">
            {options.map((option, position) => {
              const active = draft.selected.includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleOption(current, option)}
                  className={cn(
                    "active:scale-[0.99] motion-reduce:transition-none flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition-[background-color,color,scale] duration-150",
                    active ? inkButton : cn(field, "text-ink-2 hover:text-foreground"),
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium tabular-nums",
                      active
                        ? "bg-background/20 text-background"
                        : "bg-foreground/[0.06] text-ink-3",
                    )}
                  >
                    {optionLetter(position)}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{option}</span>
                </button>
              );
            })}
          </div>
        )}

        <Input
          value={draft.text}
          onChange={(event) => setText(current.id, event.target.value)}
          placeholder={text.placeholder}
          aria-label={current.question}
        />
        {!isAnswered(draft) && <p className="text-ink-4 text-[11px]">{text.skipHint}</p>}
      </div>

      <div className="flex h-8 items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={index === 0 || submitted}
          onClick={() => goTo(index - 1)}
          className="rounded-full"
        >
          <ChevronLeft className="size-3.5" />
          {text.back}
        </Button>
        <Button
          type={isLast ? "submit" : "button"}
          size="sm"
          disabled={submitted || (isLast && !answeredAny)}
          onClick={isLast ? undefined : () => goTo(index + 1)}
          className="rounded-full"
        >
          {isLast ? (submitted ? text.submitted : text.submit) : text.next}
          {!isLast && <ChevronRight className="size-3.5" />}
        </Button>
      </div>
    </form>
  );
}
