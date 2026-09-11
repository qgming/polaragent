import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui-store";

describe("搜索跳转", () => {
  beforeEach(() => {
    useUiStore.setState({ searchJump: null });
  });

  it("记录目标会话与消息", () => {
    useUiStore.getState().jumpToMessage("s1", "m1");
    expect(useUiStore.getState().searchJump).toMatchObject({ sessionId: "s1", messageId: "m1" });
  });

  it("重复跳同一条也换新的 token：Thread 靠它重新定位", () => {
    useUiStore.getState().jumpToMessage("s1", "m1");
    const first = useUiStore.getState().searchJump?.token;
    useUiStore.getState().jumpToMessage("s1", "m1");
    const second = useUiStore.getState().searchJump?.token;
    expect(second).not.toBe(first);
  });

  it("清空后再次跳同一目标，token 仍不与上次重复 —— 否则会撞上已消费的记录而不再滚动", () => {
    useUiStore.getState().jumpToMessage("s1", "m1");
    const first = useUiStore.getState().searchJump?.token;
    useUiStore.getState().clearSearchJump();
    expect(useUiStore.getState().searchJump).toBeNull();
    useUiStore.getState().jumpToMessage("s1", "m1");
    expect(useUiStore.getState().searchJump?.token).not.toBe(first);
  });

  it("token 单调递增", () => {
    const tokens: number[] = [];
    for (const id of ["a", "b", "c"]) {
      useUiStore.getState().jumpToMessage("s1", id);
      const token = useUiStore.getState().searchJump?.token;
      if (token !== undefined) tokens.push(token);
    }
    expect(tokens).toEqual([...tokens].sort((x, y) => x - y));
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
