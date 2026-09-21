// 子智能体面板的转录取数规则。
//
// 这一组是一次真实缺陷的回归守卫。缺陷表现：**子智能体列表有轮次与工具调用次数，
// 详情里却一直没有会话内容**，直到跑完 report 才看得到东西。
//
// 原因是两个数据源分家：
//   · 轮次 / 工具次数来自 run-updated 事件（实时）；
//   · 转录来自 subagent-store.childMessages —— 一次 IPC 读盘 + **永久闩死**。
// 而 subagent-runner 当时先 publish 再 send，于是那次读盘读到的是一条刚建好、
// 还没有任何消息的子会话，拿到空数组后就再也不刷新。
//
// 修法：面板优先读 `chat-store.messagesBySession[childSessionId]` —— 子会话的
// `chat:event` 与主会话走同一条通路，那份数据**本来就是实时流式的**，只是没人读。
//
// 这里测的是纯选择逻辑（抽成 pickTranscript），因为组件渲染在本仓库没有测试设施。

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts/session";
import { pickTranscript } from "./subagent-transcript";

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id,
    role,
    createdAt: 0,
    parts: [{ type: "text", text }],
    status: "complete",
  } as ChatMessage;
}

const TASK = message("m1", "user", "看 src/retry.ts 的重试逻辑");
const ANSWER = message("m2", "assistant", "报告正文");
const ANSWER2 = message("m3", "assistant", "第二段");

describe("pickTranscript", () => {
  it("实时比落盘长时用实时（流式期间的关键路径）", () => {
    const live = [TASK, ANSWER, ANSWER2];
    const persisted = [TASK];
    expect(pickTranscript(live, persisted)).toEqual(live.slice(1));
  });

  it("落盘比实时长时用落盘（冷启动 / 重启后内存里没有事件）", () => {
    const live: ChatMessage[] = [];
    const persisted = [TASK, ANSWER, ANSWER2];
    expect(pickTranscript(live, persisted)).toEqual(persisted.slice(1));
  });

  it("两边一样长时用实时（内容相同但实时的引用更稳，避免多余重渲）", () => {
    const live = [TASK, ANSWER];
    const persisted = [TASK, ANSWER];
    expect(pickTranscript(live, persisted)).toEqual(live.slice(1));
  });

  /**
   * 去掉开头那条任务消息。
   *
   * 子会话的第一条消息**就是那次 Task 的任务文本**（runner 把它当 prompt 发出去），
   * 而面板上方已经有一个「任务」区块在显示同一段文字 —— 两处重复。
   */
  it("去掉开头的用户消息（它就是面板上方那个「任务」区块）", () => {
    const result = pickTranscript([TASK, ANSWER], []);
    expect(result).toEqual([ANSWER]);
  });

  it("落盘路径同样去掉开头的任务消息", () => {
    expect(pickTranscript([], [TASK, ANSWER])).toEqual([ANSWER]);
  });

  it("第一条不是用户消息时不动它（子会话可能直接以助手消息开头）", () => {
    const result = pickTranscript([ANSWER, ANSWER2], []);
    expect(result).toEqual([ANSWER, ANSWER2]);
  });

  it("只有任务消息一条时返回空（上方区块已经在显示它了）", () => {
    expect(pickTranscript([TASK], [])).toEqual([]);
  });

  it("只去掉**开头**那一条：后面的用户消息（插话）保留", () => {
    const interjection = message("m4", "user", "再查一下边界情况");
    const result = pickTranscript([TASK, ANSWER, interjection, ANSWER2], []);
    expect(result).toEqual([ANSWER, interjection, ANSWER2]);
  });

  it("两边都空时返回空数组（不抛）", () => {
    expect(pickTranscript([], [])).toEqual([]);
  });

  it("不修改传入的数组（两条来源都是 store 里的共享引用）", () => {
    const live = [TASK, ANSWER];
    const persisted = [ANSWER];
    pickTranscript(live, persisted);
    expect(live).toHaveLength(2);
    expect(persisted).toHaveLength(1);
  });
});
