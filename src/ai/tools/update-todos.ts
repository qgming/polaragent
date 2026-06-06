// update_todos —— 维护任务待办清单
// src/ai/tools/update-todos.ts

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  useTaskMonitorStore,
  type TodoItem,
} from "@/stores/task-monitor-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import { text, type ToolContext } from "./tool-context";

// 待办参数 schema（独立成 const 以便推导 execute 的 params 类型）
const updateTodosParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "待办事项的简短描述" }),
      status: Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ],
        { description: "待办状态" },
      ),
    }),
    { description: "完整的待办列表" },
  ),
});

export function updateTodosTool(
  ctx: ToolContext,
): AgentTool<typeof updateTodosParams> {
  return {
    name: "update_todos",
    label: "更新待办",
    description:
      "维护当前任务的待办清单。每次调用都用完整的待办列表覆盖之前的清单。" +
      "在开始多步骤任务前先列出待办，完成一步就把对应项标记为 completed，正在做的标记 in_progress。",
    parameters: updateTodosParams,
    execute: async (_id, params: Static<typeof updateTodosParams>) => {
      const todos: TodoItem[] = params.todos.map((todo, index) => ({
        id: `todo-${index}`,
        content: todo.content,
        status: todo.status,
      }));

      if (ctx.isTeam) {
        useTeamMonitorStore.getState().updateTodos(ctx.threadId, todos);
      } else {
        useTaskMonitorStore.getState().setTodos(ctx.threadId, todos);
      }

      const done = todos.filter((t) => t.status === "completed").length;
      return {
        content: text(`已更新待办 ${todos.length} 项（已完成 ${done} 项）`),
        details: { todos },
      };
    },
  };
}
