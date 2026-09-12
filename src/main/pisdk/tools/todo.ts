// 会话级待办清单工具（与 pi 原生四件套 bash/read/write/edit 并列）。
//
// 语义对齐 codex 的 update_plan / opencode 的 todowrite：**整表替换**，不是增量命令。
// 为什么不做 add/complete/remove 这类增量接口：模型每轮都能看到自己上一次提交的整张表，
// 重发全表天然幂等，也不会出现「漏了一步状态」的半截状态机；增量接口在模型漏传 id 时
// 反而更脆。代价是每次都要重发一遍条目文本，但一张计划表本来就只有几行。
//
// 状态放在 toolContext 里（TodoToolContext.todo），由运行时按会话 createTodoState() 造一份。
// 每次整表替换后通过 toolContext.persistTodo 往会话里追加一条 custom entry，运行时在会话重建时
// 读回最后一条来恢复内存状态 —— 所以应用重启后清单还在（换会话仍是一张新表）。

import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
  JsonValue,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

export type TodoStatus = "pending" | "active" | "done" | "failed";

export interface TodoEntry {
  id: string;
  text: string;
  status: TodoStatus;
  reason?: string;
}

export interface TodoState {
  /** 本会话内的更新次数，从 1 开始；0 表示还没调用过 todo */
  revision: number;
  todos: TodoEntry[];
}

/** 每个会话一份，放在 toolContext 里传递（会话结束即释放） */
export function createTodoState(): TodoState {
  return { revision: 0, todos: [] };
}

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "active", "done", "failed"];

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

/**
 * 校验并归一化一份待办清单（来自持久化 entry 的 data，或任何外部输入）。
 * 任一条目不合法就整体返回 undefined —— 与渲染层策略一致：丢掉单条会让数量与主进程对不上，
 * 不如整份放弃。
 */
export function parseTodoEntries(value: unknown): TodoEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: TodoEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id === "") return undefined;
    if (typeof candidate.text !== "string" || candidate.text.trim() === "") return undefined;
    if (!isTodoStatus(candidate.status)) return undefined;
    const reason = candidate.reason;
    if (reason !== undefined && typeof reason !== "string") return undefined;
    todos.push({
      id: candidate.id,
      text: candidate.text,
      status: candidate.status,
      ...(reason === undefined || reason === "" ? {} : { reason }),
    });
  }
  return todos;
}

/**
 * 把内存状态序列化成持久化载荷。
 *
 * 单独写一个函数而不是直接传 state：`TodoEntry` 是 interface，没有索引签名，
 * **结构上不满足内核要求的 `JsonValue`**；写成对象字面量（并显式标注返回类型）才行。
 * 顺带把 `reason === undefined` 归一掉，保证落盘的数据形状稳定。
 */
export function toTodoPayload(state: TodoState): JsonValue {
  return {
    revision: state.revision,
    todos: state.todos.map((entry) => ({
      id: entry.id,
      text: entry.text,
      status: entry.status,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })),
  };
}

export interface TodoToolContext extends ExecutionToolContext {
  todo: TodoState;
  /**
   * 可选的持久化回调：每次整表替换后由运行时接到会话的 appendCustomEntry 上。
   * 允许抛错 —— 工具侧会兜住并记 warning，不会让工具调用失败。
   */
  persistTodo?: (state: TodoState) => void | Promise<void>;
}

/** details 形状：渲染层的 TodoList 已按 { todos, revision } 对接，字段名不要改 */
export interface TodoToolDetails {
  todos: TodoEntry[];
  revision: number;
}

const todoSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({
          description:
            "Stable item id, copied from the previous update. Omit it for new items and one is assigned automatically (t1, t2, ...).",
        }),
      ),
      text: Type.String({
        minLength: 1,
        description:
          'One imperative line describing the work, e.g. "Add tests for todo.ts". Keep it short; it is rendered as a single checklist row.',
      }),
      status: Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("active"),
          Type.Literal("done"),
          Type.Literal("failed"),
        ],
        {
          description:
            '"pending" = not started, "active" = in progress (at most one or two at a time), "done" = finished, "failed" = attempted and did not work.',
        },
      ),
      reason: Type.Optional(
        Type.String({
          description:
            'Short note shown under the item, meaningful for "failed" (e.g. "tests rejected the null case").',
        }),
      ),
    }),
    {
      description:
        "The complete new list, in display order. Owned by this call: entries you omit disappear, and this order is the order the user sees.",
    },
  ),
});

type TodoToolParams = Static<typeof todoSchema>;
type TodoInputEntry = TodoToolParams["todos"][number];

const TODO_DESCRIPTION = `Create or update the session todo list: the single source of truth for multi-step work, shown to the user as a live checklist.

When to use it:
- At the start of any task that needs more than a couple of steps or touches several files: write the whole plan once, in order, before starting the first step.
- After each step: call it again with the same list where that step is "done" and the next one is "active", so the user can follow the progress instead of guessing what you are doing.
- When a step fails or the approach changes: mark it "failed" with a short reason, or rewrite the text and keep the id, instead of silently dropping it.
- When the task is finished: send the final table with every item "done" (and nothing "active" or "pending"), so the checklist does not stay half-finished after your answer.

When not to use it:
- Single-step work (one edit, one command, one question), pure questions, or research where you do not know the steps yet — the call would only add noise.
- As a status message or a chat log: one imperative line per item ("Add tests for todo.ts"), never paragraphs, and do not repeat the work you already described in your answer.
- To track things outside the user's request, or to keep state across sessions: the list dies with the session.
- Do not append to the list by hand: the "todos" array you send replaces the previous one entirely.

Arguments:
- todos (required): the complete new list, in display order. This is a whole-table replacement, not a patch: entries you omit are removed. Send back the ids you received for items that survive; for a new item, omit "id" or leave it out and an id (t1, t2, ...) is assigned for you, staying stable as long as the item text is unchanged.
  - text: one imperative line, required and non-empty.
  - status: "pending", "active" (in progress; keep it to at most one or two), "done", or "failed" (attempted and did not work).
  - reason: optional, only useful for "failed" — a short note shown under the item.
- An empty "todos" array is accepted and clears the list, but a finished task should end with all items "done" rather than with no list at all.

Output:
- A checklist for the model side with status markers "[ ]" pending, "[>]" active, "[x]" done and "[!]" failed, e.g. "[>] Implement search.ts (t1)", followed by the done/total count on the last line.
- The same table as structured details ({ todos, revision }) for the UI; revision starts at 1 and counts how many times the list was updated in this session.`;

/** 取当前表里最小空闲的自动 id（t1、t2……），保证同一张表内不重复 */
function nextAutoId(used: ReadonlySet<string>): string {
  let index = 1;
  while (used.has(`t${index}`)) index += 1;
  return `t${index}`;
}

/**
 * 给整张新表补 id，按优先级：
 * 1. 模型显式给了 id 且本表内还没被占用 → 原样保留（它知道自己指的是哪一条）；
 * 2. 否则复用「上一次同文本条目」的 id —— 整表替换时文本不变就保持同一个 id，
 *    渲染层的 key 与进度 diff 才不会每轮抖动；
 * 3. 都没有才取最小空闲的 tN。
 * 每条旧 id 只复用一次（按出现顺序取），所以同文本的重复条目也不会撞 id。
 */
function assignIds(inputs: readonly TodoInputEntry[], previous: readonly TodoEntry[]): TodoEntry[] {
  const reusable = new Map<string, string[]>();
  for (const entry of previous) {
    const queue = reusable.get(entry.text);
    if (queue === undefined) reusable.set(entry.text, [entry.id]);
    else queue.push(entry.id);
  }

  const used = new Set<string>();
  const todos: TodoEntry[] = [];
  for (const input of inputs) {
    const provided = input.id?.trim();
    let id: string;
    if (provided !== undefined && provided !== "" && !used.has(provided)) {
      id = provided;
    } else {
      const candidate = reusable.get(input.text)?.shift();
      id = candidate !== undefined && !used.has(candidate) ? candidate : nextAutoId(used);
    }
    used.add(id);
    const reason = input.reason?.trim();
    todos.push({
      id,
      text: input.text.trim(),
      status: input.status,
      ...(reason === undefined || reason === "" ? {} : { reason }),
    });
  }
  return todos;
}

/** 状态标记：与渲染层同一套语义，failed 用 "[!]" 与 "[x] 已完成" 区分开 */
const STATUS_MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  failed: "[!]",
};

/** 给模型看的清单摘要：每行一条 + 末行 done/total */
function summarize(todos: readonly TodoEntry[]): string {
  const done = todos.filter((entry) => entry.status === "done").length;
  const lines = todos.map((entry) => {
    const note = entry.status === "failed" && entry.reason ? ` — ${entry.reason}` : "";
    return `${STATUS_MARKERS[entry.status]} ${entry.text} (${entry.id})${note}`;
  });
  lines.push(`${done}/${todos.length} done`);
  return lines.join("\n");
}

/** 构造 todo 工具；状态来自 toolContext.todo，工具本身无内部状态（同一实例可服务多个会话） */
export function createTodoTool(): AgentHarnessTool<
  TodoToolContext,
  typeof todoSchema,
  TodoToolDetails
> {
  return {
    name: "todo",
    label: "todo",
    description: TODO_DESCRIPTION,
    parameters: todoSchema,
    async execute(_toolCallId, params, _onUpdate, toolContext, _invocation, _context) {
      const state = toolContext.todo;
      const result = (text: string): AgentToolResult<TodoToolDetails> => ({
        content: [{ type: "text", text }],
        details: { todos: state.todos, revision: state.revision },
      });

      const empty = params.todos.find((entry) => entry.text.trim() === "");
      if (empty !== undefined) {
        // 语义校验：schema 拦不住「空白字符串」，而空条目会让渲染层整份清单都放弃显示
        return result(
          `Error: every todo needs a non-empty "text" (one entry was blank). The list was not changed (revision stays ${state.revision}).`,
        );
      }

      const todos = assignIds(params.todos, state.todos);
      state.revision += 1;
      state.todos = todos;
      // 持久化到会话：失败只记 warning —— 待办是辅助信息，不能因此让工具调用失败
      try {
        await toolContext.persistTodo?.(state);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`待办清单持久化失败（本次结果仍返回）：${detail}`);
      }

      const header =
        todos.length === 0
          ? `Todo list cleared (revision ${state.revision}).`
          : `Todo list updated (revision ${state.revision}):`;
      return {
        content: [{ type: "text", text: `${header}\n${summarize(todos)}` }],
        details: { todos, revision: state.revision },
      };
    },
  };
}
