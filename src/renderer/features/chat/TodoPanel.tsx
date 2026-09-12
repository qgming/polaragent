import { useAuiState } from "@assistant-ui/react";
import { ChevronDown, ListTodoIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { collapsePanel, mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { type TodoItem, TodoList } from "@/renderer/components/assistant-ui/elements/todo-list";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { resolveToolDetail } from "./tool-presentation";

/**
 * 面板要读的最小 part 形状。刻意用结构类型而不是 aui 的 PartState：
 * 纯函数不该依赖运行时的完整形状（与 ToolParts 的 ToolPartLike 同一个口径），
 * 也因此能直接拿测试里的普通对象喂它。
 */
export interface TodoPanelPart {
  type?: string;
  toolName?: string;
  args?: unknown;
  /** 工具的 details 走 aui 的 artifact 槽位（见 runtime/message-converter.ts 的映射） */
  artifact?: unknown;
  isError?: boolean;
}

/** 面板要读的最小消息形状：只认 parts */
export interface TodoPanelMessage {
  parts?: readonly TodoPanelPart[];
}

/** 面板要显示的清单快照：与 TodoList 的入参同形（prop 叫 items，details 里叫 todos） */
export interface TodoSnapshot {
  items: TodoItem[];
  revision?: number;
}

/**
 * 消息流 → 面板要显示的清单：取**最后一条** todo 工具调用，其余一律不看。
 *
 * 为什么扫消息流而不是记「最近一次调用」：todo 的语义是整表替换，而最新的清单只由
 * 最后那次调用决定 —— 这条调用连同它的结果就在消息里（历史回读后同样在），
 * 面板因此不需要任何额外的内存状态，重启或切回旧会话都能重建。
 *
 * 解析一律交给 resolveToolDetail（不另写一份）：它已经约定好「优先 details，解析不出来就退到
 * 工具参数」以及逐项校验，面板与对话流里的工具卡因此共用同一个真相 ——
 * 包括「details 坏了但参数是完整清单时照样显示得出来」这条看似宽松的口径。
 * 最后那次调用（失败、或两边都拿不到可解析的清单）给不出快照时返回 null，面板据此整块隐藏；
 * 更早那份在这里不能兜底：它是被替换掉的那一份，显示出来只会和模型看到的对不上。
 */
export function latestTodo(messages: readonly TodoPanelMessage[]): TodoSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts;
    if (parts === undefined) continue;

    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part?.type !== "tool-call" || part.toolName !== "todo") continue;

      const detail = resolveToolDetail(
        part.toolName,
        part.artifact,
        part.isError === true,
        part.args,
      );
      if (detail === null || detail.kind !== "todo") return null;
      return { items: detail.items, revision: detail.revision };
    }
  }

  return null;
}

/**
 * 这份清单是不是已经收尾了：至少有一条、且每一条都是 done。
 *
 * 为什么空清单不算收尾：`todos: []` 是合法的「清空」调用（内核提示词也把它当作一种收尾写法），
 * 但它没有「做完」的语义，当作收尾会把一次清空误判成任务完成。
 *
 * 为什么 failed 不算：failed 是终态却不是成功，留着面板让用户看见哪一步崩了，比让它消失有用。
 */
export function isTodoFinished(
  snapshot: TodoSnapshot | null,
): snapshot is { items: [TodoItem, ...TodoItem[]]; revision?: number } {
  if (snapshot === null) return false;
  return snapshot.items.length > 0 && snapshot.items.every((item) => item.status === "done");
}

/** 展开后的内容区上限：清单一长就内部滚动，不把输入区顶上去 */
const PANEL_CONTENT = "max-h-[min(16rem,36vh)]";

/**
 * 待办清单条：贴在**输入组件顶部**，与它共用一个面（composer 自己的圆角盒 + 边框 + 阴影），
 * 所以这里自带负外边距去顶到那个盒子的内边缘 —— 它只在 Composer 的 AttachmentDropzone
 * 里使用（挂载点见 Composer.tsx），不铺自己的底色，铺了就成两块而不是一体。
 *
 * 收起时只占一行：标题在左、进度在右；展开时下面接清单本体。
 * 清单本体复用 TodoList（Elements 的既定外观），并关掉它自带的标题行 ——
 * 否则会出现「待办清单」和 TodoList 自己的标题两个标题。
 *
 * 数据全部来自消息流（见 latestTodo），因此重启后回读历史、或切回一个旧会话，
 * 都会重新算出同一份清单；没有 todo 调用时不占位。
 */
export function TodoPanel() {
  const { t } = useTranslation();
  // 默认展开：这条存在的意义就是「不用点开就能看到」；收起留给确实想清空这块空间的用户
  const [open, setOpen] = useState(true);
  /**
   * 消息从 aui 的线程状态读（与 Thread.tsx 取 messages 同源）：它由 OintRuntimeProvider 的
   * useExternalStoreRuntime 驱动，而 store 的消息来自主进程的历史回读与事件流 ——
   * 换句话说这条链在应用重启后依然成立，面板不是靠「刚发生过什么」立起来的。
   * 选择器返回的是 store 里的数组本身（引用稳定），不会每次 store 更新都触发重渲染。
   */
  const messages = useAuiState((s) => s.thread.messages);
  const todo = useMemo(() => latestTodo(messages), [messages]);
  // 进度放在收起行的右端（清单自带的标题行已关掉，避免两个标题）
  const done = todo === null ? 0 : todo.items.filter((item) => item.status === "done").length;

  // 整块不渲染的两种情况：压根没有待办调用（空壳白占一行、没有信息量），以及清单已经
  // 全部做完 —— 「做完」正是最该把输入框上方的空间腾出来的时候
  if (todo === null || isTodoFinished(todo)) return null;

  return (
    <div
      data-slot="todo-panel"
      // 抵消 AttachmentDropzone 的 p-2.5，贴着 composer 的圆角内边缘；上圆角与外壳口径一致
      className="-mx-2.5 -mt-2.5 rounded-t-[24px] border-b border-border/50"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          // 可见文本是「待办清单」，展开态由 aria-expanded 表达；这里补一句动作说明
          aria-label={t("chat.todosPanelToggle")}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-t-[24px] px-2.5 py-1.5 text-start outline-none transition-colors",
            "hover:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-foreground/20",
            typeEyebrow,
          )}
        >
          <ListTodoIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="me-auto truncate">{t("chat.todos")}</span>
          <span className={cn(mono, "shrink-0 text-foreground/35 tabular-nums")}>
            {todo.revision === undefined
              ? `${done}/${todo.items.length}`
              : `${done}/${todo.items.length} · rev ${todo.revision}`}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
          <div className={cn(PANEL_CONTENT, "app-scrollbar overflow-y-auto px-2.5 pt-1 pb-2")}>
            <TodoList items={todo.items} revision={todo.revision} showHeader={false} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
