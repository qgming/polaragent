// 重复调用守卫的单测。
//
// 这个模块的错误方式**全都是静默的**：参数不排序 → 永远不触发；阈值判成 >= →
// 每轮都刷屏；排除名单写成「重置链」→ 穿插一个 todo 就洗白循环。
// 所以这里逐条钉死，而不是只测「正常路径能触发」。
//
// 另外，生态里有一个必须引以为戒的案例：Goose 的 RepetitionInspector 代码完全正确，
// 但生产环境用 `RepetitionInspector::new(None)` 构造，检查直接短路返回 allow ——
// **写了但永远不跑**。所以「证明它真的会触发」比「证明它不误报」更重要。

import type { JsonValue } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRepeatChain,
  hardRepeatReason,
  inspectRepeat,
  REPEAT_HARD_THRESHOLD,
  REPEAT_SOFT_THRESHOLD,
  type RepeatChain,
  repeatKey,
  softRepeatNotice,
} from "./repeat-guard";

/** 把同一组参数连续喂 N 次，收集每一次的判定 */
function feed(
  chain: RepeatChain,
  times: number,
  tool = "read",
  args: Record<string, JsonValue> = {},
): ReturnType<typeof inspectRepeat>[] {
  const verdicts: ReturnType<typeof inspectRepeat>[] = [];
  for (let index = 0; index < times; index += 1) verdicts.push(inspectRepeat(chain, tool, args));
  return verdicts;
}

let chain: RepeatChain;

beforeEach(() => {
  chain = createRepeatChain();
});

describe("阈值：3 提醒 / 5 终止", () => {
  it("**真的会触发**：第 3 次出软档、第 5 次出硬档", () => {
    const verdicts = feed(chain, 5);

    expect(verdicts[0]).toBeNull();
    expect(verdicts[1]).toBeNull();
    expect(verdicts[2]).toMatchObject({ level: "soft", count: 3 });
    expect(verdicts[3]).toBeNull();
    expect(verdicts[4]).toMatchObject({ level: "hard", count: 5 });
  });

  it("每一档只报一次，不在第 4、6、7… 次重复时刷屏", () => {
    const verdicts = feed(chain, 10);
    const spoken = verdicts.filter((item) => item !== null);

    expect(spoken).toHaveLength(2);
    expect(spoken.map((item) => item?.level)).toEqual(["soft", "hard"]);
  });

  it("常量与生态共识一致（3 软 / 5 硬）", () => {
    // 写死这两个数是有意的：改动它们等于改动一条被四家印证过的行为阈值，
    // 应当是一次有意识的决定，而不是顺手调参
    expect(REPEAT_SOFT_THRESHOLD).toBe(3);
    expect(REPEAT_HARD_THRESHOLD).toBe(5);
  });
});

describe("签名：键顺序无关（不排序 = 静默永不触发）", () => {
  it("键顺序不同但内容相同的参数，算**同一次**调用", () => {
    const a = repeatKey("edit", { path: "a.ts", oldText: "x" });
    const b = repeatKey("edit", { oldText: "x", path: "a.ts" });
    expect(a).toBe(b);
  });

  it("嵌套对象的键顺序也不影响", () => {
    const a = repeatKey("bash", { opts: { cwd: "/w", env: { B: "2", A: "1" } } });
    const b = repeatKey("bash", { opts: { env: { A: "1", B: "2" }, cwd: "/w" } });
    expect(a).toBe(b);
  });

  it("于是「同内容不同键序」的一串调用能一路走到硬档", () => {
    // 这条才是键排序的意义：不排序的话每次签名都不同，计数永远是 1
    inspectRepeat(chain, "edit", { path: "a.ts", oldText: "x" });
    inspectRepeat(chain, "edit", { oldText: "x", path: "a.ts" });
    const third = inspectRepeat(chain, "edit", { path: "a.ts", oldText: "x" });
    expect(third).toMatchObject({ level: "soft", count: 3 });
  });

  it("数组保持原顺序：edits 的顺序不同就是两次不同的调用", () => {
    const a = repeatKey("edit", { edits: [{ oldText: "x" }, { oldText: "y" }] });
    const b = repeatKey("edit", { edits: [{ oldText: "y" }, { oldText: "x" }] });
    expect(a).not.toBe(b);
  });

  it("工具名不同就是不同的调用（同名同参数才算重复）", () => {
    expect(repeatKey("read", { path: "a" })).not.toBe(repeatKey("write", { path: "a" }));
  });
});

describe("链的变化", () => {
  it("参数变了就归零：正当的重试（改参数）不该被算作重复", () => {
    inspectRepeat(chain, "read", { path: "a.ts" });
    inspectRepeat(chain, "read", { path: "a.ts" });
    const changed = inspectRepeat(chain, "read", { path: "b.ts" });

    expect(changed).toBeNull();
    expect(chain.count).toBe(1);
  });

  it("换了工具名也归零", () => {
    feed(chain, 2, "read", { path: "a" });
    expect(inspectRepeat(chain, "grep", { pattern: "a" })).toBeNull();
    expect(chain.count).toBe(1);
  });

  it("链被打断之后重新计数：新的循环照样能被发现", () => {
    feed(chain, 5, "read", { path: "a" }); // 走到硬档

    // 换一组参数把链打断（现实里就是模型改了参数）——
    // **这一次本身就算新链的第 1 次**，所以再喂 2 次就到软档
    expect(inspectRepeat(chain, "read", { path: "b" })).toBeNull();
    expect(chain.count).toBe(1);

    const restarted = feed(chain, 2, "read", { path: "b" });
    expect(restarted[1]).toMatchObject({ level: "soft", count: 3 });
  });
});

describe("排除名单：对链透明（不计也不清）", () => {
  it("穿插 todo 不打断链：grep X → todo → grep X → todo → grep X 仍算连续三次", () => {
    inspectRepeat(chain, "grep", { pattern: "X" });
    expect(inspectRepeat(chain, "todo", { todos: [] })).toBeNull();
    inspectRepeat(chain, "grep", { pattern: "X" });
    expect(inspectRepeat(chain, "todo", { todos: [] })).toBeNull();
    // 第三次**参与计数**的 grep —— 中间那两个 todo 对链透明
    const third = inspectRepeat(chain, "grep", { pattern: "X" });
    expect(third).toMatchObject({ level: "soft", count: 3 });
  });

  it("todo 自己怎么重复都不会触发（整表替换会合法地反复调用）", () => {
    const verdicts = feed(chain, 10, "todo", { todos: [] });
    expect(verdicts.every((item) => item === null)).toBe(true);
  });
});

describe("产出的文本", () => {
  it("软档消息点名工具、次数与参数，并给出出路", () => {
    const text = softRepeatNotice("read", 3, '{"path":"a.ts"}');

    expect(text).toContain("read");
    expect(text).toContain("3");
    expect(text).toContain('{"path":"a.ts"}');
    // 只说「你在重复」不够：模型要知道在重复什么、以及可以怎么办
    expect(text).toContain("换一个做法");
    expect(text).toContain("结束");
  });

  it("硬档原因说清「这是异常」，而不是「跑太久了」", () => {
    const text = hardRepeatReason("read", 5);

    expect(text).toContain("重复调用");
    expect(text).toContain("5");
    expect(text).toContain("read");
  });

  it("参数过长时截断并标注省略了多少（不把整份文件塞进提醒）", () => {
    const long = "x".repeat(1000);
    inspectRepeat(chain, "write", { path: "a", content: long });
    inspectRepeat(chain, "write", { path: "a", content: long });
    const verdict = inspectRepeat(chain, "write", { path: "a", content: long });

    expect(verdict?.level).toBe("soft");
    if (verdict?.level !== "soft") throw new Error("unreachable");
    expect(verdict.argsText.length).toBeLessThan(400);
    expect(verdict.argsText).toContain("more chars");
  });
});
