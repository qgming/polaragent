/**
 * 工具详情的**外观一致性**检查（源码级）。
 *
 * ## 为什么需要它
 *
 * 本仓有一条既定外观约定：每个工具详情的外层是 `paper`（浅底 + 描边）+ `rounded-2xl`
 *（见 code-diff.tsx / terminal-block.tsx，那两个是这套外观的基准）。它由**各详情组件
 * 自己带**，不在 ToolCall 上统一套 —— 因为 pill 形态（子智能体 / 作业）根本不走 ToolCall。
 *
 * 问题在于：漏带是**静默**的。组件照常渲染、DOM 断言照常通过，只是展开区少一圈圆角边框，
 * 而那种缺陷只有肉眼看界面才会发现（「读取了网页」「更新了」两个就是这么漏的）。
 * 所以这里用源码检查兜住这条约定 —— 与 runtime.jobs.test.ts 里那条
 * 「notifyJobExit 不调 send」同一个手法：**防手滑，不当行为规格用**。
 *
 * 外观的**像素级**正确性由 scripts/probe-tool-details.mjs 在真实 Electron 里量。
 *
 * 源码用 Vite 的 `?raw` 读，**不用 `node:fs`**：渲染层的 tsconfig 刻意不装 node 类型，
 * 就是为了让「渲染层不许碰 Node API」这条边界在编译期成立（真写了 fs 会直接是类型错误）。
 * 测试文件也在那个 include 里，所以同样受这条约束 —— 这是对的，不该为测试破例。
 */

import { describe, expect, it } from "vitest";
import source from "./ToolParts.tsx?raw";

/**
 * 会渲染成「展开区内容」的详情组件，以及它们各自**外壳从哪来**。
 *
 * 两种形态都合法，但必须明确属于哪一种 —— 这一栏存在的意义就是让「漏壳」无处可藏：
 *   · `self`     —— 自己画 paper 外壳（多数详情是这样）；
 *   · `delegate` —— 把外壳交给一个**自带 paper 的元素组件**（CodeDiff / TerminalBlock 是
 *                  本仓这套外观的基准，它们自己带）。这两个是元素而不是详情，
 *                  所以不该在这里重复画第二层壳。
 *
 * 名单与源码必须一一对应（下面有一条断言盯它），所以新增 detail 时一定会被这里提醒。
 */
const DETAIL_COMPONENTS = {
  TerminalDetail: "delegate", // → TerminalBlock
  DiffDetail: "delegate", // → CodeDiff
  TextDetail: "self",
  WriteDetail: "self",
  AskDetail: "self",
  BrowserDetail: "self",
  TodoDetail: "self",
  WebSearchDetail: "self",
  WebFetchDetail: "self",
} as const satisfies Record<string, "self" | "delegate">;

/** 取一个顶层函数从声明到下一个顶层函数之间的正文 */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} 不见了 —— 名单过期了`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\nfunction ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("每个工具详情都有 paper 外壳（自己画，或交给自带外壳的元素）", () => {
  for (const [name, kind] of Object.entries(DETAIL_COMPONENTS)) {
    it(
      kind === "self"
        ? `${name} 的根元素带 paper + rounded-2xl`
        : `${name} 把外壳交给自带 paper 的元素`,
      () => {
        const body = functionBody(name);
        const returned = body.slice(body.indexOf("return ("));
        expect(returned, `${name} 里找不到 return (`).not.toBe("");

        if (kind === "self") {
          // paper 与 rounded-2xl 要出现在**根元素**那一处 class 里：
          // 只查「整个函数里有没有 paper」会被别处的引用骗过去
          const rootClass = returned.slice(0, returned.indexOf(">") + 1);
          expect(
            rootClass.includes("paper"),
            `${name} 的根元素没有 paper：展开区会少一圈圆角边框（这类漏壳只有肉眼看才发现）`,
          ).toBe(true);
          expect(
            rootClass.includes("rounded-2xl"),
            `${name} 的根元素没有 rounded-2xl：与 CodeDiff / TerminalBlock 的外观不一致`,
          ).toBe(true);
          return;
        }

        // delegate：必须真的把渲染交给那个元素组件，而不是自己拼一个
        const element = name === "DiffDetail" ? "CodeDiff" : "TerminalBlock";
        expect(
          returned.includes(`<${element}`),
          `${name} 应当把外壳交给 ${element}（它自带 paper + rounded-2xl）`,
        ).toBe(true);
      },
    );
  }

  it("名单没有过期：源码里每个叶子详情的组件都在名单里", () => {
    // 只取叶子详情（`*Detail`），排除三个分发器 —— 它们不渲染具体内容，
    // 只按 detail.kind 转发，外壳不属于它们
    const DISPATCHERS = new Set(["ResolvedDetail", "PartDetail", "StepDetail"]);
    const declared = [...source.matchAll(/^function (\w+Detail)\(/gm)]
      // noUncheckedIndexedAccess：捕获组按类型可能缺席，滤掉而不是硬断言
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined && !DISPATCHERS.has(name));

    expect(new Set(declared)).toEqual(new Set(Object.keys(DETAIL_COMPONENTS)));
  });
});
