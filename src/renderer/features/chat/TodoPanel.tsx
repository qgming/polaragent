import { ListChecksIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type TodoItem, TodoList } from "@/renderer/components/assistant-ui/elements/todo-list";
import { SectionEmpty, SessionSection } from "@/renderer/features/session/session-section";
import { useActiveSessionMessages } from "@/renderer/features/session/use-active-messages";
import type { ChatMessage } from "@/shared/contracts/session";
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
 * 最后那次调用（失败、或两边都拿不到可解析的清单）给不出快照时返回 null；
 * 更早那份在这里不能兜底：它是被替换掉的那一份，显示出来只会和模型看到的对不上。
 * 会话面板那边据此显示空态文案（不再像原来那样整块不渲染，因为区块本身要一直在）。
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
 * store 的 ChatMessage.parts → latestTodo 认的消息形状。
 *
 * 两处只差一个槽位名：工具结果在消息里叫 `details`（见 contracts/session.ts），
 * 经 runtime 的 message-converter 映射后才叫 `artifact`（ToolParts 读的就是那份）。
 * 会话面板直接读 store（见 use-active-messages），所以在这里做这一次映射 ——
 * 解析仍然只有 resolveToolDetail 一条路，面板不另算一份清单。
 */
export function toTodoPanelMessages(messages: readonly ChatMessage[]): TodoPanelMessage[] {
  return messages.map((message) => ({
    parts: message.parts.map((part) =>
      part.type === "tool-call"
        ? {
            type: part.type,
            toolName: part.toolName,
            args: part.args,
            artifact: part.details,
            isError: part.isError,
          }
        : { type: part.type },
    ),
  }));
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

/**
 * 「任务清单」区块（原 TodoPanel，从 composer 上沿迁到会话面板）。
 *
 * 取数改成直接读 store 的当前会话消息（useActiveSessionMessages）：
 * 面板挂在 TitleBar 上，读 store 就不依赖 aui 线程状态的转发；这条链和事件写入
 * （part-upsert → messagesBySession）是同一个数组，因此重启回读、切回旧会话、
 * 会话切换都能立刻重算出同一份清单，徽标也跟着变。
 *
 * 与原来那条的区别只有两处，都是容器带来的：
 *   · 区块**始终渲染**（没有 todo 调用时给空态文案，而不是整块消失）
 *   · 进度从行尾文字改成右侧徽标；全部完成时徽标转绿，区块不消失 ——
 *     用户此刻正看着它，让它原地消失比留一个「已完成」的记号更让人迷惑
 */
export function TodoPanel() {
  const { t } = useTranslation();
  const messages = useActiveSessionMessages();
  const todo = useMemo(() => latestTodo(toTodoPanelMessages(messages)), [messages]);

  const done = todo === null ? 0 : todo.items.filter((item) => item.status === "done").length;
  const total = todo?.items.length ?? 0;
  const finished = isTodoFinished(todo);

  return (
    <SessionSection
      slot="todo-panel"
      icon={ListChecksIcon}
      title={t("sessionPanel.tasks")}
      toggleLabel={t("sessionPanel.tasksToggle")}
      count={total === 0 ? undefined : `${done}/${total}`}
      countSlot="todo-count"
      countTone={finished ? "done" : "neutral"}
      // 有清单就是这次会话的正文：浮层一打开就展开；用户手动收过之后不再自动弹开
      autoOpen={total > 0}
    >
      {total === 0 ? (
        <SectionEmpty>{t("sessionPanel.tasksEmpty")}</SectionEmpty>
      ) : (
        /* 清单一长就内部滚动，不把浮层整体撑高（与原来那条同口径） */
        <div className="app-scrollbar max-h-[min(16rem,36vh)] overflow-y-auto px-2.5 pt-1 pb-2">
          <TodoList items={todo?.items ?? []} showHeader={false} />
        </div>
      )}
    </SessionSection>
  );
}
