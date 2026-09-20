import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_NAMES } from "@/shared/contracts/browser";
import type { BrowserAutomation } from "../browser/types";
import { buildTools, TOOL_NAMES } from "./tools";

/** 内核原生四件套：description 由 tools.ts 整体覆盖 */
const NATIVE_TOOLS = ["bash", "read", "write", "edit"];
/** 自建工具（不含浏览器族，也不含按会话注入的 ask_user） */
const CUSTOM_TOOLS = ["grep", "glob", "todo"];
/**
 * 浏览器工具名清单。
 *
 * 直接从契约的常量对象取（而不是消费一个专门的数组导出）：那份数组只被本测试用，
 * 为它保留一个生产导出等于把「哪些名字算浏览器工具」变成公开 API。
 */
const BROWSER_TOOL_NAME_LIST = Object.values(BROWSER_TOOL_NAMES);

/**
 * 浏览器工具的假实现：这个测试只关心**装配**（名字、数量、description 齐不齐），
 * 不关心它们怎么操作页面 —— 那是 browser 服务的事，而它依赖 Electron。
 * 用一个只会抛错的桩就够：装配正确时这些方法一次都不会被调用。
 */
function fakeAutomation(): BrowserAutomation {
  const notImplemented = () => {
    throw new Error("测试不应该真的调用浏览器");
  };
  return {
    setAgentActive: () => undefined,
    status: () => ({
      open: false,
      state: { url: "", title: "", loading: false, canGoBack: false, canGoForward: false },
      agentActive: false,
    }),
    open: notImplemented,
    history: notImplemented,
    snapshot: notImplemented,
    click: notImplemented,
    type: notImplemented,
    screenshot: notImplemented,
    console: () => Promise.resolve([]),
    evaluate: notImplemented,
  } as unknown as BrowserAutomation;
}

describe("buildTools", () => {
  it("默认返回内核四件套 + 三个自建工具：浏览器与 ask_user 都要调用方注入", () => {
    const tools = buildTools();

    expect(tools).toHaveLength(NATIVE_TOOLS.length + CUSTOM_TOOLS.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...NATIVE_TOOLS, ...CUSTOM_TOOLS].sort(),
    );
    // TOOL_NAMES 是权限层 / UI 的登记表：ask_user 按会话注入、浏览器族按实现注入
    //（见 runtime 的两处 buildTools），所以默认工具集 = 登记表去掉这两族。
    const injectable = new Set<string>([TOOL_NAMES.ask, ...BROWSER_TOOL_NAME_LIST]);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(Object.values(TOOL_NAMES).filter((name) => !injectable.has(name))),
    );

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
      // label 是 AgentTool 的必填字段，UI 直接拿它显示
      expect(tool.label).toBeTruthy();
    }
  });

  it("传入浏览器实现时装配出全部浏览器工具，且 name 与 label 一致", () => {
    const tools = buildTools([], undefined, [], fakeAutomation());
    const names = tools.map((tool) => tool.name);

    for (const name of BROWSER_TOOL_NAME_LIST) {
      expect(names).toContain(name);
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.label).toBe(name);
    }
    expect(tools).toHaveLength(
      NATIVE_TOOLS.length + CUSTOM_TOOLS.length + BROWSER_TOOL_NAME_LIST.length,
    );
  });

  it("四个原生工具的 description 已覆盖为带场景指导的文案", () => {
    // 内核自带的文案只有操作说明，模型选错工具的首要原因就是缺「什么时候用」——
    // 这条断言防止将来有人把覆盖去掉（去掉后 description 仍在，只是变得没用）
    const tools = buildTools().filter((tool) => NATIVE_TOOLS.includes(tool.name));

    expect(tools).toHaveLength(NATIVE_TOOLS.length);
    for (const tool of tools) {
      expect(tool.description).toContain("什么时候用");
      expect(tool.description).toContain("什么时候不要用");
    }
  });

  it("read / edit 的描述都说明行号不属于文件内容（read 的输出确实带行号）", () => {
    const tools = buildTools();
    const read = tools.find((tool) => tool.name === TOOL_NAMES.read);
    const edit = tools.find((tool) => tool.name === TOOL_NAMES.edit);

    // read 承诺行号；edit 是逐字符匹配，必须警告模型别把行号复制进 oldText/newText
    expect(read?.description).toContain("带行号");
    expect(edit?.description).toContain("行号");
    expect(edit?.description).toContain("oldText");
  });

  it("自建工具的 name 与 label 一致", () => {
    const tools = buildTools();
    for (const name of CUSTOM_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `缺少工具 ${name}`).toBeTruthy();
      expect(tool?.label).toBe(name);
    }
  });

  it("浏览器工具的 description 写清了「什么时候用 / 不要用」（本仓库的既定标准）", () => {
    const tools = buildTools([], undefined, [], fakeAutomation());
    for (const name of BROWSER_TOOL_NAME_LIST) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain("When to use it");
      expect(tool?.description).toContain("When NOT to use it");
    }
  });
});
