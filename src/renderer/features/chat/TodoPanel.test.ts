/**
 * TodoPanel 的纯逻辑测试：只覆盖「从消息流里挑出最新清单」这一段，
 * 不渲染组件（渲染测试在同目录的 TodoPanel.test.tsx）。
 *
 * 关心的两件事：取值顺序要跟工具卡一致（details 优先、参数兜底），
 * 以及任何形状不对的输入都只能得到 null，绝不能抛 —— 工具卡在渲染期抛错会带塌整条消息，
 * 面板同理。
 */

import { describe, expect, it } from "vitest";
import {
  latestTodo,
  type TodoPanelMessage,
  type TodoPanelPart,
  type TodoSnapshot,
} from "./TodoPanel";

/** 一条只带一个 part 的助手消息 */
function message(...parts: TodoPanelPart[]): TodoPanelMessage {
  return { parts };
}

/** 一条正常的 todo 工具调用：details 是主进程产出的成品（id 必填） */
function todoCall(over: Partial<TodoPanelPart> = {}): TodoPanelPart {
  return {
    type: "tool-call",
    toolName: "todo",
    args: { todos: [{ text: "写面板", status: "active" }] },
    ...over,
  };
}

const FIRST_DETAIL = {
  todos: [
    { id: "1", text: "读一遍现有实现", status: "done" },
    { id: "2", text: "写面板", status: "active" },
  ],
  revision: 1,
};

const SECOND_DETAIL = {
  todos: [
    { id: "1", text: "读一遍现有实现", status: "done" },
    { id: "2", text: "写面板", status: "done" },
    { id: "3", text: "跑测试", status: "pending" },
  ],
  revision: 2,
};

const NO_TODO: readonly TodoPanelMessage[] = [
  { parts: [{ type: "text" }] },
  { parts: [{ type: "tool-call", toolName: "bash", args: { command: "ls" } }] },
  { parts: [{ type: "tool-call", toolName: "edit", artifact: { patch: "" } }] },
];

describe("latestTodo", () => {
  it("零个 todo 调用（空线程 / 只有别的工具）→ null", () => {
    expect(latestTodo([])).toBeNull();
    expect(latestTodo(NO_TODO)).toBeNull();
  });

  it("没有 parts 的消息不参与判定，也不抛", () => {
    expect(latestTodo([{}, { parts: [] }, { parts: [{ type: "text" }] }])).toBeNull();
  });

  it("多个 todo 调用 → 取最后一个的结果，不带 revision 也算数", () => {
    const messages = [
      message(todoCall({ artifact: FIRST_DETAIL })),
      { parts: [{ type: "text", text: "中间还说了一句话" }] },
      message(todoCall({ artifact: SECOND_DETAIL })),
    ];
    expect(latestTodo(messages)).toEqual({
      items: [
        { id: "1", text: "读一遍现有实现", status: "done" },
        { id: "2", text: "写面板", status: "done" },
        { id: "3", text: "跑测试", status: "pending" },
      ],
      revision: 2,
    });
  });

  it("同一条消息里有多个 todo 调用时也取最后一个", () => {
    const messages = [
      message(todoCall({ artifact: FIRST_DETAIL }), todoCall({ artifact: SECOND_DETAIL })),
    ];
    const todo = latestTodo(messages);
    expect(todo?.revision).toBe(2);
    expect(todo?.items).toHaveLength(3);
  });

  it("结果还没回来（流式中）时用参数里的清单兜底，缺 id 按位置补", () => {
    const messages = [message(todoCall())];
    expect(latestTodo(messages)).toEqual({
      items: [{ id: "todo-0", text: "写面板", status: "active" }],
    });
  });

  it("details 优先于参数", () => {
    const messages = [
      message(
        todoCall({
          args: { todos: [{ text: "参数里的旧版本", status: "pending" }] },
          artifact: SECOND_DETAIL,
        }),
      ),
    ];
    expect(latestTodo(messages)?.revision).toBe(2);
    expect(latestTodo(messages)?.items[0]?.text).toBe("读一遍现有实现");
  });

  it("最后一次调用失败（isError）→ null，不退回更早那份", () => {
    const messages = [
      message(todoCall({ artifact: FIRST_DETAIL })),
      message(todoCall({ isError: true, artifact: SECOND_DETAIL })),
    ];
    expect(latestTodo(messages)).toBeNull();
  });

  it("结果非法（非对象 / todos 缺失或非数组 / 状态非法 / 文本为空）→ null 且不抛", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      "不是对象",
      42,
      {},
      { todos: {} },
      { todos: null },
      { todos: [{}] },
      { todos: [{ id: "1", text: "写面板", status: "进行中" }] },
      { todos: [{ id: "1", text: "", status: "done" }] },
      { todos: [{ id: 1, text: "写面板", status: "done" }] },
      { todos: [{ id: "1", text: "写面板", status: "done", reason: 1 }] },
    ];

    for (const artifact of invalid) {
      // 参数也一并抹掉：这是「最后一次调用的结果不可用、且没有可兜底的参数」这一路，
      // 面板应当整块隐藏而不是拿一份读不出来的清单硬画
      const messages = [message(todoCall({ artifact, args: undefined }))];
      expect(() => latestTodo(messages)).not.toThrow();
      expect(latestTodo(messages)).toBeNull();
    }
  });

  // resolveToolDetail 的既定口径是 details 解析不出来就退到参数（不只是 details 缺席时）。
  // 面板不另写解析，所以这里跟着这个口径走：结果坏掉但参数是完整清单时照样显示得出来。
  it("结果非法但参数里有可用清单时退到参数（与工具卡同一口径）", () => {
    const messages = [message(todoCall({ artifact: "不是对象" }))];
    expect(latestTodo(messages)).toEqual({
      items: [{ id: "todo-0", text: "写面板", status: "active" }],
    });
  });

  it("结果非法且参数也没有可用清单时 → null 且不抛", () => {
    const broken: readonly TodoPanelMessage[] = [
      message(todoCall({ artifact: { todos: "不是数组" }, args: { todos: "也不是数组" } })),
      message({ type: "tool-call", toolName: "todo" }),
    ];
    expect(() => latestTodo(broken)).not.toThrow();
    expect(latestTodo(broken)).toBeNull();
  });

  it("revision 类型不对不影响清单本身，但不报错（与工具卡同一口径）", () => {
    const todo: TodoSnapshot | null = latestTodo([
      message(
        todoCall({
          artifact: { todos: [{ id: "1", text: "写面板", status: "done" }], revision: "2" },
        }),
      ),
    ]);
    expect(todo).toEqual({ items: [{ id: "1", text: "写面板", status: "done" }] });
  });
});
