/**
 * 压缩条（ThreadToolbar）的测试（ui project / jsdom）。
 *
 * 这是「压缩中要有提示」的**唯一用户可见面**，它要同时说清四件事，
 * 而早先只有两态（有摘要 / 空串），其中「空串」被当成进行中 ——
 * 一次**失败**的压缩会让顶部永久显示运行中。这里的用例就是钉住那四种结局。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { SessionCompaction } from "@/shared/contracts";
import type { SessionSummary } from "@/shared/contracts/session";
import { ThreadToolbar } from "./ThreadToolbar";

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const SESSION: SessionSummary = {
  id: "s1",
  title: "会话",
  createdAt: 0,
  updatedAt: 0,
  cwd: "D:\\proj",
  archived: false,
  pinned: false,
  messageCount: 0,
  model: null,
};

/** 灌一个「当前会话 + 指定压缩状态」的 store */
function seed(compaction?: SessionCompaction) {
  useChatStore.setState({
    sessions: [SESSION],
    activeSessionId: SESSION.id,
    compactions: compaction === undefined ? {} : { [SESSION.id]: compaction },
  });
}

describe("压缩条", () => {
  it("没有压缩状态时不占位置", () => {
    seed();
    const { container } = render(<ThreadToolbar />);
    expect(container.firstChild).toBeNull();
  });

  it("进行中：压缩中 + 原因 + 秒数（自动压缩发生在运行中，用户要知道卡在哪）", () => {
    const startedAt = Date.now() - 3000;
    seed({ phase: "running", reason: "threshold", startedAt });
    render(<ThreadToolbar />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("压缩中");
    expect(status.textContent).toContain("自动压缩");
    // 已用秒数：只断言「有数字 + s」，不钉死具体值（跑测试的机器有快有慢）
    expect(status.textContent).toMatch(/\d+s/);
  });

  it("手动压缩标明「手动」，与自动压缩分得开", () => {
    seed({ phase: "running", reason: "manual", startedAt: Date.now() });
    render(<ThreadToolbar />);
    expect(screen.getByRole("status").textContent).toContain("手动压缩");
  });

  it("完成：报出压缩前 tokens 与保留条数，展开能看摘要", () => {
    seed({
      phase: "completed",
      reason: "manual",
      startedAt: 1,
      endedAt: 2,
      summaryPreview: "这是一段摘要",
      tokensBefore: 123_456,
      retainedCount: 7,
    });
    render(<ThreadToolbar />);

    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toContain("约 123k tokens");
    expect(trigger.textContent).toContain("保留 7 条");

    // 摘要在折叠面板里：点开才出现
    expect(screen.queryByText("这是一段摘要")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("这是一段摘要")).toBeTruthy();
  });

  // 回归：失败曾经被写成「进行中」，顶部永久转圈
  it("失败：显示原因（不是运行中），点一下收掉", () => {
    seed({
      phase: "failed",
      reason: "manual",
      startedAt: 1,
      endedAt: 2,
      error: "模型超时",
    });
    render(<ThreadToolbar />);

    expect(screen.queryByRole("status")).toBeNull();
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("压缩失败");
    expect(row.textContent).toContain("模型超时");

    fireEvent.click(row);
    expect(useChatStore.getState().compactions[SESSION.id]).toBeUndefined();
  });

  it("取消：一句话说明，点一下收掉", () => {
    seed({ phase: "cancelled", reason: "manual", startedAt: 1, endedAt: 2 });
    render(<ThreadToolbar />);

    const row = screen.getByRole("button");
    expect(row.textContent).toContain("压缩已取消");

    fireEvent.click(row);
    expect(useChatStore.getState().compactions[SESSION.id]).toBeUndefined();
  });

  it("完成态不会因为点击被清掉（摘要就是它存在的意义，只有失败/取消可点掉）", () => {
    seed({
      phase: "completed",
      reason: "manual",
      startedAt: 1,
      endedAt: 2,
      summaryPreview: "摘要",
      tokensBefore: 1000,
      retainedCount: 1,
    });
    render(<ThreadToolbar />);

    fireEvent.click(screen.getByRole("button"));
    expect(useChatStore.getState().compactions[SESSION.id]?.phase).toBe("completed");
  });

  it("别的会话在压缩，当前会话不受影响", () => {
    useChatStore.setState({
      sessions: [SESSION],
      activeSessionId: SESSION.id,
      compactions: { "s-other": { phase: "running", reason: "manual", startedAt: Date.now() } },
    });
    const { container } = render(<ThreadToolbar />);
    expect(container.firstChild).toBeNull();
  });
});
