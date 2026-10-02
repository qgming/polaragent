import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("recovers drafts across a module restart and removes saved buffers", async () => {
  const first = await import("./unsaved-edits");
  first.rememberUnsaved("D:/notes.txt", "draft", "original");
  vi.resetModules();
  const recovered = await import("./unsaved-edits");
  expect(recovered.unsavedOf("D:/notes.txt")).toBe("draft");
  expect(recovered.unsavedBaseOf("D:/notes.txt")).toBe("original");
  recovered.forgetUnsaved("D:/notes.txt");
  vi.resetModules();
  expect((await import("./unsaved-edits")).unsavedOf("D:/notes.txt")).toBeNull();
});

it("ignores damaged recovery records and preserves memory on quota errors", async () => {
  localStorage.setItem("oint.file-drafts.v1", "invalid json");
  const drafts = await import("./unsaved-edits");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => drafts.rememberUnsaved("D:/notes.txt", "safe in memory", "original")).not.toThrow();
  expect(drafts.unsavedOf("D:/notes.txt")).toBe("safe in memory");
});
