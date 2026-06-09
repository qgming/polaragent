import { describe, expect, it } from "vitest";

import { normalizeMarkdownContent } from "./normalize";

describe("normalizeMarkdownContent", () => {
  it("converts latex delimiters by default", () => {
    expect(normalizeMarkdownContent("\\(x\\)")).toBe("$x$");
  });

  it("can disable latex delimiter conversion", () => {
    expect(normalizeMarkdownContent("\\(x\\)", { convertLatex: false })).toBe(
      "\\(x\\)",
    );
  });

  it("strips file protocol when requested", () => {
    expect(
      normalizeMarkdownContent("file:///D:/tmp/a.png", {
        stripFileProtocol: true,
        convertLatex: false,
      }),
    ).toBe("/D:/tmp/a.png");
  });

  it("rewrites github wiki media urls", () => {
    expect(
      normalizeMarkdownContent(
        "![x](https://github.com/acme/demo/wiki/image.png)",
        {
          rewriteExternalMediaUrls: true,
          convertLatex: false,
        },
      ),
    ).toBe("![x](https://raw.githubusercontent.com/wiki/acme/demo/image.png)");
  });

  it("encodes raw ampersands in html media attributes", () => {
    expect(
      normalizeMarkdownContent('<img src="https://example.com/a.png?x=1&y=2">', {
        encodeHtmlMediaAttributes: true,
        convertLatex: false,
      }),
    ).toBe('<img src="https://example.com/a.png?x=1&amp;y=2">');
  });
});
