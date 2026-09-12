/**
 * TodoList 的渲染测试 —— 同时充当 ui project（jsdom）的验收样例。
 *
 * 该组件实现完整但当前零引用（见 scripts/check-unwired.mjs）：
 * P1-2 接入 todo 工具后，这条数据链才会真正挂上 UI。
 * 先有测试，是为了让「接上了」和「又断了」都可被观测。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type TodoItem, TodoList } from "./todo-list";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

const ITEMS: readonly TodoItem[] = [
  { id: "1", text: "读取现有实现", status: "done" },
  { id: "2", text: "改写运行时装配", status: "active" },
  { id: "3", text: "等待用户审批", status: "pending" },
  { id: "4", text: "跑通单元测试", status: "failed", reason: "vitest 退出码 1" },
];

describe("TodoList", () => {
  it("渲染每一条待办文本", () => {
    render(<TodoList items={ITEMS} />);
    for (const item of ITEMS) {
      expect(screen.getByText(item.text)).toBeTruthy();
    }
  });

  it("计数只统计 done", () => {
    render(<TodoList items={ITEMS} />);
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("给了 revision 时在计数后追加 rev", () => {
    render(<TodoList items={ITEMS} revision={7} />);
    expect(screen.getByText("1/4 · rev 7")).toBeTruthy();
  });

  it("failed 项额外渲染 reason，其余状态不渲染", () => {
    render(<TodoList items={ITEMS} />);
    expect(screen.getByText("vitest 退出码 1")).toBeTruthy();
  });

  it("把状态写进无障碍文本，供读屏使用", () => {
    const { container } = render(<TodoList items={ITEMS} />);
    const statuses = [...container.querySelectorAll(".sr-only")].map((node) => node.textContent);
    expect(statuses).toEqual(["done", "active", "pending", "failed"]);
  });

  it("空列表渲染 0/0 且不抛错", () => {
    render(<TodoList items={[]} />);
    expect(screen.getByText("0/0")).toBeTruthy();
  });

  it("根节点带 data-slot，并保留传入的 className", () => {
    const { container } = render(<TodoList items={ITEMS} className="custom-x" />);
    const root = container.querySelector('[data-slot="todo-list"]');
    expect(root).not.toBeNull();
    expect(root?.className).toContain("custom-x");
  });

  it("showHeader=false 时不渲染自带标题行（外层已有标题时避免重复）", () => {
    const { container } = render(<TodoList items={ITEMS} showHeader={false} />);
    expect(container.textContent).not.toContain("1/4");
    expect(screen.getByText("读取现有实现")).toBeTruthy();
  });

  it("title 可覆盖默认的英文标题，并保留计数", () => {
    render(<TodoList items={ITEMS} title="待办清单" revision={2} />);
    expect(screen.getByText("待办清单")).toBeTruthy();
    expect(screen.getByText("1/4 · rev 2")).toBeTruthy();
  });
});
