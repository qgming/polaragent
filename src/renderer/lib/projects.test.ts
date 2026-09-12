import { describe, expect, it } from "vitest";
import type { Project, SessionSummary } from "@/shared/contracts";
import {
  buildSidebarSections,
  findProjectForCwd,
  isPathInside,
  normalizePathForMatch,
} from "./projects";

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: null,
    createdAt: 0,
    updatedAt: 0,
    cwd: "",
    archived: false,
    pinned: false,
    messageCount: 0,
    ...overrides,
    // 展开之后再兜一次：契约要求 model 必填，而 overrides 里没给时会是 undefined
    model: overrides.model ?? null,
  };
}

function project(id: string, path: string, createdAt = 0): Project {
  return { id, name: path.split(/[\\/]/).pop() ?? path, path, createdAt };
}

describe("normalizePathForMatch", () => {
  it("统一分隔符并去掉末尾分隔符", () => {
    expect(normalizePathForMatch("D:\\dev\\oint\\")).toBe("d:/dev/oint");
    expect(normalizePathForMatch("/home/me/proj/")).toBe("/home/me/proj");
    expect(normalizePathForMatch("  D:\\dev  ")).toBe("d:/dev");
  });

  it("只在 Windows 盘符路径上折小写", () => {
    expect(normalizePathForMatch("D:/Dev/Oint")).toBe("d:/dev/oint");
    // POSIX 路径大小写敏感，不能折
    expect(normalizePathForMatch("/Home/Me")).toBe("/Home/Me");
  });
});

describe("isPathInside", () => {
  it("同目录与子目录算命中", () => {
    expect(isPathInside("D:\\dev\\oint", "D:\\dev\\oint")).toBe(true);
    expect(isPathInside("D:\\dev\\oint\\src\\renderer", "D:\\dev\\oint")).toBe(true);
    expect(isPathInside("D:/dev/oint", "d:\\Dev\\Oint\\")).toBe(true);
  });

  it("前缀相同但不同目录不算命中", () => {
    expect(isPathInside("D:\\devious", "D:\\dev")).toBe(false);
    expect(isPathInside("D:\\dev", "D:\\dev\\oint")).toBe(false);
  });

  it("空路径（未绑定工作目录）不算命中", () => {
    expect(isPathInside("", "D:\\dev")).toBe(false);
    expect(isPathInside("   ", "D:\\dev")).toBe(false);
    expect(isPathInside("D:\\dev", "")).toBe(false);
  });
});

describe("findProjectForCwd", () => {
  const outer = project("outer", "D:\\dev");
  const inner = project("inner", "D:\\dev\\oint");

  it("嵌套项目取最具体的那个", () => {
    expect(findProjectForCwd("D:\\dev\\oint\\src", [outer, inner])?.id).toBe("inner");
    expect(findProjectForCwd("D:\\dev\\other", [outer, inner])?.id).toBe("outer");
    // 命中顺序不影响结果
    expect(findProjectForCwd("D:\\dev\\oint\\src", [inner, outer])?.id).toBe("inner");
  });

  it("没有命中返回 null", () => {
    expect(findProjectForCwd("D:\\elsewhere", [outer, inner])).toBeNull();
    expect(findProjectForCwd("", [outer, inner])).toBeNull();
    expect(findProjectForCwd("D:\\dev", [])).toBeNull();
  });
});

describe("buildSidebarSections", () => {
  const projA = project("a", "D:\\work\\alpha", 10);
  const projB = project("b", "D:\\work\\beta", 20);

  it("置顶优先，且不再出现在项目/最近里", () => {
    const sections = buildSidebarSections(
      [
        session({ id: "s1", cwd: "D:\\work\\alpha", pinned: true, updatedAt: 5 }),
        session({ id: "s2", cwd: "D:\\work\\alpha", updatedAt: 4 }),
        session({ id: "s3", updatedAt: 3 }),
      ],
      [projA, projB],
    );

    expect(sections.pinned.map((item) => item.id)).toEqual(["s1"]);
    expect(sections.projects.map((item) => item.project.id)).toEqual(["a", "b"]);
    expect(sections.projects[0]?.sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(sections.recent.map((item) => item.id)).toEqual(["s3"]);
  });

  it("未绑定工作目录的会话留在最近", () => {
    const sections = buildSidebarSections(
      [session({ id: "s1", cwd: "" }), session({ id: "s2", cwd: "D:\\work\\beta" })],
      [projA, projB],
    );

    expect(sections.recent.map((item) => item.id)).toEqual(["s1"]);
    expect(sections.projects.find((item) => item.project.id === "b")?.sessions).toHaveLength(1);
  });

  it("有会话的项目排在空项目前面，组内保持传入顺序", () => {
    const sections = buildSidebarSections(
      [
        session({ id: "s1", cwd: "D:\\work\\beta", updatedAt: 100 }),
        session({ id: "s2", cwd: "D:\\work\\beta", updatedAt: 50 }),
      ],
      [projA, projB],
    );

    expect(sections.projects.map((item) => item.project.id)).toEqual(["b", "a"]);
    expect(sections.projects[0]?.sessions.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(sections.projects[1]?.sessions).toEqual([]);
  });

  it("项目里的会话全部置顶时 pinnedCount 仍算得出来（界面据此不显示空态）", () => {
    const sections = buildSidebarSections(
      [session({ id: "s1", cwd: "D:\\work\\alpha", pinned: true })],
      [projA, projB],
    );

    expect(sections.pinned.map((item) => item.id)).toEqual(["s1"]);
    const alpha = sections.projects.find((item) => item.project.id === "a");
    expect(alpha?.sessions).toEqual([]);
    expect(alpha?.pinnedCount).toBe(1);
    // 置顶会话的工作目录不在任何项目里时，不落到任何项目的计数上
    expect(sections.projects.find((item) => item.project.id === "b")?.pinnedCount).toBe(0);
  });

  it("全部为空时三个分组都为空", () => {
    const sections = buildSidebarSections([], []);
    expect(sections).toEqual({ pinned: [], projects: [], recent: [] });
  });
});
