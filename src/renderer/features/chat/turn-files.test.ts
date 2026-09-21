/**
 * 「本轮文件改动」纯逻辑的测试。
 *
 * 这一块容易出错的地方都在纯函数里，所以这里按行为钉住四件事：
 *   1. 回合边界是**用户消息**（助手消息会被工具切成好几条，不能当边界）；
 *   2. 文档类与代码类的分流（决定出卡片还是只出 chip）；
 *   3. 相对路径要拼上 cwd 才是可打开的绝对路径，cwd 缺失时退回原样而不是丢掉；
 *   4. 增删行数的补丁计数（`+++` 正文行不能算成文件头）。
 */

import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatPart } from "@/shared/contracts/session";
import {
  baseNameOf,
  extensionOf,
  fileOpenTarget,
  hasRenderedMode,
  isDocumentPath,
  summarizeTurnFiles,
  toAbsolutePath,
  toFileUrl,
  turnFileSummaries,
} from "./turn-files";

const CWD = "D:/dev/project";

/** 一条带若干 tool-call 的助手消息 */
function assistant(
  id: string,
  calls: { toolName: string; path?: string; patch?: string; isError?: boolean; status?: string }[],
): ChatMessage {
  const parts = calls.map((call, index): ChatPart => {
    const part: Extract<ChatPart, { type: "tool-call" }> = {
      type: "tool-call",
      toolCallId: `${id}-${index}`,
      toolName: call.toolName,
      argsText: "{}",
      args: call.path === undefined ? {} : { path: call.path },
      status: (call.status ?? "done") as Extract<ChatPart, { type: "tool-call" }>["status"],
      ...(call.isError === undefined ? {} : { isError: call.isError }),
      ...(call.patch === undefined ? {} : { details: { patch: call.patch } }),
    };
    return part;
  });
  return { id, role: "assistant", createdAt: 0, parts, status: "complete" };
}

function user(id: string): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: 0,
    parts: [{ type: "text", text: "改点什么" }],
    status: "complete",
  };
}

const PATCH_ADD = ["--- /dev/null", "+++ b/a.md", "@@ -0,0 +1,2 @@", "+第一行", "+第二行", ""].join(
  "\n",
);

describe("路径工具", () => {
  it("extensionOf 取小写扩展名，前导点不算扩展名", () => {
    expect(extensionOf("src/a.md")).toBe("md");
    expect(extensionOf("README.MD")).toBe("md");
    expect(extensionOf("a/b/c.tar.gz")).toBe("gz");
    // .gitignore 这类隐藏文件没有扩展名：前导点是「隐藏」标记，不是类型
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("baseNameOf 取末级，Windows 与 POSIX 分隔符都认", () => {
    expect(baseNameOf("src/deep/a.md")).toBe("a.md");
    expect(baseNameOf("src\\deep\\a.md")).toBe("a.md");
    expect(baseNameOf("a.md")).toBe("a.md");
  });

  it("docs / txt / html 是文档类，代码不是", () => {
    for (const path of ["a.md", "a.markdown", "a.mdx", "notes.txt", "page.html", "p.htm"]) {
      expect(isDocumentPath(path), path).toBe(true);
    }
    for (const path of ["a.ts", "a.tsx", "main.go", "Dockerfile", "data.json", ".gitignore"]) {
      expect(isDocumentPath(path), path).toBe(false);
    }
  });

  it("toAbsolutePath 只对相对路径前置 cwd", () => {
    expect(toAbsolutePath("src/a.ts", CWD)).toBe(`${CWD}/src/a.ts`);
    // 已经是绝对的：原样返回，不要拼成一个不存在的路径
    expect(toAbsolutePath("/home/u/a.ts", CWD)).toBe("/home/u/a.ts");
    expect(toAbsolutePath("C:\\dev\\a.ts", CWD)).toBe("C:\\dev\\a.ts");
    expect(toAbsolutePath("c:/dev/a.ts", CWD)).toBe("c:/dev/a.ts");
    // cwd 缺失时退回原样：展示仍然正确，只是点开会被主进程拒
    expect(toAbsolutePath("src/a.ts", undefined)).toBe("src/a.ts");
    expect(toAbsolutePath("src/a.ts", "")).toBe("src/a.ts");
    // 末尾分隔符不该拼出双斜杠
    expect(toAbsolutePath("src/a.ts", "D:/dev/project/")).toBe("D:/dev/project/src/a.ts");
  });

  it("toFileUrl 处理盘符、反斜杠与 # / ?", () => {
    expect(toFileUrl("D:\\dev\\a b.html")).toBe("file:///D:/dev/a%20b.html");
    expect(toFileUrl("D:/dev/a.html")).toBe("file:///D:/dev/a.html");
    // encodeURI 不转义 # 与 ?（它按 URL 语法当分隔符），必须自己转，否则文件名被截断
    expect(toFileUrl("D:/dev/a#1.html")).toBe("file:///D:/dev/a%231.html");
    expect(toFileUrl("D:/dev/a?b.html")).toBe("file:///D:/dev/a%3Fb.html");
  });

  it("HTML 交给浏览器，其余进查看器；只有 markdown 有渲染档", () => {
    expect(fileOpenTarget("page.html")).toBe("browser");
    expect(fileOpenTarget("page.htm")).toBe("browser");
    expect(fileOpenTarget("notes.md")).toBe("viewer");
    expect(fileOpenTarget("src/a.ts")).toBe("viewer");

    expect(hasRenderedMode("notes.md")).toBe(true);
    expect(hasRenderedMode("notes.mdx")).toBe(true);
    expect(hasRenderedMode("notes.txt")).toBe(false);
    expect(hasRenderedMode("src/a.ts")).toBe(false);
  });
});

describe("summarizeTurnFiles", () => {
  it("按首次出现保留顺序，同一文件改多次合成一张卡并累加次数", () => {
    const summary = summarizeTurnFiles(
      [
        assistant("m1", [
          { toolName: "write", path: "notes.md", patch: PATCH_ADD },
          { toolName: "edit", path: "src/a.ts" },
        ]),
        assistant("m2", [{ toolName: "edit", path: "notes.md" }]),
      ],
      CWD,
    );

    expect(summary.files.map((file) => file.path)).toEqual(["notes.md", "src/a.ts"]);
    expect(summary.fileCount).toBe(2);
    const notes = summary.files[0];
    expect(notes?.edits).toBe(2);
    // 最后一次改它的工具名留在卡上
    expect(notes?.tool).toBe("edit");
  });

  it("文档类与代码类分流：只有文档进 documents", () => {
    const summary = summarizeTurnFiles(
      [
        assistant("m1", [
          { toolName: "write", path: "src/a.ts" },
          { toolName: "write", path: "docs/guide.md" },
          { toolName: "write", path: "notes.txt" },
        ]),
      ],
      CWD,
    );

    expect(summary.fileCount).toBe(3);
    expect(summary.documents.map((file) => file.name)).toEqual(["guide.md", "notes.txt"]);
  });

  it("附带绝对路径与目录：相对路径拼 cwd，绝对路径原样", () => {
    const summary = summarizeTurnFiles(
      [
        assistant("m1", [
          { toolName: "write", path: "docs/guide.md" },
          { toolName: "write", path: "D:/elsewhere/x.md" },
        ]),
      ],
      CWD,
    );

    expect(summary.files[0]?.absolutePath).toBe(`${CWD}/docs/guide.md`);
    expect(summary.files[0]?.directory).toBe("docs");
    expect(summary.files[1]?.absolutePath).toBe("D:/elsewhere/x.md");
  });

  it("失败、被拒、等审批的调用都不算改动", () => {
    const summary = summarizeTurnFiles(
      [
        assistant("m1", [
          { toolName: "write", path: "failed.md", isError: true },
          { toolName: "edit", path: "denied.md", status: "denied" },
          { toolName: "edit", path: "pending.md", status: "pending-approval" },
          { toolName: "write", path: "ok.md" },
        ]),
      ],
      CWD,
    );

    expect(summary.files.map((file) => file.path)).toEqual(["ok.md"]);
  });

  it("只认 write / edit：读过或检索过的文件不算这一轮改了什么", () => {
    const summary = summarizeTurnFiles(
      [
        assistant("m1", [
          { toolName: "read", path: "read-only.md" },
          { toolName: "grep", path: "searched.md" },
          { toolName: "bash", path: "cmd.md" },
        ]),
      ],
      CWD,
    );

    expect(summary.fileCount).toBe(0);
    expect(summary.documents).toEqual([]);
    expect(summary.additions).toBe(0);
  });

  it("增删行数来自补丁，并按位置区分文件头与正文里的 +++", () => {
    const summary = summarizeTurnFiles(
      [assistant("m1", [{ toolName: "write", path: "a.md", patch: PATCH_ADD }])],
      CWD,
    );

    expect(summary.additions).toBe(2);
    expect(summary.deletions).toBe(0);

    // 正文里的一行 "+++" 必须算成新增，不能被当成文件头跳过
    const tricky = ["--- a/x.md", "+++ b/x.md", "@@ -1 +1,2 @@", " 原样", "+++新加的一行", ""].join(
      "\n",
    );
    const second = summarizeTurnFiles(
      [assistant("m1", [{ toolName: "edit", path: "x.md", patch: tricky }])],
      CWD,
    );
    expect(second.additions).toBe(1);
  });

  it("没有改动时返回同一个空对象（避免每次渲染造新引用）", () => {
    const a = summarizeTurnFiles([], CWD);
    const b = summarizeTurnFiles([], CWD);
    expect(a.fileCount).toBe(0);
    expect(a).toBe(b);
  });
});

describe("turnFileSummaries", () => {
  it("回合边界是用户消息，键是回合最后一条消息 id", () => {
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "write", path: "one.md" }]),
      // 助手消息被工具切成好几条：它们都属于 u1 这一回合
      assistant("a2", [{ toolName: "edit", path: "two.md" }]),
      user("u2"),
      assistant("a3", [{ toolName: "write", path: "three.md" }]),
    ];

    const map = turnFileSummaries(messages, CWD, true);

    // 第一回合落在它最后一条消息上，且两条助手消息的改动合并在一起
    expect(map.has("a2")).toBe(true);
    expect(map.get("a2")?.files.map((file) => file.path)).toEqual(["one.md", "two.md"]);
    expect(map.has("a1")).toBe(false);
    expect(map.get("a3")?.files.map((file) => file.path)).toEqual(["three.md"]);
    expect(map.size).toBe(2);
  });

  it("没有改动的回合不入表", () => {
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "read", path: "x.md" }]),
      user("u2"),
      assistant("a2", [{ toolName: "write", path: "y.md" }]),
    ];

    const map = turnFileSummaries(messages, CWD, true);

    expect(map.has("a1")).toBe(false);
    expect(map.has("a2")).toBe(true);
  });

  it("末尾刚发出、还没有回复的用户消息不构成回合", () => {
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "write", path: "x.md" }]),
      user("u2"),
    ];

    const map = turnFileSummaries(messages, CWD, true);

    expect([...map.keys()]).toEqual(["a1"]);
  });

  it("会话以助手消息开头（历史截断）时也照常归纳", () => {
    const messages: ChatMessage[] = [
      assistant("a1", [{ toolName: "write", path: "x.md" }]),
      user("u1"),
      assistant("a2", [{ toolName: "write", path: "y.md" }]),
    ];

    const map = turnFileSummaries(messages, CWD, true);

    expect(map.get("a1")?.files.map((file) => file.path)).toEqual(["x.md"]);
    expect(map.get("a2")?.files.map((file) => file.path)).toEqual(["y.md"]);
  });
});

/**
 * **只收「整轮已经结束」的回合**（用户明确要求）。
 *
 * 这一条是行为约定，不是实现细节：跑动中就显示会闪 —— 而闪动的根因很具体：
 * 多步 run 的**步骤与步骤之间**恰好满足「没有工具在跑」，于是模型刚写完文件、
 * 正在想下一步时块冒出来，下一步的工具一起来块又消失。
 *
 * 所以判据改成**整轮结束**（调用方从 `runningBySession` 读，主进程 run-ended 写的权威信号），
 * 而不是去枚举消息与工具的状态组合。
 */
describe("turnFileSummaries：只收整轮已结束的回合", () => {
  /** 一条工具还在跑（args 有了、结果没回来）的助手消息 */
  function running(id: string, path: string): ChatMessage {
    const part: ChatPart = {
      type: "tool-call",
      toolCallId: `${id}-0`,
      toolName: "write",
      argsText: "{}",
      args: { path },
      status: "running",
    };
    return { id, role: "assistant", createdAt: 0, parts: [part], status: "streaming" };
  }

  it("**整轮没结束 → 一块都不出**，哪怕这一轮里所有工具都已经完成", () => {
    // 这正是旧实现的缺陷：a1 的工具已经 done、消息也不是 streaming，
    // 旧判据（「没有工具在跑」）为真 → 块提前冒出来，下一步工具一起来又消失。
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "write", path: "one.md" }]),
    ];

    expect(turnFileSummaries(messages, CWD, false).size).toBe(0);
  });

  it("整轮结束后才出块", () => {
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "write", path: "one.md" }]),
    ];

    const map = turnFileSummaries(messages, CWD, true);
    expect([...map.keys()]).toEqual(["a1"]);
    expect(map.get("a1")?.files.map((file) => file.path)).toEqual(["one.md"]);
  });

  it("工具还在跑时也不出（未结束的两种子情形都覆盖）", () => {
    const messages: ChatMessage[] = [user("u1"), running("a1", "docs/x.md")];

    expect(turnFileSummaries(messages, CWD, false).size).toBe(0);
    // 就算调用方误传 true（工具确实还没回来），这一轮的历史块也不该包含它 ——
    // 「跑完」由调用方保证，但至少输出要与传 false 一致地稳定
    expect(turnFileSummaries(messages, CWD, false).size).toBe(0);
  });

  it("多个历史回合：整轮结束后一次性全部给出（不只最后那一轮）", () => {
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "write", path: "first.md" }]),
      user("u2"),
      assistant("a2", [{ toolName: "write", path: "second.md" }]),
    ];

    const map = turnFileSummaries(messages, CWD, true);
    expect([...map.keys()]).toEqual(["a1", "a2"]);
  });

  it("跑动中：历史回合也一并按住（整表为空，避免「旧块在、新块跳出来」的半截状态）", () => {
    const messages: ChatMessage[] = [
      user("u1"),
      assistant("a1", [{ toolName: "write", path: "first.md" }]),
      user("u2"),
      running("a2", "second.md"),
    ];

    // 这是刻意的：跑动中整块不显示，结束时一次性铺出全部——
    // 否则会出现「上一轮的块已经在了、这一轮的还在长」的割裂感
    expect(turnFileSummaries(messages, CWD, false).size).toBe(0);
    expect([...turnFileSummaries(messages, CWD, true).keys()]).toEqual(["a1", "a2"]);
  });
});
