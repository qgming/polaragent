// HTML→文本抽取。纯函数，无网络、无 DOM 依赖。

import { describe, expect, it } from "vitest";
import { decodeEntities, extractPageText, MAX_INPUT_CHARS, OMITTED_MARKER } from "./html";

describe("decodeEntities", () => {
  it("解常见命名实体", () => {
    expect(decodeEntities("a&amp;b")).toBe("a&b");
    expect(decodeEntities("&lt;div&gt;")).toBe("<div>");
    expect(decodeEntities("&quot;x&quot;")).toBe('"x"');
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
    expect(decodeEntities("it&#39;s")).toBe("it's");
  });

  it("解十进制与十六进制数字实体", () => {
    expect(decodeEntities("&#65;&#66;")).toBe("AB");
    expect(decodeEntities("&#x41;&#X42;")).toBe("AB");
    // 前导零的写法（&#039; 是常见变体）
    expect(decodeEntities("&#039;")).toBe("'");
  });

  it("越界码点回空串而不是抛（坏实体不该毁掉整页）", () => {
    expect(decodeEntities("a&#999999999;b")).toBe("ab");
  });

  it("无法解码的实体原样保留", () => {
    expect(decodeEntities("&unknownentity;")).toBe("&unknownentity;");
  });
});

describe("extractPageText · 去噪", () => {
  it("丢掉 script / style / noscript / 注释的内容", () => {
    const html = `
      <html><head>
        <script>var secret = "IN_SCRIPT";</script>
        <style>.x { color: IN_STYLE; }</style>
        <noscript>IN_NOSCRIPT</noscript>
      </head><body>
        <!-- IN_COMMENT -->
        <p>正文</p>
      </body></html>`;
    const { content } = extractPageText(html, 10_000);
    expect(content).toContain("正文");
    for (const noise of ["IN_SCRIPT", "IN_STYLE", "IN_NOSCRIPT", "IN_COMMENT"]) {
      expect(content, noise).not.toContain(noise);
    }
  });

  it("丢掉 head 里的 meta/title（它们不是正文）", () => {
    const html = `<html><head><title>T</title><meta name="description" content="D"></head><body><p>正文</p></body></html>`;
    expect(extractPageText(html, 10_000).content).toBe("正文");
  });
});

describe("extractPageText · 标题", () => {
  it("取 <title>", () => {
    expect(extractPageText("<title>页面标题</title><body>x</body>", 1000).title).toBe("页面标题");
  });

  it("og:title 优先于 <title>（后者常带站点名后缀）", () => {
    const html = `
      <title>正文标题 - 某某网</title>
      <meta property="og:title" content="干净的标题">
      <body>x</body>`;
    expect(extractPageText(html, 1000).title).toBe("干净的标题");
  });

  it("属性顺序颠倒时也能取到 og:title", () => {
    const html = `<meta content="标题" property="og:title"><body>x</body>`;
    expect(extractPageText(html, 1000).title).toBe("标题");
  });

  it("没有标题时回空串", () => {
    expect(extractPageText("<body>没有标题</body>", 1000).title).toBe("");
  });

  it("标题里的实体与标签被清理", () => {
    const html = `<title>A &amp; <b>B</b></title><body>x</body>`;
    expect(extractPageText(html, 1000).title).toBe("A & B");
  });
});

describe("extractPageText · 正文范围", () => {
  it("article 优先于 body（少掉导航与页脚噪声）", () => {
    const html = `
      <body>
        <nav>导航链接</nav>
        <article>文章正文</article>
        <footer>页脚</footer>
      </body>`;
    const { content } = extractPageText(html, 10_000);
    expect(content).toContain("文章正文");
    expect(content).not.toContain("导航链接");
    expect(content).not.toContain("页脚");
  });

  it("没有 article 时退到 main", () => {
    const html = `<body><nav>导航</nav><main>主体内容</main><footer>页脚</footer></body>`;
    const { content } = extractPageText(html, 10_000);
    expect(content).toContain("主体内容");
    expect(content).not.toContain("导航");
  });

  it("都没有时用整个 body", () => {
    const html = `<body><div>内容一</div><div>内容二</div></body>`;
    const { content } = extractPageText(html, 10_000);
    expect(content).toContain("内容一");
    expect(content).toContain("内容二");
  });
});

describe("extractPageText · 排版", () => {
  it("块级标签转换行", () => {
    const html = `<body><p>第一段</p><p>第二段</p></body>`;
    expect(extractPageText(html, 10_000).content).toBe("第一段\n第二段");
  });

  it("br 转换行", () => {
    expect(extractPageText("<body>上<br>下</body>", 10_000).content).toBe("上\n下");
  });

  it("相邻行内标签不会粘成一个词", () => {
    // <b>a</b><i>b</i> 去标签后若不补空格会得到 "ab"
    expect(extractPageText("<body><b>你好</b><i>世界</i></body>", 10_000).content).toBe(
      "你好 世界",
    );
  });

  it("HTML 源码里的缩进与换行不影响正文", () => {
    const html = `<body>
        <p>
            缩进很深的段落
        </p>
    </body>`;
    expect(extractPageText(html, 10_000).content).toBe("缩进很深的段落");
  });

  it("连续空行压成至多一个空行", () => {
    const html = `<body><p>上</p>${"<div></div>".repeat(8)}<p>下</p></body>`;
    const { content } = extractPageText(html, 10_000);
    expect(content).not.toMatch(/\n{3,}/);
  });
});

describe("extractPageText · 截断", () => {
  it("超长正文被截断并标记", () => {
    const html = `<body><p>${"字".repeat(5000)}</p></body>`;
    const result = extractPageText(html, 1000);
    expect(result.content).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    // textLength 报告的是截断前的长度，便于调用方说明「原文多少字」
    expect(result.textLength).toBe(5000);
  });

  it("未超长时不标记截断", () => {
    const result = extractPageText("<body><p>短文</p></body>", 1000);
    expect(result.truncated).toBe(false);
    expect(result.textLength).toBe(2);
  });
});

describe("extractPageText · 健壮性", () => {
  it("空 HTML 返回空正文而不是抛", () => {
    const result = extractPageText("", 1000);
    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("只有标签没有文本时正文为空", () => {
    expect(extractPageText("<html><body><div></div></body></html>", 1000).content).toBe("");
  });

  it("畸形 HTML（未闭合标签）不挂起，有限时间内返回", () => {
    const started = Date.now();
    const html = `<body>${"<div>".repeat(500)}文本${"</div>".repeat(10)}</body>`;
    const result = extractPageText(html, 1000);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(typeof result.content).toBe("string");
  });

  it("超过输入上限时先截断再处理（不会因巨型输入卡住）", () => {
    // 上限之上再堆内容：这些内容不该出现在结果里
    const html = `<body><p>${"a".repeat(MAX_INPUT_CHARS)}尾部的哨兵文本</p></body>`;
    const started = Date.now();
    const result = extractPageText(html, 1000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.content).not.toContain("尾部的哨兵文本");
  });

  it("标签数超上限时放弃转换，回固定省略标记（不返回原始 HTML）", () => {
    // 构造超过 MAX_TAG_COUNT 的标签数
    const html = `<body>${"<i></i>".repeat(150_000)}<p>正文</p></body>`;
    const result = extractPageText(html, 10_000);
    expect(result.content).toBe(OMITTED_MARKER);
    // 标记本身不含尖括号，确保没有原始标签泄进模型可见文本
    expect(result.content).not.toContain("<");
  });

  /**
   * 病态输入下的线性保证。
   *
   * `dropNonContent` 必须是一次**单遍扫描**：早期实现用
   * `/<script[\s\S]*?<\/script>/g`，没有闭合标签时会一路扫到输入末尾，
   * N 个未闭合标签就是 N 次全量扫描（O(n²)）。实测 2MB 输入下 0.8–2.2 秒，
   * 而转换是同步的 —— 那期间工具的超时定时器根本打不着，表现就是「应用卡住」。
   *
   * 也试过「开闭标签配平检查」，但它在真实页面上市错的：nodejs.org 的 HTML 里
   * `-->` 出现 18 次而 `<!--` 一次都没有（那些是 JS 里的自减运算符 `i-->0`），
   * 按子串计数会把正常页面误判成畸形。下面有一条专门钉住这个回归。
   */
  describe("病态输入的线性保证", () => {
    it("未闭合的 script 洪水不会卡住", () => {
      const html = `<body>${"<script>".repeat(20_000)}<p>正文</p></body>`;
      const started = Date.now();
      extractPageText(html, 1000);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("未闭合的注释洪水不会卡住", () => {
      const html = `<body>${"<!--".repeat(50_000)}<p>正文</p></body>`;
      const started = Date.now();
      extractPageText(html, 1000);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("未闭合的 style / svg / noscript / template 同样不卡", () => {
      for (const tag of ["style", "svg", "noscript", "template"]) {
        const html = `<body><${tag}>` + `${"<div>".repeat(2000)}<p>正文</p>`;
        const started = Date.now();
        extractPageText(html, 1000);
        expect(Date.now() - started, tag).toBeLessThan(500);
      }
    });

    it("JS 里的自减运算符（i-->0）不会被当成未闭合注释", () => {
      // 这是真实页面（nodejs.org）里的形态：--> 多于 <!--，但页面完全正常。
      // 按「开闭配平」判断的实现会在这里整体放弃提取 —— 这条断言钉住那个回归。
      const html = `
        <body>
          <script>
            var i = 10;
            while (i --> 0) { doSomething(); }
            var j = 5;
            while (j --> 0) { other(); }
          </script>
          <p>正文内容</p>
        </body>`;
      const { content } = extractPageText(html, 1000);
      expect(content).toBe("正文内容");
    });

    it("script 的内容不会泄进正文（即使里面有像标签的东西）", () => {
      const html = `<body><script>var s = "<p>假正文</p>";</script><p>真正文</p></body>`;
      const { content } = extractPageText(html, 1000);
      expect(content).toBe("真正文");
      expect(content).not.toContain("假正文");
    });

    it("`<scriptfoo>` 不会被误当成 script（标签名边界）", () => {
      const html = `<body><scriptfoo>保留我</scriptfoo><p>正文</p></body>`;
      const { content } = extractPageText(html, 1000);
      expect(content).toContain("保留我");
    });
  });
});
