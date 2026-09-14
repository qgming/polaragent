// 「输入有没有真的落进去」（textLanded）的判定单测。
//
// 这个函数是**假成功**的最后一道防线，两侧都会出事：
//   · 判太严（直接比字符串相等）→ 掩码 / 千分位字段明明填对了却报失败，于是重填一遍，
//     第二次输入插进格式化后的文本里，把值搞得更乱；
//   · 判太松（只看非空）→ 「被 maxlength 截断」「打到了别的元素上」都会被当成成功 ——
//     那正是最初那批报告的根因（工具报成功、字段其实是空的）。
// 所以下面既有宽松侧（掩码 / 前缀 / 大小写），也有必须判失败的严格侧，还有一条
// 反向断言把「宽松」的边界钉死。

import { describe, expect, it } from "vitest";
import { textLanded } from "./verify";

describe("textLanded", () => {
  it("去掉首尾空白后完全相等就算落进去了", () => {
    expect(textLanded("hello", "hello")).toBe(true);
    expect(textLanded("  hello  ", "hello")).toBe(true);
    expect(textLanded("hello", "  hello  ")).toBe(true);
  });

  it("掩码 / 千分位 / 分组格式：只比字母数字，标点差异不算失败", () => {
    // 电话字段输入 "1234567890" 得到 "(123) 456-7890"
    expect(textLanded("(123) 456-7890", "1234567890")).toBe(true);
    // 金额字段自己补上货币符号与千分位
    expect(textLanded("$1,234.00", "1234.00")).toBe(true);
  });

  it("字段在自己的值前面加了国家码也算成功 —— 但前提是值确实变了", () => {
    // 只比字母数字是比不出来的（"86138" ≠ "138"），所以这条靠「包含」，而「包含」
    // 必须带上输入前的值：没有那个前提，下面第二个断言里的假成功就会溜过去。
    expect(textLanded("+86 138", "138", "")).toBe(true);
  });

  it("字段里本来就有这段文字、但值没变时**不算**成功（本次输入根本没落进去）", () => {
    // 这就是「包含」口径不加前提时会漏掉的假成功：字段预填 "latest test"，模型输入
    // "test"，而聚焦那一下没落到元素上 —— 字段原样不动，可包含关系成立。
    // 工具会报「已输入」，模型接着去提交，提交上去的还是旧内容。
    expect(textLanded("latest test", "test", "latest test")).toBe(false);
    // 对照：值确实变了（页面自己加了前缀）时，「包含」才成立
    expect(textLanded("+86 138", "138", "")).toBe(true);
    // 缺省 previous（读不到输入前的值）时也按保守处理 —— 宁可多报一次失败
    expect(textLanded("latest test", "test")).toBe(false);
  });

  it("大小写差异不算失败（第 3 条口径统一小写）", () => {
    expect(textLanded("HELLO", "hello")).toBe(true);
    expect(textLanded("hello", "HELLO")).toBe(true);
  });

  it("字母数字的口径覆盖非 ASCII（中文页面同样适用）", () => {
    // 用的必须得是 \p{L} / \p{N} 而不是 [a-z0-9]：换成后者，中文页面上这一整条口径失效
    expect(textLanded("你好，世界", "你好世界")).toBe(true);
    expect(textLanded("（123）456", "123456")).toBe(true);
  });

  it("必须判失败的假成功入口", () => {
    // 被 maxlength 截断：少几个字符就是没落全，不能算成功
    expect(textLanded("abc", "abcdef")).toBe(false);
    // 字段是空的：最要紧的一条 —— 工具报成功、用户看到空字段
    expect(textLanded("", "hello")).toBe(false);
    // 打到了别的元素上：值完全是别的文本
    expect(textLanded("world", "hello")).toBe(false);
    // 掩码字段也不能被「截断成一个合法的样子」蒙过去
    expect(textLanded("(123) 456", "1234567890")).toBe(false);
  });

  it("宽松是有边界的：内容多一个字符也不认（只放宽标点，不放宽内容）", () => {
    expect(textLanded("1234", "12345")).toBe(false);
    expect(textLanded("hello world", "hello there")).toBe(false);
    // 第 3 条口径要求字母数字**完全相同**，不是「包含」：字段里多出别的字符
    //（尾部被自动补了东西）同样要判失败
    expect(textLanded("123456 00", "123 456")).toBe(false);
  });

  it("输入空串等于清空字段，没有可校验的内容，一律算成功", () => {
    // 清空动作本身无法从「读回值」里看出差别（空字段就是空），所以这里刻意放行
    expect(textLanded("anything", "")).toBe(true);
    expect(textLanded("", "")).toBe(true);
  });
});
