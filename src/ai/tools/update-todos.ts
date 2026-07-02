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
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("replace"), // 默认：完整覆盖（向后兼容）
        Type.Literal("add"), // 追加新待办
        Type.Literal("update"), // 更新现有待办
        Type.Literal("delete"), // 删除待办
        Type.Literal("complete"), // 标记完成
      ],
      { description: "操作类型，默认 replace（完整覆盖）" },
    ),
  ),
  todos: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String({ description: "待办 ID（update/delete/complete 时必填）" })),
        title: Type.Optional(Type.String({ description: "待办标题（add/replace/update 时建议提供）" })),
        status: Type.Optional(
          Type.Union(
            [
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("completed"),
            ],
            { description: "状态" },
          ),
        ),
        priority: Type.Optional(
          Type.Union(
            [
              Type.Literal("high"),
              Type.Literal("medium"),
              Type.Literal("low"),
            ],
            { description: "优先级" },
          ),
        ),
      }),
      { description: "待办列表（replace/add 时必填）" },
    ),
  ),
});

export function updateTodosTool(
  ctx: ToolContext,
): AgentTool<typeof updateTodosParams> {
  return {
    name: "update_todos",
    label: "更新待办",
    description:
      "管理任务待办清单。支持增量操作：add 追加、update 修改、delete 删除、complete 标记完成、replace 完整覆盖（默认）。" +
      "在开始多步骤任务前先列出待办，完成一步就把对应项标记为 completed，正在做的标记 in_progress。",
    parameters: updateTodosParams,
    execute: async (_id, params: Static<typeof updateTodosParams>) => {
      const action = params.action || "replace";
      const currentStore = ctx.isTeam ? useTeamMonitorStore : useTaskMonitorStore;
      const currentTodos = currentStore.getState().getMonitor(ctx.threadId).todos || [];

      let newTodos: TodoItem[];

      switch (action) {
        case "replace":
          newTodos = (params.todos || []).map((t, i) => ({
            id: t.id || `todo-${i}`,
            content: t.title || "未命名",
            status: t.status || "pending",
            priority: t.priority || "medium",
          }));
          break;

        case "add":
          newTodos = [...currentTodos];
          for (const t of params.todos || []) {
            newTodos.push({
              id: t.id || `todo-${newTodos.length}`,
              content: t.title || "未命名",
              status: t.status || "pending",
              priority: t.priority || "medium",
            });
          }
          break;

        case "update":
          newTodos = [...currentTodos];
          for (const t of params.todos || []) {
            if (!t.id) continue;
            const idx = newTodos.findIndex((td) => td.id === t.id);
            if (idx >= 0) {
              newTodos[idx] = {
                ...newTodos[idx],
                content: t.title ?? newTodos[idx].content,
                status: t.status ?? newTodos[idx].status,
                priority: t.priority ?? newTodos[idx].priority,
              };
            }
          }
          break;

        case "delete": {
          const deleteIds = new Set(
            (params.todos || []).map((t) => t.id).filter((id): id is string => !!id),
          );
          newTodos = currentTodos.filter((t) => !deleteIds.has(t.id));
          break;
        }

        case "complete":
          newTodos = [...currentTodos];
          for (const t of params.todos || []) {
            if (!t.id) continue;
            const idx = newTodos.findIndex((td) => td.id === t.id);
            if (idx >= 0) {
              newTodos[idx] = { ...newTodos[idx], status: "completed" };
            }
          }
          break;

        default:
          newTodos = currentTodos;
      }

      if (ctx.isTeam) {
        useTeamMonitorStore.getState().updateTodos(ctx.threadId, newTodos);
      } else {
        useTaskMonitorStore.getState().setTodos(ctx.threadId, newTodos);
      }

      const done = newTodos.filter((t) => t.status === "completed").length;
      return {
        content: text(`待办清单已更新（${action}），当前共 ${newTodos.length} 项（已完成 ${done} 项）`),
        details: { todos: newTodos },
      };
    },
  };
}
