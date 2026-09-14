// 浏览器工具的行为测试：只覆盖**不依赖 Electron** 的那一层。
//
// 重点验两件容易写错的事：
//   1. **串行化**。内核默认并行执行工具调用，而 click/type 是「移鼠标 → 按下 → 抬起」
//      三步。若两次调用交错，坐标与按键会落到错误的元素上（表现为随机点错东西）。
//      这条测试用「记录进出顺序」把串行保证钉死 —— 它一旦被删掉，问题只会在真机上
//      偶发，且极难归因。
//   2. **提示条计数**。并行时先结束的那个不该把「模型正在操作页面」清掉。
//
// 真实的页面行为（快照内容、点击坐标）留给端到端验收：那是 Electron 里的时序，
// 在这里假装测它只会制造「测试通过但功能坏了」的假象。

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  BROWSER_TOOL_NAMES,
  type BrowserConsoleReport,
  type BrowserDialogPolicy,
  type BrowserErrorCode,
  type BrowserNetworkReport,
  type BrowserWaitResult,
} from "@/shared/contracts/browser";
import type {
  BrowserActionOutcome,
  BrowserAutomation,
  BrowserOptionMatch,
  BrowserPressOutcome,
  BrowserSelectOutcome,
} from "../../browser/types";
import { createBrowserTools } from "./browser";

/** 一个可观测的假实现：记录每个操作的进出顺序与活跃标记的变化 */
function trackingAutomation(
  options: {
    delayMs?: number;
    /** 覆盖 wait 的返回值：超时分文的用例要把它改成 matched: false */
    wait?: BrowserWaitResult;
    /** 覆盖 network 的返回值：空缓冲 / 无失败 / 有省略的用例按需给 */
    network?: BrowserNetworkReport;
    /** 覆盖 console 的返回值：Electron 噪音被过滤的用例按需给 */
    console?: BrowserConsoleReport;
  } = {},
) {
  const events: string[] = [];
  let activeDepth = 0;
  const maxActiveDepth = { value: 0 };

  /** 模拟一次耗时操作，并在期间标记「正在操作」 */
  async function act(name: string): Promise<void> {
    activeDepth += 1;
    maxActiveDepth.value = Math.max(maxActiveDepth.value, activeDepth);
    events.push(`enter:${name}`);
    await new Promise((r) => setTimeout(r, options.delayMs ?? 5));
    events.push(`exit:${name}`);
    activeDepth -= 1;
  }

  const automation = {
    setAgentActive: (active: boolean) => {
      // 工具层应该「先加后减」：这里只看它有没有在计数归零前误报
      if (!active && activeDepth > 0) events.push("cleared-while-busy");
    },
    status: () => ({
      open: true,
      state: {
        url: "https://example.com/",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      agentActive: true,
    }),
    open: async () => {
      await act("open");
      return {
        url: "https://example.com/",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
    },
    history: async () => {
      await act("history");
      return {
        url: "https://example.com/",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
    },
    snapshot: async () => {
      await act("snapshot");
      return {
        url: "https://example.com/",
        title: "Example",
        generation: 1,
        text: "hi",
        truncated: false,
        elements: [],
      };
    },
    click: async (ref: string): Promise<BrowserActionOutcome> => {
      await act(`click:${ref}`);
      return { name: "button", navigated: false, effect: "hit" };
    },
    type: async (ref: string): Promise<BrowserActionOutcome> => {
      await act(`type:${ref}`);
      return { name: "field", navigated: false, effect: "hit" };
    },
    press: async (key: string, ref?: string): Promise<BrowserPressOutcome> => {
      await act(`press:${key}`);
      return {
        name: ref === undefined ? "" : "button",
        navigated: false,
        keys: key.toLowerCase(),
        effect: "hit",
      };
    },
    hover: async (ref: string): Promise<BrowserActionOutcome> => {
      await act(`hover:${ref}`);
      return { name: "menu", navigated: false, effect: "hit" };
    },
    select: async (ref: string, match: BrowserOptionMatch): Promise<BrowserSelectOutcome> => {
      await act(`select:${ref}`);
      return {
        name: "country",
        navigated: false,
        effect: "hit",
        value: match.kind === "value" ? match.value : "us",
        label: "United States",
      };
    },
    wait: async () => {
      await act("wait");
      return options.wait ?? { matched: true, waitedMs: 12, detail: "the element is visible now" };
    },
    screenshot: async () => {
      await act("screenshot");
      return { data: "AAAA", mimeType: "image/png" as const, width: 10, height: 10 };
    },
    console: async (): Promise<BrowserConsoleReport> => {
      await act("console");
      return options.console ?? { entries: [], dropped: 0 };
    },
    network: async (): Promise<BrowserNetworkReport> => {
      await act("network");
      return (
        options.network ?? {
          entries: [
            {
              url: "https://example.com/api/items",
              method: "POST",
              status: 500,
              resourceType: "fetch",
              durationMs: 120,
              at: 1,
            },
            {
              url: "https://cdn.example.com/app.js",
              method: "GET",
              status: 0,
              resourceType: "script",
              error: "net::ERR_CONNECTION_RESET",
              durationMs: 0,
              at: 2,
            },
          ],
          total: 2,
          omitted: 0,
          bufferEmpty: false,
          noFailures: false,
        }
      );
    },
    dialog: async (policy: BrowserDialogPolicy) => {
      await act("dialog");
      return { policy, handledSinceLastRead: 0 };
    },
    evaluate: async () => {
      await act("evaluate");
      return { ok: true as const, value: '"x"' };
    },
  };
  return { automation: automation as unknown as BrowserAutomation, events, maxActiveDepth };
}

/** 调用一个工具并取回给模型看的文本（要断言文案的用例用它） */
async function callText(
  tools: AgentHarnessTool<ExecutionToolContext>[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`缺少工具 ${name}`);
  const result = await tool.execute(
    "t1",
    args as never,
    (() => undefined) as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const part = result.content[0];
  if (part === undefined || part.type !== "text") throw new Error(`${name} 没有返回文本`);
  return part.text;
}

/** 取出某个工具并调用它（参数按各自 schema 给最小合法值） */
async function call(
  tools: AgentHarnessTool<ExecutionToolContext>[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await callText(tools, name, args);
}

/** 调用一个工具并取回它抛出的错误文案（参数校验的用例用它） */
async function callError(
  tools: AgentHarnessTool<ExecutionToolContext>[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  try {
    await call(tools, name, args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${name} 本应报错，却成功了`);
}

/**
 * 造一个主进程风格的 BrowserToolError。
 *
 * 刻意不 import src/main/browser/errors.ts 的类：工具层是靠**结构**（code 在冻结的
 * 错误码名单里 + detail）识别失败的，测试也按同一口径构造 —— 这样两侧可以各自
 * 独立落地，而这条契约（字段名与错误码）仍然被钉死在这里。
 */
function browserFailure(
  code: BrowserErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): Error {
  const error = new Error(message) as Error & {
    code: BrowserErrorCode;
    detail?: Record<string, unknown>;
  };
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** 假实现 + 按需让某个方法抛错（失败渲染的用例用它） */
function automationThrowing(method: string, error: Error): BrowserAutomation {
  const { automation } = trackingAutomation();
  return {
    ...(automation as unknown as Record<string, unknown>),
    [method]: async () => {
      throw error;
    },
  } as unknown as BrowserAutomation;
}

/** 假实现 + 覆盖某个方法的返回值（成功路径字段渲染的用例用它） */
function automationReturning(method: string, value: unknown): BrowserAutomation {
  const { automation } = trackingAutomation();
  return {
    ...(automation as unknown as Record<string, unknown>),
    [method]: async () => value,
  } as unknown as BrowserAutomation;
}

describe("浏览器工具", () => {
  it("并发调用被串行化：不会交错执行（否则鼠标事件会落到错误元素上）", async () => {
    const { automation, events } = trackingAutomation({ delayMs: 10 });
    const tools = createBrowserTools(automation);

    // 同时发起三个调用（内核默认就是并行执行工具调用）
    await Promise.all([
      call(tools, "browser_click", { ref: "e1" }),
      call(tools, "browser_type", { ref: "e2", text: "hello" }),
      call(tools, "browser_snapshot"),
    ]);

    // 串行的判据：进出严格成对交替，绝不出现 enter A → enter B → exit A
    //（那正是「交错的鼠标序列」的形态）
    let depth = 0;
    for (const event of events) {
      if (event.startsWith("enter:")) {
        expect(depth, `交错执行了：${events.join(" → ")}`).toBe(0);
        depth += 1;
      } else if (event.startsWith("exit:")) {
        expect(depth, `交错执行了：${events.join(" → ")}`).toBe(1);
        depth -= 1;
      }
    }
    expect(events).toHaveLength(6);
  });

  it("14 个工具全都在同一条串行链上（少包一个都要红）", async () => {
    const { automation, events } = trackingAutomation({ delayMs: 5 });
    const tools = createBrowserTools(automation);

    // 每个工具的最小合法参数。这里刻意不看返回内容，只看**进出顺序** ——
    // 「模型正在操作页面」的提示条与串行保证都是靠这一层，漏包一个工具就会让
    // 两次点击序列有机会交错，而那在真机上表现为「随机点错东西」，极难归因。
    const args: Record<string, Record<string, unknown>> = {
      browser_open: { url: "example.com" },
      browser_history: { action: "back" },
      browser_snapshot: {},
      browser_click: { ref: "e1" },
      browser_type: { ref: "e1", text: "hi" },
      browser_press: { key: "Enter" },
      browser_hover: { ref: "e1" },
      browser_select: { ref: "e1", value: "us" },
      browser_wait: { text: "done" },
      browser_screenshot: {},
      browser_console: {},
      browser_network: {},
      browser_dialog: { action: "dismiss" },
      browser_evaluate: { code: "1" },
    };

    // 一起发出去（内核默认并行执行工具调用）；个别工具抛错也无所谓，
    // 要看的是「无论成败，进出都不交错」。
    await Promise.allSettled(tools.map((tool) => call(tools, tool.name, args[tool.name] ?? {})));

    let depth = 0;
    for (const event of events) {
      if (event.startsWith("enter:")) {
        expect(depth, `交错执行了：${events.join(" → ")}`).toBe(0);
        depth += 1;
      } else if (event.startsWith("exit:")) {
        expect(depth, `交错执行了：${events.join(" → ")}`).toBe(1);
        depth -= 1;
      }
    }
    // 每个工具都留下了进与出：数量对不上说明有工具压根没走那条链（被静默跳过）
    expect(events.filter((event) => event.startsWith("enter:"))).toHaveLength(tools.length);
    expect(events.filter((event) => event.startsWith("exit:"))).toHaveLength(tools.length);
    expect(events).not.toContain("cleared-while-busy");
  });

  it("并发的活跃标记不会在还有操作在跑时被清掉", async () => {
    const { automation, events, maxActiveDepth } = trackingAutomation({ delayMs: 10 });
    const tools = createBrowserTools(automation);

    await Promise.all([
      call(tools, "browser_snapshot"),
      call(tools, "browser_click", { ref: "e1" }),
    ]);

    // 串行化之后同一时刻只有一个操作在跑：不该出现「还有人在忙却报了 cleared」
    expect(events).not.toContain("cleared-while-busy");
    expect(maxActiveDepth.value).toBe(1);
  });

  it("三个只读工具的 name 与 label 一致，且描述说清了「什么时候用 / 不要用」", () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    for (const name of ["browser_snapshot", "browser_console", "browser_screenshot"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `缺少工具 ${name}`).toBeTruthy();
      expect(tool?.label).toBe(name);
      expect(tool?.description).toContain("When to use it");
      expect(tool?.description).toContain("When NOT to use it");
    }
  });

  it("浏览器报错（如 ref 失效）原样抛给内核，由它转成错误结果", async () => {
    const { automation } = trackingAutomation();
    // 覆盖 click：让它在 ref 失效时抛错（服务侧的真实行为）
    const failing = {
      ...(automation as unknown as Record<string, unknown>),
      click: async () => {
        throw new Error("找不到元素 e9。ref 只在最近一次 snapshot 内有效");
      },
    } as unknown as BrowserAutomation;
    const tools = createBrowserTools(failing);

    // 抛出的错误必须带可读文案：内核会把它作为工具结果回给模型
    await expect(call(tools, "browser_click", { ref: "e9" })).rejects.toThrow(/snapshot/);
  });

  it("press / select / hover 也走同一条串行队列：并发调用不会交错", async () => {
    const { automation, events, maxActiveDepth } = trackingAutomation({ delayMs: 10 });
    const tools = createBrowserTools(automation);

    // 新工具和 click / type 一样是「真在页面上动手」，必须共享同一个队列：
    // 把 withAgentActivity 从任意一个新工具上摘掉，下面两条断言就会红。
    await Promise.all([
      call(tools, "browser_press", { key: "Enter" }),
      call(tools, "browser_press", { key: "Escape" }),
      call(tools, "browser_select", { ref: "e3", value: "us" }),
      call(tools, "browser_hover", { ref: "e4" }),
    ]);

    // 串行的判据与 click / type 的一致：进出严格成对交替
    let depth = 0;
    for (const event of events) {
      if (event.startsWith("enter:")) {
        expect(depth, `交错执行了：${events.join(" → ")}`).toBe(0);
        depth += 1;
      } else if (event.startsWith("exit:")) {
        expect(depth, `交错执行了：${events.join(" → ")}`).toBe(1);
        depth -= 1;
      }
    }
    expect(events).toHaveLength(8);
    expect(events.indexOf("exit:press:Enter")).toBeLessThan(events.indexOf("enter:press:Escape"));
    expect(events).not.toContain("cleared-while-busy");
    expect(maxActiveDepth.value).toBe(1);
  });

  it("六个新工具的 name 与 label 一致，描述里都有「什么时候用 / 不要用」", () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    for (const name of [
      "browser_press",
      "browser_hover",
      "browser_select",
      "browser_wait",
      "browser_network",
      "browser_dialog",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `缺少工具 ${name}`).toBeTruthy();
      expect(tool?.label).toBe(name);
      expect(tool?.description).toContain("When to use it");
      expect(tool?.description).toContain("When NOT to use it");
    }
  });

  it("工具集与 BROWSER_TOOL_NAMES 一致：14 个名字一个不多一个不少", () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);
    const names: readonly string[] = Object.values(BROWSER_TOOL_NAMES);

    expect(names).toHaveLength(14);
    expect(tools).toHaveLength(names.length);
    const missing = names.filter((name) => tools.every((tool) => tool.name !== name));
    expect(missing, `缺少这些工具：${missing.join("、")}`).toEqual([]);
    // 反向也查一遍：名字写错（常量表里没有）或重复同样算失败
    expect([...tools.map((tool) => tool.name)].sort()).toEqual([...names].sort());
  });

  it("browser_wait 超时：文案里同时给出「超时了多久」与当前现状 detail", async () => {
    const { automation } = trackingAutomation({
      wait: { matched: false, waitedMs: 5000, detail: 'no element matches selector "#done"' },
    });
    const tools = createBrowserTools(automation);

    const text = await callText(tools, "browser_wait", { selector: "#done", timeoutMs: 5000 });

    // 超时分支是模型唯一的诊断来源：既要说明超时，也要带上现状，否则它只会盲目重试
    expect(text).toContain("Timed out");
    expect(text).toContain("5000ms");
    expect(text).toContain('no element matches selector "#done"');
    expect(text).toContain("Snapshot");
  });

  it("browser_select 要求 value / label / index 恰好一个：0 个与 2 个都被拒绝", async () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    const none = await callError(tools, "browser_select", { ref: "e3" });
    expect(none).toContain("value");
    expect(none).toContain("label");
    expect(none).toContain("0 个");

    const both = await callError(tools, "browser_select", {
      ref: "e3",
      value: "us",
      label: "United States",
    });
    expect(both).toContain("value");
    expect(both).toContain("label");
    expect(both).toContain("2 个");
  });

  it("browser_network 空记录时说清「还没有记录」，有记录时按 METHOD status url 列全", async () => {
    const empty = trackingAutomation({
      network: { entries: [], total: 0, omitted: 0, bufferEmpty: true, noFailures: false },
    });
    const emptyText = await callText(createBrowserTools(empty.automation), "browser_network");
    expect(emptyText).toContain("No network requests have been recorded yet.");

    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);
    const text = await callText(tools, "browser_network");

    expect(text).toContain("POST");
    expect(text).toContain("500");
    expect(text).toContain("https://example.com/api/items");
    // status 为 0 = 没拿到响应：必须写成 failed，否则模型会把 0 当成状态码
    expect(text).toContain("failed");
    expect(text).toContain("net::ERR_CONNECTION_RESET");

    const cleared = await callText(tools, "browser_network", { clear: true });
    expect(cleared).toContain("Network log cleared before this read.");
  });

  it("STALE_REF：首行给出工具名与错误码，末句让模型重新 snapshot（不谎报成功）", async () => {
    const tools = createBrowserTools(
      automationThrowing(
        "click",
        browserFailure("STALE_REF", "元素 e9 已从 DOM 移除（页面重渲染）", {
          ref: "e9",
          generation: 3,
        }),
      ),
    );

    const text = await callError(tools, "browser_click", { ref: "e9" });

    // 首行是「工具名 失败（错误码）：原因」，模型据此一眼看出这是哪一类失败
    expect(text).toContain("browser_click 失败（STALE_REF）：元素 e9 已从 DOM 移除");
    // detail 逐字段列出：ref / generation 都在
    expect(text).toContain("- ref: e9");
    expect(text).toContain("- generation: 3");
    expect(text).toContain("下一步：");
    expect(text).toContain("browser_snapshot");
  });

  it("UNAVAILABLE：说明视口 0×0，并让用户展开右侧浏览器面板", async () => {
    const tools = createBrowserTools(
      automationThrowing(
        "click",
        browserFailure("UNAVAILABLE", "浏览器面板未布局（视口 0×0）：坐标输入无法投递。", {
          viewport: { w: 0, h: 0 },
        }),
      ),
    );

    const text = await callError(tools, "browser_click", { ref: "e1" });

    expect(text).toContain("browser_click 失败（UNAVAILABLE）");
    expect(text).toContain("- viewport: 0×0");
    expect(text).toContain("展开浏览器面板");
    // 还要给一条仍然可用的路：JS 通道不受零尺寸视口影响
    expect(text).toContain("browser_evaluate");
  });

  it("WRONG_TARGET：detail 渲染命中者（tag/id/class）与视口尺寸，下一步给 Escape / evaluate", async () => {
    const tools = createBrowserTools(
      automationThrowing(
        "click",
        browserFailure("WRONG_TARGET", "事件被 div.overlay 收走了，目标按钮没收到", {
          ref: "e5",
          hitRef: "e7",
          elementAtPoint: { tag: "div", id: "modal", cls: "overlay shadow" },
          viewport: { width: 1280, height: 0 },
          events: 0,
        }),
      ),
    );

    const text = await callError(tools, "browser_click", { ref: "e5" });

    expect(text).toContain("browser_click 失败（WRONG_TARGET）");
    expect(text).toContain("- ref: e5");
    expect(text).toContain("- hitRef: e7");
    expect(text).toContain("- elementAtPoint: div#modal.overlay.shadow");
    expect(text).toContain("- viewport: 1280×0");
    expect(text).toContain("- events: 0");
    expect(text).toContain("Escape");
    expect(text).toContain("browser_evaluate");
  });

  it("noFailures：有记录但没有失败请求时不得说「还没有记录」，要报出条数", async () => {
    const { automation } = trackingAutomation({
      network: { entries: [], total: 23, omitted: 0, bufferEmpty: false, noFailures: true },
    });

    const text = await callText(createBrowserTools(automation), "browser_network", {
      failuresOnly: true,
    });

    expect(text).toContain("23");
    expect(text).toContain("none failed");
    expect(text).not.toContain("No network requests have been recorded yet.");
  });

  it("omitted：说明还有多少条记录没列出来（不给数字会让模型以为页面只发了这么多）", async () => {
    const { automation } = trackingAutomation({
      network: {
        entries: [
          { url: "https://example.com/x", method: "GET", status: 200, resourceType: "xhr", durationMs: 9, at: 1 },
        ],
        total: 93,
        omitted: 12,
        bufferEmpty: false,
        noFailures: false,
      },
    });

    const text = await callText(createBrowserTools(automation), "browser_network");

    expect(text).toContain("12 record(s) are not listed here");
    expect(text).toContain("showing the last 1 of 93");
  });

  it("dropped：说明已过滤多少条 Electron 自身噪音，增量语义不变", async () => {
    const noisy = trackingAutomation({
      console: {
        entries: [{ level: "error", text: "boom", source: "app.js", line: 3, at: 1 }],
        dropped: 5,
      },
    });
    const text = await callText(createBrowserTools(noisy.automation), "browser_console");
    expect(text).toContain("[error] boom (app.js:3)");
    expect(text).toContain("5 message(s) were filtered out");
    expect(text).toContain("Electron");

    // 一条新消息都没有、但噪音被过滤时：两条事实都要说
    const quiet = trackingAutomation({ console: { entries: [], dropped: 2 } });
    const quietText = await callText(createBrowserTools(quiet.automation), "browser_console");
    expect(quietText).toContain("No new console messages since the last read.");
    expect(quietText).toContain("2 message(s) were filtered out");
  });

  it("warnings / effect：unknown 明说「未做断言」，warnings 逐条列出，hit 不啰嗦", async () => {
    const tools = createBrowserTools(
      automationReturning("type", {
        name: "field",
        navigated: false,
        effect: "unknown",
        detail: "probe was not armed",
        warnings: ["input truncated at maxlength 10", "a page key handler also ran"],
      } satisfies BrowserActionOutcome),
    );

    const text = await callText(tools, "browser_type", { ref: "e3", text: "hello" });

    expect(text).toContain("Effect: unknown");
    expect(text).toContain("NOT asserted to have landed");
    expect(text).toContain("probe was not armed");
    expect(text).toContain("Warning: input truncated at maxlength 10");
    expect(text).toContain("Warning: a page key handler also ran");

    // 默认的 hit 且没有告警时，成功文案保持原样（不加 Effect / Warning 行）
    const plain = createBrowserTools(trackingAutomation().automation);
    const plainText = await callText(plain, "browser_type", { ref: "e3", text: "hi" });
    expect(plainText).not.toContain("Effect:");
    expect(plainText).not.toContain("Warning:");
  });
});
