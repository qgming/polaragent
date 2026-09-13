/**
 * 「按 seq 连续写出」的回归测试。
 *
 * 这几条覆盖的都是**曾经真实出错**的场景：切标签回来只剩后半段输出、
 * 回放与实时推送叠加导致同一段写两次、游标被回放往回带。
 * 纯函数 + 纯数据，所以放在 node project 里跑，不需要 DOM。
 */

import { describe, expect, it } from "vitest";
import type { TerminalChunk } from "@/shared/contracts/terminal";
import { drainQueue, FIRST_SEQ, sortChunks } from "./terminal-queue";

/** 造一段输出：seq 从 from 开始，内容就是 seq 本身，便于断言顺序 */
function chunks(...seqs: number[]): TerminalChunk[] {
  return seqs.map((seq) => ({ seq, data: `d${seq}` }));
}

describe("drainQueue", () => {
  it("从初始游标（FIRST_SEQ）起整段写出：新实例整份重放的场景", () => {
    const queue = chunks(1, 2, 3);
    const result = drainQueue(queue, FIRST_SEQ);
    expect(result.writable.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(result.cursor).toBe(4);
    expect(result.remaining).toEqual([]);
  });

  it("seq 小于游标的段被丢弃（回放已写过，不能重复写）", () => {
    // 游标 3 说明 1、2 已经写过；队列里那两段是重复内容
    const result = drainQueue(chunks(1, 2, 3), 3);

    expect(result.writable.map((c) => c.seq)).toEqual([3]);
    expect(result.cursor).toBe(4);
    expect(result.remaining).toEqual([]);
  });

  it("遇到缺口就停下并保留剩余（等回放补齐再继续）", () => {
    // 游标在 FIRST_SEQ，但队列里直接跳到 5：1..4 还没到，只能先等
    const result = drainQueue(chunks(5, 6), FIRST_SEQ);

    expect(result.writable).toEqual([]);
    expect(result.cursor).toBe(FIRST_SEQ);
    expect(result.remaining.map((c) => c.seq)).toEqual([5, 6]);
  });

  it("游标传 0（忘了初始化的情形）也会被夹到 FIRST_SEQ，不会卡死", () => {
    // 这条是防回归：真发生过 —— 初始游标写成 0 时第一段被当成缺口，
    // 终端一片空白且永远不刷新
    const result = drainQueue(chunks(1, 2), 0);

    expect(result.writable.map((c) => c.seq)).toEqual([1, 2]);
    expect(result.cursor).toBe(3);
  });

  it("重复段 + 连续段 + 缺口混在一起时各自处理正确", () => {
    // 冲突最激烈的一种：回放与实时推送交叉到达
    const result = drainQueue(chunks(1, 2, 3, 9, 10), 3);

    // 1、2 是重复的（丢掉），3 连续（写出），9、10 隔着缺口（留着）
    expect(result.writable.map((c) => c.seq)).toEqual([3]);
    expect(result.cursor).toBe(4);
    expect(result.remaining.map((c) => c.seq)).toEqual([9, 10]);
  });

  it("空队列是空操作（游标不动）", () => {
    const result = drainQueue([], 7);

    expect(result.writable).toEqual([]);
    expect(result.cursor).toBe(7);
    expect(result.remaining).toEqual([]);
  });

  it("两批合流后按 seq 写出且不重复（先回放、后事件同一段）", () => {
    // 模拟：回放返回 1..3，紧接着同一段又以事件形式到达
    const replay = chunks(1, 2, 3);
    const first = drainQueue(replay, FIRST_SEQ);
    expect(first.writable.map((c) => c.seq)).toEqual([1, 2, 3]);

    // 事件重放同样的 3，游标已是 4 → 全部丢弃，绝不写第二遍
    const second = drainQueue(chunks(3), first.cursor);
    expect(second.writable).toEqual([]);
    expect(second.cursor).toBe(4);
  });

  it("缺口被后续批次补上后，之前留下的段才写出（顺序不倒置）", () => {
    // 第一帧：只有 3 到了（1、2 还在回放路上）
    const pending = drainQueue(chunks(3), FIRST_SEQ);
    expect(pending.writable).toEqual([]);

    // 回放把 1..3 带回来 → 全部按序写出
    const afterReplay = drainQueue(chunks(1, 2, 3), FIRST_SEQ);
    expect(afterReplay.writable.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(afterReplay.cursor).toBe(4);
    expect(afterReplay.remaining).toEqual([]);
  });
});

describe("sortChunks", () => {
  it("乱序输入按 seq 升序输出，且不改动原数组", () => {
    const input = chunks(3, 1, 2);
    const sorted = sortChunks(input);

    expect(sorted.map((c) => c.seq)).toEqual([1, 2, 3]);
    // 原数组保持原样（纯函数，调用处不必担心被就地改掉）
    expect(input.map((c) => c.seq)).toEqual([3, 1, 2]);
  });
});
