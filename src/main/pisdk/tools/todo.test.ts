// todo 工具的行为测试：只验状态机与对外契约（revision、整表替换、id 分配、details 形状），
// 不碰文件系统——它本来就只依赖 toolContext.todo。

import {
  type AgentHarnessToolInvocation,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createTodoState,
  createTodoTool,
  parseTodoEntries,
  type TodoState,
  type TodoToolContext,
  toTodoPayload,
} from "./todo";

/** todo 不读 env，最小替身即可（不为测试构造完整 ExecutionEnv） */
function toolContext(todo: TodoState): TodoToolContext {
  return { env: { cwd: process.cwd() } as ExecutionEnv, todo };
}

const INVOCATION: AgentHarnessToolInvocation = {
  invocationId: "call-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

type TodoParams = Parameters<ReturnType<typeof createTodoTool>["execute"]>[1];
type TodoOutcome = Awaited<ReturnType<ReturnType<typeof createTodoTool>["execute"]>>;

function runTodo(context: TodoToolContext, params: TodoParams): Promise<TodoOutcome> {
  return createTodoTool().execute(
    "call-todo",
    params,
    () => {},
    context,
    INVOCATION,
    BACKGROUND_CONTEXT,
  );
}

function textOf(outcome: TodoOutcome): string {
  return outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** 摘要的最后一行是 done/total 计数 */
function lastLine(text: string): string {
  const lines = text.split("\n");
  return lines[lines.length - 1] ?? "";
}

describe("todo", () => {
  it("首次调用 revision=1，自动补 id，details 形状与 TodoEntry 字段名一致", async () => {
    const state = createTodoState();
    const context = toolContext(state);
    const outcome = await runTodo(context, {
      todos: [
        { text: "Read the spec", status: "pending" },
        { text: "Implement search.ts", status: "active" },
        { text: "Write tests", status: "done" },
      ],
    });

    expect(state.revision).toBe(1);
    expect(outcome.details).toEqual({
      revision: 1,
      todos: [
        { id: "t1", text: "Read the spec", status: "pending" },
        { id: "t2", text: "Implement search.ts", status: "active" },
        { id: "t3", text: "Write tests", status: "done" },
      ],
    });
    // 渲染层 parseTodoDetail 逐字段校验，多一个自造字段就会被整份丢掉
    expect(Object.keys(outcome.details.todos[0] ?? {}).sort()).toEqual(["id", "status", "text"]);
    // 状态是就地写回 toolContext.todo（运行时与 UI 持有的是同一个引用）
    expect(context.todo).toBe(state);
    expect(state.todos).toHaveLength(3);
  });

  it("content 带状态标记，末行给 done/total 计数", async () => {
    const state = createTodoState();
    const text = textOf(
      await runTodo(toolContext(state), {
        todos: [
          { text: "Read the spec", status: "done" },
          { text: "Implement search.ts", status: "active" },
          { text: "Write tests", status: "pending" },
        ],
      }),
    );

    expect(text).toContain("[x] Read the spec (t1)");
    expect(text).toContain("[>] Implement search.ts (t2)");
    expect(text).toContain("[ ] Write tests (t3)");
    expect(text).toContain("Todo list updated (revision 1)");
    expect(lastLine(text)).toBe("1/3 done");
  });

  it("是整表替换：省略的条目被移除，revision 递增", async () => {
    const state = createTodoState();
    await runTodo(toolContext(state), {
      todos: [
        { text: "Keep me", status: "active" },
        { text: "Drop me", status: "pending" },
      ],
    });
    const outcome = await runTodo(toolContext(state), {
      todos: [{ text: "Keep me", status: "active" }],
    });

    expect(state.revision).toBe(2);
    expect(state.todos).toHaveLength(1);
    expect(outcome.details).toEqual({
      revision: 2,
      todos: [{ id: "t1", text: "Keep me", status: "active" }],
    });
  });

  it("文本不变 id 就不变：重排列表不会让 id 跟着位置跑", async () => {
    const state = createTodoState();
    await runTodo(toolContext(state), {
      todos: [
        { text: "First", status: "pending" },
        { text: "Second", status: "pending" },
      ],
    });
    const outcome = await runTodo(toolContext(state), {
      todos: [
        { text: "Second", status: "active" },
        { text: "First", status: "done" },
      ],
    });

    expect(outcome.details.todos.map((entry) => entry.id)).toEqual(["t2", "t1"]);
    expect(outcome.details.todos.map((entry) => entry.text)).toEqual(["Second", "First"]);
  });

  it("显式 id 原样保留，重复 id 与新增条目自动补号且不撞号", async () => {
    const state = createTodoState();
    const first = await runTodo(toolContext(state), {
      todos: [
        { id: "build", text: "Build the app", status: "pending" },
        { id: "ship", text: "Ship it", status: "pending" },
      ],
    });
    expect(first.details.todos.map((entry) => entry.id)).toEqual(["build", "ship"]);

    // 第三条复用已占用的 "ship"：必须另取一个空号，且整表内不重复
    const second = await runTodo(toolContext(state), {
      todos: [
        { id: "build", text: "Build the app", status: "done" },
        { id: "ship", text: "Ship it", status: "active" },
        { id: "ship", text: "Extra work", status: "pending" },
      ],
    });
    const ids = second.details.todos.map((entry) => entry.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("build");
    expect(ids[1]).toBe("ship");
  });

  it("failed 条目的 reason 保留在 details 与摘要里", async () => {
    const state = createTodoState();
    const outcome = await runTodo(toolContext(state), {
      todos: [
        { text: "Deploy to staging", status: "failed", reason: "network unreachable" },
        { text: "Write the report", status: "pending" },
      ],
    });

    expect(outcome.details.todos[0]).toEqual({
      id: "t1",
      text: "Deploy to staging",
      status: "failed",
      reason: "network unreachable",
    });
    expect(Object.keys(outcome.details.todos[0] ?? {}).sort()).toEqual([
      "id",
      "reason",
      "status",
      "text",
    ]);
    const text = textOf(outcome);
    expect(text).toContain("[!] Deploy to staging (t1) — network unreachable");
    expect(lastLine(text)).toBe("0/2 done");
  });

  it("空文本被拒绝，且不改动状态", async () => {
    const state = createTodoState();
    const outcome = await runTodo(toolContext(state), {
      todos: [{ text: "   ", status: "pending" }],
    });

    expect(textOf(outcome)).toContain('Error: every todo needs a non-empty "text"');
    expect(state.revision).toBe(0);
    expect(state.todos).toEqual([]);
    expect(outcome.details).toEqual({ revision: 0, todos: [] });
  });

  it("空表是合法的清空操作", async () => {
    const state = createTodoState();
    await runTodo(toolContext(state), { todos: [{ text: "Only one", status: "active" }] });
    const outcome = await runTodo(toolContext(state), { todos: [] });

    expect(state.revision).toBe(2);
    expect(state.todos).toEqual([]);
    expect(textOf(outcome)).toContain("Todo list cleared (revision 2)");
    expect(outcome.details).toEqual({ revision: 2, todos: [] });
  });

  it("每个会话各自一份状态：两个 state 互不影响", () => {
    const first = createTodoState();
    const second = createTodoState();

    expect(first).not.toBe(second);
    expect(first).toEqual({ revision: 0, todos: [] });
    expect(second).toEqual({ revision: 0, todos: [] });
  });
});

describe("todo 持久化载荷", () => {
  it("parseTodoEntries 接受合法清单，并把空 reason 归一掉", () => {
    expect(parseTodoEntries([{ id: "t1", text: "a", status: "done" }])).toEqual([
      { id: "t1", text: "a", status: "done" },
    ]);
    expect(parseTodoEntries([{ id: "t1", text: "a", status: "failed", reason: "boom" }])).toEqual([
      { id: "t1", text: "a", status: "failed", reason: "boom" },
    ]);
    expect(parseTodoEntries([{ id: "t1", text: "a", status: "pending", reason: "" }])).toEqual([
      { id: "t1", text: "a", status: "pending" },
    ]);
    expect(parseTodoEntries([])).toEqual([]);
  });

  it("parseTodoEntries 对任何不合法输入返回 undefined（整份放弃，不抛错）", () => {
    // 整份放弃而不是跳过单条：丢掉一条会让 done/total 与主进程对不上
    expect(parseTodoEntries("nope")).toBeUndefined();
    expect(parseTodoEntries(null)).toBeUndefined();
    expect(parseTodoEntries([null])).toBeUndefined();
    expect(parseTodoEntries([{ text: "a", status: "done" }])).toBeUndefined();
    expect(parseTodoEntries([{ id: "", text: "a", status: "done" }])).toBeUndefined();
    expect(parseTodoEntries([{ id: "t1", text: "   ", status: "done" }])).toBeUndefined();
    expect(parseTodoEntries([{ id: "t1", text: "a", status: "running" }])).toBeUndefined();
    expect(parseTodoEntries([{ id: "t1", text: "a", status: "done", reason: 1 }])).toBeUndefined();
    expect(parseTodoEntries([{ id: "t1", text: "a", status: "done" }, "x"])).toBeUndefined();
  });

  it("toTodoPayload 落盘再读回等价（重启恢复的往返）", () => {
    const state: TodoState = {
      revision: 3,
      todos: [
        { id: "t1", text: "第一步", status: "done" },
        { id: "t2", text: "第二步", status: "failed", reason: "测试没过" },
      ],
    };
    // 经 JSON 序列化模拟真实落盘 / 读回
    const roundTripped = JSON.parse(JSON.stringify(toTodoPayload(state))) as {
      todos: unknown;
      revision: unknown;
    };
    expect(roundTripped.revision).toBe(3);
    expect(parseTodoEntries(roundTripped.todos)).toEqual(state.todos);
  });

  it("每次整表替换都会调用 persistTodo，参数就是更新后的状态", async () => {
    const todo = createTodoState();
    const seen: TodoState[] = [];
    const context: TodoToolContext = {
      ...toolContext(todo),
      persistTodo: (state) => {
        seen.push({ revision: state.revision, todos: [...state.todos] });
      },
    };

    const outcome = await runTodo(context, { todos: [{ text: "a", status: "pending" }] });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.revision).toBe(1);
    expect(seen[0]?.todos).toHaveLength(1);
    expect(textOf(outcome)).toContain("revision 1");
  });

  it("persistTodo 抛错时工具仍返回结果，内存状态不回滚", async () => {
    const todo = createTodoState();
    const context: TodoToolContext = {
      ...toolContext(todo),
      persistTodo: () => {
        throw new Error("磁盘满了");
      },
    };

    const outcome = await runTodo(context, { todos: [{ text: "a", status: "active" }] });

    expect(textOf(outcome)).toContain("revision 1");
    expect(outcome.details.todos).toHaveLength(1);
    expect(todo.revision).toBe(1);
  });
});
