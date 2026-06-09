import { describe, expect, it } from "vitest";

import { convertLatexDelimiters } from "./latex-delimiters";

describe("convertLatexDelimiters", () => {
  it("converts inline math delimiters", () => {
    expect(convertLatexDelimiters("Inline \\(a + b\\) math")).toBe(
      "Inline $a + b$ math",
    );
  });

  it("converts block math delimiters", () => {
    expect(convertLatexDelimiters("Block \\[a + b\\] math")).toBe(
      "Block $$a + b$$ math",
    );
  });

  it("converts multiline block math delimiters", () => {
    const input = "\\[\n\\int_0^1 x^2 dx\n\\]";
    const expected = "$$\n\\int_0^1 x^2 dx\n$$";
    expect(convertLatexDelimiters(input)).toBe(expected);
  });

  it("preserves fenced code blocks", () => {
    const input = "```ts\nconst x = '\\\\(a\\\\)';\n```\n\\[b\\]";
    const expected = "```ts\nconst x = '\\\\(a\\\\)';\n```\n$$b$$";
    expect(convertLatexDelimiters(input)).toBe(expected);
  });

  it("preserves inline code spans", () => {
    const input = "Keep `\\(a\\)` but convert \\(b\\)";
    const expected = "Keep `\\(a\\)` but convert $b$";
    expect(convertLatexDelimiters(input)).toBe(expected);
  });

  it("converts multiple expressions", () => {
    const input = "\\(a\\) and \\[b\\] and \\(c\\)";
    const expected = "$a$ and $$b$$ and $c$";
    expect(convertLatexDelimiters(input)).toBe(expected);
  });
});
