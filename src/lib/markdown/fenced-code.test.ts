import { describe, expect, it } from "vitest";

import { isClosedFencedCodeBlock } from "./fenced-code";

describe("isClosedFencedCodeBlock", () => {
  it("detects a closed mermaid fenced block", () => {
    const source = "```mermaid\nflowchart TD\n  A --> B\n```";
    expect(isClosedFencedCodeBlock(source, "mermaid", "flowchart TD\n  A --> B")).toBe(
      true,
    );
  });

  it("detects an unclosed mermaid fenced block", () => {
    const source = "```mermaid\nflowchart TD\n  A --> B";
    expect(isClosedFencedCodeBlock(source, "mermaid", "flowchart TD\n  A --> B")).toBe(
      false,
    );
  });

  it("supports tildes and info string metadata", () => {
    const source = "~~~mermaid title=\"x\"\nflowchart TD\n  A --> B\n~~~";
    expect(isClosedFencedCodeBlock(source, "mermaid", "flowchart TD\n  A --> B")).toBe(
      true,
    );
  });

  it("handles a closed block before an unclosed block", () => {
    const first = "flowchart TD\n  A --> B";
    const second = "flowchart TD\n  C --> D";
    const source = `\`\`\`mermaid\n${first}\n\`\`\`\n\n\`\`\`mermaid\n${second}`;

    expect(isClosedFencedCodeBlock(source, "mermaid", first)).toBe(true);
    expect(isClosedFencedCodeBlock(source, "mermaid", second)).toBe(false);
  });
});
