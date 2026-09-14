// 页面侧脚本与 URL 归一的单测。
//
// 为什么值得测：注入到 guest 里的那段 JS 是本功能里唯一「跑在别人家页面里」的代码，
// 出错表现是「快照莫名其妙为空」，而它没法在 Electron 之外调试。这里能覆盖的部分有：
//   · URL 归一的放行/拒绝口径（安全相关，且是模型最常走的那条路）；
//   · 生成的脚本是**合法 JS**（语法错会让每次快照都失败，且错误信息难以定位）；
//   · 字符串转义正确（模型给的内容会进脚本，拼错就是注入）。
// 真正的 DOM 行为（快照内容、点击坐标）留给人开着应用点一次 —— jsdom 没有布局，
// 在这里假装测它只会制造「测试通过但功能坏了」的假象。

import { describe, expect, it } from "vitest";
import {
  buildEvaluateExpression,
  buildLocateExpression,
  buildReadValueExpression,
  buildSelectExpression,
  buildSnapshotExpression,
  buildWaitExpression,
  EVALUATE_MAX_CHARS,
  normalizeBrowserUrl,
  SNAPSHOT_MAX_ELEMENTS,
} from "./script";
import type { BrowserOptionMatch } from "./types";

describe("normalizeBrowserUrl", () => {
  it("缺 scheme 时补 https（地址栏的习惯）", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("example.com/a?b=1")).toBe("https://example.com/a?b=1");
  });

  it("本机地址补 http、且带端口时不被误判成 scheme", () => {
    // localhost:3000 长得和 `scheme:` 一模一样；本地 dev server 基本不配 TLS，
    // 所以这里既要认出来、也要走 http —— 两条都必须成立，缺一条这个用例就失去意义。
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("localhost:3000/app?x=1")).toBe("http://localhost:3000/app?x=1");
    expect(normalizeBrowserUrl("localhost")).toBe("http://localhost/");
    expect(normalizeBrowserUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    // 显式给了 https 就尊重它（不要被上面的默认值改写）
    expect(normalizeBrowserUrl("https://localhost:3000")).toBe("https://localhost:3000/");
  });

  it("已有 http / https 时原样保留（含端口、路径、查询）", () => {
    expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeBrowserUrl("https://example.com:8443/x?y=1#z")).toBe(
      "https://example.com:8443/x?y=1#z",
    );
    expect(normalizeBrowserUrl("  https://example.com  ")).toBe("https://example.com/");
  });

  it("拒绝一切非 http(s) scheme —— 它们都是绕过其它工具限制读本机的路", () => {
    // file: 读本地文件；javascript: / data: 直接执行或注入内容
    expect(normalizeBrowserUrl("file:///C:/Windows/win.ini")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("data:text/html,<h1>hi</h1>")).toBeNull();
    expect(normalizeBrowserUrl("chrome://settings")).toBeNull();
    expect(normalizeBrowserUrl("about:blank")).toBeNull();
    // 大小写与空白不该成为后门
    expect(normalizeBrowserUrl("FILE:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("  JavaScript:alert(1)  ")).toBeNull();
  });

  it("拒绝不像地址的输入（那是搜索词，该走搜索引擎而不是当成主机名碰运气）", () => {
    expect(normalizeBrowserUrl("")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
    expect(normalizeBrowserUrl("hello")).toBeNull();
    expect(normalizeBrowserUrl("hello world")).toBeNull();
  });

  it("非法 URL 不抛异常，只返回 null", () => {
    expect(normalizeBrowserUrl("https://")).toBeNull();
    expect(normalizeBrowserUrl("http://[")).toBeNull();
  });
});

describe("生成的注入脚本", () => {
  /** 用 Function 构造一次就能验证语法：语法错会在这一步抛 */
  function parses(source: string): boolean {
    try {
      // 只解析不执行：没有 document/window，执行必然报错，这里只要语法过关
      new Function(`return (${source});`);
      return true;
    } catch {
      return false;
    }
  }

  it("快照脚本是合法 JS 表达式", () => {
    expect(parses(buildSnapshotExpression())).toBe(true);
  });

  it("快照脚本走页面侧注册表，不再把 ref 写进 DOM 属性（回归哨兵）", () => {
    const source = buildSnapshotExpression();
    // ref 的权威位置是这三个页面侧字段：Map<ref, Element> / WeakMap<Element, ref> / 自增计数
    expect(source).toContain("__ointEls");
    expect(source).toContain("__ointUid");
    expect(source).toContain("__ointRefSeq");
    // 旧路径（`querySelector('[data-oint-ref="…"]')`）一旦被加回来就会命中这行：
    // 属性可以被页面抢占，也会随节点复用残留 —— 正是这次重构要消掉的静默错点源头
    expect(source).not.toContain("data-oint-ref");
  });

  it("定位脚本是合法 JS，且把 ref 当数据而不是拼进代码", () => {
    const source = buildLocateExpression("e12");
    expect(parses(source)).toBe(true);
    expect(source).toContain('"e12"');
    // 恶意的 ref 只会变成字符串字面量的一部分，不会逃出引号
    const evil = buildLocateExpression('"; alert(1); "');
    expect(parses(evil)).toBe(true);
    expect(evil).toContain(JSON.stringify('"; alert(1); "'));
  });

  it("读回值脚本是合法 JS，且把 ref 当数据传入", () => {
    const source = buildReadValueExpression("e12");
    expect(parses(source)).toBe(true);
    expect(source).toContain(JSON.stringify("e12"));
    const evil = buildReadValueExpression('"; alert(1); "');
    expect(parses(evil)).toBe(true);
    expect(evil).toContain(JSON.stringify('"; alert(1); "'));
  });

  it("求值脚本是合法 JS，且把代码原文当数据传入", () => {
    const source = buildEvaluateExpression("document.title");
    expect(parses(source)).toBe(true);
    expect(source).toContain(JSON.stringify("document.title"));
    // 含引号、反引号的代码同样只落在字符串里 —— 这类内容最容易把拼接写坏
    const trickyCode = 'return "a\\"b" + `c`;';
    const tricky = buildEvaluateExpression(trickyCode);
    expect(parses(tricky)).toBe(true);
    expect(tricky).toContain(JSON.stringify(trickyCode));
  });
  it("上限写进了脚本，且与导出常量一致（改一个数不会只改一半）", () => {
    const snapshotSource = buildSnapshotExpression();
    expect(snapshotSource).toContain(`const MAX_ELEMENTS = ${SNAPSHOT_MAX_ELEMENTS};`);
    expect(buildEvaluateExpression("1")).toContain(String(EVALUATE_MAX_CHARS));
  });

  it("选择脚本是合法 JS，且把 ref 与 match 都当数据传入（不拼进代码）", () => {
    // label 是从页面上读来的可见文字，可能带引号 / 反斜杠 / 换行 / </script> ——
    // 直接拼进代码就是注入，这里要求它们只作为字符串字面量存在
    const evilLabel = '他说"选这个" \\ </script>\n第二行';
    const source = buildSelectExpression("e7", { kind: "label", label: evilLabel });
    expect(parses(source)).toBe(true);
    expect(source).toContain(JSON.stringify("e7"));
    expect(source).toContain(JSON.stringify(evilLabel));
  });

  it("match 的三种 kind（value / label / index）都能生成合法脚本", () => {
    const cases: readonly BrowserOptionMatch[] = [
      { kind: "value", value: 'us"; alert(1); "' },
      { kind: "label", label: "United States" },
      { kind: "index", index: 3 },
    ];
    for (const match of cases) {
      const source = buildSelectExpression("e1", match);
      expect(parses(source), JSON.stringify(match)).toBe(true);
      expect(source).toContain(JSON.stringify(match));
    }
  });

  it("等待脚本是合法 JS，且把目标当数据传入（text / selector 两种）", () => {
    const trickyText = '他说"好了" \\ 换行\n结束';
    const textSource = buildWaitExpression({ kind: "text", text: trickyText });
    expect(parses(textSource)).toBe(true);
    expect(textSource).toContain(JSON.stringify(trickyText));

    // 选择器只是数据：合法性由页面里的 querySelector 判定，这里不该做任何预处理
    const selector = 'div[data-x="1"] >>> span';
    const selectorSource = buildWaitExpression({ kind: "selector", selector });
    expect(parses(selectorSource)).toBe(true);
    expect(selectorSource).toContain(JSON.stringify(selector));
  });
});
