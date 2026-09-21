/**
 * 新增详情解析的测试：ask_user / 文本类 / write / 浏览器。
 *
 * 这几条都是「点开什么都没有」那类缺陷的回归保护 —— 解析器一旦退回 null，
 * 界面上就是一块空白（旧实现里那个 Request/Result 面板还会把换行压平）。
 * 所以断言口径取**解析出来的内容**，而不是「有没有抛错」。
 */

import { describe, expect, it } from "vitest";
import {
  parseAskDetail,
  parseBrowserDetail,
  parseTextDetail,
  parseWriteDetail,
  resolveToolDetail,
  splitToolText,
} from "./tool-presentation";

describe("parseAskDetail", () => {
  const DETAIL = {
    outcome: "answered",
    questions: [
      { id: "q1", header: "数据库", question: "用哪个库？", options: ["SQLite", "Postgres"] },
      { id: "q2", header: "迁移", question: "要写迁移脚本吗？", multiSelect: true },
    ],
    answers: [
      { questionId: "q1", selected: ["SQLite"] },
      { questionId: "q2", selected: ["写"], text: "顺便加回滚" },
    ],
  };

  it("题目与作答都解析出来（这是会话里唯一能回看答案的地方）", () => {
    const detail = parseAskDetail(DETAIL);

    expect(detail?.kind).toBe("ask");
    expect(detail?.outcome).toBe("answered");
    expect(detail?.questions).toHaveLength(2);
    expect(detail?.questions[0]).toMatchObject({ header: "数据库", question: "用哪个库？" });
    expect(detail?.questions[0]?.options).toEqual(["SQLite", "Postgres"]);
    expect(detail?.questions[1]?.multiSelect).toBe(true);
    expect(detail?.answers).toEqual([
      { questionId: "q1", selected: ["SQLite"] },
      { questionId: "q2", selected: ["写"], text: "顺便加回滚" },
    ]);
  });

  it("header 缺失时退回 question（宁可重复，也不要一个没标题的题）", () => {
    const detail = parseAskDetail({
      outcome: "answered",
      questions: [{ id: "q1", question: "只有正文" }],
      answers: [],
    });
    expect(detail?.questions[0]?.header).toBe("只有正文");
  });

  it("answers 缺失 / 非法时按「全都没作答」处理，题目照常给出", () => {
    // 超时与取消两种收尾本来就没有作答，不该因此整块不显示
    for (const answers of [undefined, null, "不是数组", [1, 2]]) {
      const detail = parseAskDetail({
        outcome: "unanswered",
        questions: DETAIL.questions,
        answers,
      });
      expect(detail?.questions).toHaveLength(2);
      expect(detail?.answers).toEqual([]);
    }
  });

  it("outcome 非法时按 answered 处理（字段缺失不该让题面消失）", () => {
    expect(parseAskDetail({ questions: DETAIL.questions })?.outcome).toBe("answered");
    expect(parseAskDetail({ outcome: "乱写", questions: DETAIL.questions })?.outcome).toBe(
      "answered",
    );
  });

  it("逐项校验：坏的题被跳过，好的留下", () => {
    const detail = parseAskDetail({
      questions: [
        { id: "q1", header: "好题", question: "留下" },
        { id: "", header: "空 id", question: "丢掉" },
        { id: "q3", question: "" },
        "不是对象",
        null,
      ],
    });
    expect(detail?.questions).toHaveLength(1);
    expect(detail?.questions[0]?.header).toBe("好题");
  });

  it("一道题都解析不出来时返回 null（没有可显示的内容）", () => {
    for (const bad of [
      null,
      undefined,
      "字符串",
      42,
      {},
      { questions: "不是数组" },
      { questions: [] },
    ]) {
      expect(parseAskDetail(bad), String(bad)).toBeNull();
    }
  });

  it("selected 里的非字符串被滤掉，不污染作答渲染", () => {
    const detail = parseAskDetail({
      questions: [{ id: "q1", header: "h", question: "q" }],
      answers: [{ questionId: "q1", selected: ["好", 42, null] }],
    });
    expect(detail?.answers[0]?.selected).toEqual(["好"]);
  });
});

describe("splitToolText / parseTextDetail", () => {
  it("尾注与正文分开：方括号整行是元信息，不是内容", () => {
    const split = splitToolText(
      "  1\tconst a = 1;\n  2\tconst b = 2;\n\n[Showing lines 1-2 of 9.]",
    );
    expect(split.body).toBe("  1\tconst a = 1;\n  2\tconst b = 2;");
    expect(split.footer).toBe("[Showing lines 1-2 of 9.]");
  });

  it("多行尾注一起收走", () => {
    const split = splitToolText("out\n[one]\n[two]");
    expect(split.body).toBe("out");
    expect(split.footer).toBe("[one]\n[two]");
  });

  /**
   * **首行绝不切出去**。第一版把「多行结果的首行」当成身份行摘掉，
   * 实测下它把 read 的第一个行号行、grep 的第一条命中、glob 的第一个路径
   * 全都从正文里吃掉了 —— 那等于吞掉一条结果。
   */
  it("首行留在正文里（它可能是第一条命中 / 第一个路径）", () => {
    expect(splitToolText("src/a.ts:1:foo\nsrc/b.ts:2:foo").body).toBe(
      "src/a.ts:1:foo\nsrc/b.ts:2:foo",
    );
    // 单行结果同样整句保留
    expect(splitToolText("Successfully wrote to a.md").body).toBe("Successfully wrote to a.md");
  });

  it("方括号不在末尾时不当尾注（正文里的数组字面量不能被吃掉）", () => {
    const split = splitToolText("[1, 2, 3]\n后面还有正文");
    expect(split.body).toBe("[1, 2, 3]\n后面还有正文");
    expect(split.footer).toBeUndefined();
  });

  it("空结果给一句说明，而不是一个空白面板", () => {
    const detail = parseTextDetail("", "没有匹配");
    expect(detail?.body).toBe("");
    expect(detail?.emptyText).toBe("没有匹配");
    // 没有说明文案时返回 null（调用方据此决定要不要给这块）
    expect(parseTextDetail("")).toBeNull();
  });

  it("非字符串结果按 JSON 序列化（对象也要能看）", () => {
    const detail = parseTextDetail({ ok: true });
    expect(detail?.body).toContain('"ok": true');
  });
});

describe("parseWriteDetail", () => {
  it("路径与正文都从参数里取（write 的 details 是 undefined）", () => {
    const detail = parseWriteDetail({ path: "a.md", content: "# 标题\n正文" });
    expect(detail?.kind).toBe("write");
    expect(detail?.path).toBe("a.md");
    expect(detail?.preview).toBe("# 标题\n正文");
    expect(detail?.bytes).toBe("# 标题\n正文".length);
  });

  it("缺路径时返回 null（没有主语就没法显示）", () => {
    for (const bad of [null, undefined, "字符串", {}, { path: "" }, { path: 42 }]) {
      expect(parseWriteDetail(bad), String(bad)).toBeNull();
    }
  });

  it("没有 content 时不编造正文，也不编造 0 字节", () => {
    const detail = parseWriteDetail({ path: "a.md" });
    expect(detail?.path).toBe("a.md");
    expect(detail?.preview).toBeUndefined();
    expect(detail?.bytes).toBeUndefined();
  });

  it("超长正文截断，避免一次写入把面板撑爆", () => {
    const detail = parseWriteDetail({ path: "a.md", content: "x".repeat(10_000) });
    expect(detail?.preview?.length).toBe(4000);
    // 但字节数报的是**完整**长度，不是截断后的
    expect(detail?.bytes).toBe(10_000);
  });
});

describe("parseBrowserDetail", () => {
  it("快照：tab / url / title 进读数，元素清单进条目", () => {
    const detail = parseBrowserDetail(
      "browser_snapshot",
      {
        url: "https://a.test",
        title: "示例",
        tabId: "t2",
        elements: [
          { ref: "e1", role: "button", name: "提交", tag: "button" },
          { ref: "e2", role: "textbox", name: "邮箱", tag: "input", value: "a@b.c" },
        ],
      },
      "tab t2\n正文",
    );

    expect(detail?.kind).toBe("browser");
    expect(detail?.tabId).toBe("t2");
    expect(detail?.fields).toEqual([
      { label: "url", value: "https://a.test" },
      { label: "title", value: "示例" },
    ]);
    expect(detail?.entries?.[0]?.text).toContain("e1");
    expect(detail?.entries?.[0]?.text).toContain("提交");
    // 有值的元素把值也带出来（只给名字看不出当前填了什么）
    expect(detail?.entries?.[1]?.text).toContain("a@b.c");
    // 结果原文一并留着（读数与原文互补）
    expect(detail?.body).toBe("tab t2\n正文");
  });

  it("快照被截断时把省略数量说出来（不说会以为页面就这么多）", () => {
    const detail = parseBrowserDetail(
      "browser_snapshot",
      { elements: [], omitted: { elements: 4, textChars: 100 } },
      "",
    );
    expect(detail?.omittedText).toContain("4 elements");
    expect(detail?.omittedText).toContain("100 chars");
  });

  it("控制台日志：逐条进条目，error 级标红", () => {
    const detail = parseBrowserDetail(
      "browser_logs",
      {
        tabId: "t1",
        entries: [
          { level: "error", text: "Uncaught", source: "a.js", line: 12 },
          { level: "info", text: "ready", source: "a.js", line: 3 },
        ],
        dropped: 2,
      },
      "",
    );

    expect(detail?.entries?.[0]?.kind).toBe("error");
    expect(detail?.entries?.[0]?.text).toContain("a.js:12");
    expect(detail?.entries?.[1]?.kind).toBe("info");
    expect(detail?.omittedText).toContain("2");
  });

  it("求值：成功给结果，失败给错误条目", () => {
    const ok = parseBrowserDetail("browser_evaluate", { tabId: "t1", ok: true, value: "42" }, "");
    expect(ok?.fields).toContainEqual({ label: "result", value: "42" });

    const bad = parseBrowserDetail(
      "browser_evaluate",
      { tabId: "t1", ok: false, error: "ReferenceError" },
      "",
    );
    expect(bad?.entries?.[0]?.kind).toBe("error");
  });

  it("等待：matched / waited 进读数", () => {
    const detail = parseBrowserDetail(
      "browser_wait",
      { tabId: "t1", matched: true, waitedMs: 320, detail: "文本出现了" },
      "",
    );
    expect(detail?.fields).toContainEqual({ label: "matched", value: "true" });
    expect(detail?.fields).toContainEqual({ label: "waited", value: "320ms" });
  });

  it("认不出的形状也按字段直出（通用兜底是刻意的）", () => {
    // open / history 以及将来新增的浏览器工具：至少不要什么都没显示
    const detail = parseBrowserDetail(
      "browser_open",
      { tabId: "t1", state: { url: "https://a.test", title: "示例", loading: false } },
      "",
    );
    expect(detail?.fields).toContainEqual({ label: "url", value: "https://a.test" });
    expect(detail?.fields).toContainEqual({ label: "loading", value: "false" });
  });

  it("什么都没有时返回 null（调用方据此退回文本详情）", () => {
    expect(parseBrowserDetail("browser_open", undefined, "")).toBeNull();
    expect(parseBrowserDetail("browser_snapshot", {}, "")).toBeNull();
  });
});

describe("resolveToolDetail 对浏览器的路由", () => {
  it("九个浏览器工具都走 browser 详情（不再点开什么都没有）", () => {
    const names = [
      "browser_open",
      "browser_history",
      "browser_snapshot",
      "browser_act",
      "browser_wait",
      "browser_screenshot",
      "browser_logs",
      "browser_dialog",
      "browser_evaluate",
    ];
    for (const name of names) {
      const detail = resolveToolDetail(name, { tabId: "t1" }, false, undefined, "tab t1\n正文");
      expect(detail?.kind, name).toBe("browser");
    }
  });

  it("浏览器工具失败时也给详情（失败正是要看的东西）", () => {
    const detail = resolveToolDetail(
      "browser_snapshot",
      { tabId: "t1" },
      true,
      undefined,
      "Error: 页面还没打开",
    );
    // 有 details 就照常给 browser（读数仍然有效）；这条同时说明失败不再一律 null
    expect(detail).not.toBeNull();
  });
});
