// ref 模型 v2 的判定单测（docs/browser-automation-refactor.md §3）。
//
// 这里测的是「点错元素」事故唯一的防线：服务侧 ref 账本。
// 三种失败必须分开，因为模型的下一步动作完全不同：
//   UNKNOWN_REF —— 这个号不是我发的（编造 / 上一份页面）→ 立刻重新 snapshot；
//   STALE_REF   —— 号是我发的，但元素已经从 DOM 移除 → 重新 snapshot，旧号不会恢复；
//   REF_DRIFT   —— 元素还在，但语义和快照记录的不一致（节点被复用）→ 核对后再动，
//                  按旧号硬点可能点到别的东西上。
// 页面侧的发号不变式（DOM 稳定不漂移、编号不复用）在 dom-scripts.test.ts 用真 DOM 验证。

import { describe, expect, it } from "vitest";
import { elementSignature, isWellFormedRef, RefRegistry } from "./refs";

describe("isWellFormedRef", () => {
  it("只认 `e` + 数字；其余一律按「模型编造」处理，连页面都不必问", () => {
    expect(isWellFormedRef("e0")).toBe(true);
    expect(isWellFormedRef("e1")).toBe(true);
    expect(isWellFormedRef("e12")).toBe(true);
    expect(isWellFormedRef("E1")).toBe(false);
    expect(isWellFormedRef("e")).toBe(false);
    expect(isWellFormedRef("e1x")).toBe(false);
    expect(isWellFormedRef("ref1")).toBe(false);
    expect(isWellFormedRef("")).toBe(false);
    expect(isWellFormedRef("e1 ")).toBe(false);
    // 页面属性值曾经被当成 ref 的那类字符串：格式不合法就一定不是我们发的
    expect(isWellFormedRef('x"],[data-oint-ref="decoy')).toBe(false);
  });
});

describe("elementSignature", () => {
  it("按 role|tag|type|name 拼接；缺项当空串，不让 undefined 混进签名", () => {
    expect(elementSignature({ role: "button", tag: "button", type: "", name: "提交" })).toBe(
      "button|button||提交",
    );
    expect(elementSignature({})).toBe("|||");
  });

  it("折叠空白：HTML 里的换行不该造成假 REF_DRIFT", () => {
    expect(elementSignature({ role: " link ", tag: "a", name: "  A\n  B " })).toBe("link|a||A B");
  });
});

describe("RefRegistry", () => {
  /** 快照记录的那份签名 */
  const SNAPSHOT_SIGNATURE = "button|button||提交";

  it("beginSnapshot 自增代次；since 记录首次出现的代次、之后不再刷新", () => {
    const registry = new RefRegistry();
    expect(registry.generation).toBe(0);

    expect(registry.beginSnapshot()).toBe(1);
    registry.note("e1", SNAPSHOT_SIGNATURE);
    expect(registry.since("e1")).toBe(1);

    expect(registry.beginSnapshot()).toBe(2);
    registry.note("e1", SNAPSHOT_SIGNATURE); // 再次见到不刷新 since
    expect(registry.since("e1")).toBe(1);

    registry.note("e2", SNAPSHOT_SIGNATURE);
    expect(registry.since("e2")).toBe(2);
    expect(registry.since("e9")).toBeUndefined();
  });

  it("ref 格式不合法 → UNKNOWN_REF（账本里有没有它都无所谓）", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    registry.note("e1", SNAPSHOT_SIGNATURE);
    expect(registry.check("decoy", SNAPSHOT_SIGNATURE)).toMatchObject({
      ok: false,
      code: "UNKNOWN_REF",
    });
  });

  it("从未见过的 ref → UNKNOWN_REF（模型编造 / 上一份页面）；页面里也找不到是同一个结论", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    expect(registry.check("e9", SNAPSHOT_SIGNATURE)).toMatchObject({
      ok: false,
      code: "UNKNOWN_REF",
    });
    expect(registry.check("e9", null)).toMatchObject({ ok: false, code: "UNKNOWN_REF" });
  });

  it("元素被移除（页面侧签名为 null）→ STALE_REF，并提示重新 snapshot", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    registry.note("e1", SNAPSHOT_SIGNATURE);

    const check = registry.check("e1", null);

    expect(check).toMatchObject({ ok: false, code: "STALE_REF" });
    if (check.ok) throw new Error("预期失败");
    expect(check.message).toContain("曾经有效");
    expect(check.message).toContain("重新 browser_snapshot");
  });

  it("元素还在但签名变了 → REF_DRIFT（节点被框架复用）", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    registry.note("e1", SNAPSHOT_SIGNATURE);

    const check = registry.check("e1", "link|a||别的链接");

    expect(check).toMatchObject({ ok: false, code: "REF_DRIFT" });
    if (check.ok) throw new Error("预期失败");
    expect(check.message).toContain("复用");
    expect(check.message).toContain("提交");
  });

  it("签名一致才放行（放行的是「同一个元素」，不是「同一个编号」）", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    registry.note("e1", SNAPSHOT_SIGNATURE);
    expect(registry.check("e1", SNAPSHOT_SIGNATURE)).toEqual({ ok: true });
  });

  it("pruneExcept 只丢不在 live 里的 ref；被清掉后再核对就是 UNKNOWN_REF", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    registry.note("e1", SNAPSHOT_SIGNATURE);
    registry.note("e2", SNAPSHOT_SIGNATURE);
    expect(registry.size).toBe(2);

    registry.pruneExcept(new Set(["e2"]));

    expect(registry.size).toBe(1);
    expect(registry.check("e1", null)).toMatchObject({ ok: false, code: "UNKNOWN_REF" });
    expect(registry.check("e1", SNAPSHOT_SIGNATURE)).toMatchObject({
      ok: false,
      code: "UNKNOWN_REF",
    });
    expect(registry.check("e2", SNAPSHOT_SIGNATURE)).toEqual({ ok: true });
  });

  it("账本有上限：超过上限时丢最早出现的 ref（长期会话不会无限增长）", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    for (let index = 0; index < 5000; index += 1) registry.note(`e${index}`, SNAPSHOT_SIGNATURE);

    expect(registry.size).toBeLessThan(5000);
    // 最早的 e0 被挤掉了：它只能重新 snapshot，而最新的 e4999 仍然有效
    expect(registry.check("e0", SNAPSHOT_SIGNATURE)).toMatchObject({
      ok: false,
      code: "UNKNOWN_REF",
    });
    expect(registry.check("e4999", SNAPSHOT_SIGNATURE)).toEqual({ ok: true });
  });

  it("clear 清空账本（换文档 / 退出时用）", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot();
    registry.note("e1", SNAPSHOT_SIGNATURE);

    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.since("e1")).toBeUndefined();
    expect(registry.check("e1", SNAPSHOT_SIGNATURE)).toMatchObject({
      ok: false,
      code: "UNKNOWN_REF",
    });
  });
});
