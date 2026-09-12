import { describe, expect, it } from "vitest";
import {
  distanceFromBottom,
  nextStickState,
  STICK_RESUME_DELAY_MS,
  STICK_THRESHOLD_PX,
} from "./use-stick-to-bottom";

describe("distanceFromBottom", () => {
  it("按 scrollHeight - scrollTop - clientHeight 计算", () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 })).toBe(100);
  });

  it("内容不满一屏时钳到 0（否则会出现负数被当成「已到底」以外的东西）", () => {
    expect(distanceFromBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 })).toBe(0);
  });
});

describe("nextStickState", () => {
  const base = { previousScrollTop: 400, scrollTop: 400, distance: 0, following: true };

  it("向上滑一下立刻停止跟随 —— 即使位置仍在底部阈值内", () => {
    // 这是最关键的一条：底部边缘向上滑 2px 也必须停，否则「自由滚动」立不住
    const decision = nextStickState({ ...base, scrollTop: 398, distance: 2, following: true });

    expect(decision).toEqual({ following: false, scheduleResume: false });
  });

  it("向上滑时作废待恢复（不再排定时器）", () => {
    const decision = nextStickState({
      ...base,
      scrollTop: 100,
      distance: 300,
      following: false,
    });

    expect(decision.scheduleResume).toBe(false);
  });

  it("不在底部且未上滑（内容变高）→ 保持不跟随，也不排恢复", () => {
    const decision = nextStickState({ ...base, distance: 300, following: false });

    expect(decision).toEqual({ following: false, scheduleResume: false });
  });

  it("滚到最底部且当前未跟随 → 排一次恢复（稍等片刻再跟随）", () => {
    const decision = nextStickState({ ...base, distance: 0, following: false });

    expect(decision).toEqual({ following: false, scheduleResume: true });
  });

  it("已经在跟随且仍在底部 → 不重复排恢复", () => {
    const decision = nextStickState({ ...base, distance: 0, following: true });

    expect(decision).toEqual({ following: true, scheduleResume: false });
  });

  it("向下滚但还没到底 → 不恢复（这正是库里空分支导致「被抢滚动」的地方）", () => {
    const decision = nextStickState({
      previousScrollTop: 100,
      scrollTop: 150,
      distance: THRESHOLD_PLUS_ONE,
      following: false,
    });

    expect(decision).toEqual({ following: false, scheduleResume: false });
  });

  it("首次滚动（没有基线）不当作向上滑", () => {
    const decision = nextStickState({
      previousScrollTop: null,
      scrollTop: 0,
      distance: 0,
      following: true,
    });

    expect(decision).toEqual({ following: true, scheduleResume: false });
  });

  it("阈值边界：正好等于阈值算「在底部」", () => {
    const atThreshold = nextStickState({ ...base, distance: STICK_THRESHOLD_PX, following: false });
    const overThreshold = nextStickState({
      ...base,
      distance: STICK_THRESHOLD_PX + 1,
      following: false,
    });

    expect(atThreshold.scheduleResume).toBe(true);
    expect(overThreshold.scheduleResume).toBe(false);
  });
});

/** 阈值 + 1：明确「不在底部」的最小距离 */
const THRESHOLD_PLUS_ONE = STICK_THRESHOLD_PX + 1;

describe("常量", () => {
  it("恢复延迟是个「稍等片刻」量级的值", () => {
    expect(STICK_RESUME_DELAY_MS).toBeGreaterThan(0);
    expect(STICK_RESUME_DELAY_MS).toBeLessThan(1000);
  });
});
