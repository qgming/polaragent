// bash 结果的退出码与 spill 契约：装配在 tools.ts 里的包装必须让每条结果都带 [exited with code N]，
// 且不改变内核原有的行为 —— stderr 仍合并进输出、超时仍抛内核的文案、非零退出仍是错误。
// 另外钉住「截断后给出的 Full output 路径能被 read 打开」：spill 目录必须在会话环境的允许根里。
//
// 用真实 shell 跑（与 exec-env.test.ts 同一个姿态）：没有可用 shell 的环境直接跳过断言。

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentHarnessToolInvocation,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecEnv } from "../exec-env";
import { buildTools } from "../tools";

let root: string;
let env: ExecutionEnv;

const INVOCATION: AgentHarnessToolInvocation = {
  invocationId: "call-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

type BashOutcome = { ok: true; text: string } | { ok: false; error: Error };

/** 走装配后的 bash 工具（包装在 tools.ts），异常也收进返回值里方便断言 */
async function runBash(command: string, timeout?: number): Promise<BashOutcome> {
  const tool = buildTools().find((candidate) => candidate.name === "bash");
  if (tool === undefined) throw new Error("缺少 bash 工具");
  try {
    const result = await tool.execute(
      "call-bash",
      { command, ...(timeout === undefined ? {} : { timeout }) },
      () => {},
      { env } as never,
      INVOCATION,
      BACKGROUND_CONTEXT,
    );
    return {
      ok: true,
      text: result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 本机没有可用 shell（CI 的裸 Windows 等）：用例不判定失败，其余错误照常交给断言 */
function skipIfNoShell(outcome: BashOutcome): boolean {
  if (outcome.ok) return false;
  const code = (outcome.error.cause as { code?: string } | undefined)?.code;
  return code === "shell_unavailable" || code === "spawn_error";
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-bash-"));
  // 允许根与会话环境一致（见 runtime 的 sessionAllowedRoots）：系统临时目录必须在里面，
  // 否则 bash spill 的 "Full output: <path>" 读不了，这条链就没法端到端验证
  env = await createExecEnv({ cwd: root, allowedRoots: [os.tmpdir()] });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bash 退出码", () => {
  it("成功时结果以 [exited with code 0] 收尾", async () => {
    const outcome = await runBash("echo hello");
    if (skipIfNoShell(outcome)) return;
    if (!outcome.ok) throw outcome.error;

    expect(outcome.text).toBe("hello\n\n[exited with code 0]");
  });

  it("非零退出：stderr 仍合并进输出，错误文本同样以 [exited with code 3] 收尾", async () => {
    const outcome = await runBash("echo boom 1>&2; exit 3");
    if (skipIfNoShell(outcome)) return;
    if (outcome.ok) throw new Error(`应当失败，却得到：${outcome.text}`);

    // 结果从「异常」变成「带退出码的异常」：isError 语义不变，模型能从文本里直接读到退出码
    expect(outcome.error.message).toBe("boom\n\n[exited with code 3]");
  });

  it("超时的既有文案原样保留（没有退出码可报的异常不加工）", async () => {
    const outcome = await runBash("sleep 5", 1);
    if (skipIfNoShell(outcome)) return;
    if (outcome.ok) throw new Error(`应当超时，却得到：${outcome.text}`);

    expect(outcome.error.message).toBe("Command timed out after 1 seconds");
  });
});

describe("超长输出的 spill 文件", () => {
  it("截断后给出的 Full output 路径能被 read 直接打开（spill 目录在允许根里）", async () => {
    const outcome = await runBash(
      "node -e \"for (let i = 0; i < 4000; i++) console.log('spill-line-' + i);\"",
    );
    if (skipIfNoShell(outcome)) return;
    if (!outcome.ok) throw outcome.error;

    // 路径在 "[Showing lines … . Full output: <path>]" 里；退出码行接在这个尾注之后，所以不锚定行尾
    const spillPath = /Full output: ([^\]\n]+)/.exec(outcome.text)?.[1];
    expect(spillPath).toBeTruthy();
    if (spillPath === undefined) return;
    try {
      const read = buildTools().find((candidate) => candidate.name === "read");
      if (read === undefined) throw new Error("缺少 read 工具");
      const readResult = await read.execute(
        "call-read",
        { path: spillPath },
        () => {},
        { env } as never,
        INVOCATION,
        BACKGROUND_CONTEXT,
      );
      const text = readResult.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      // spill 在系统临时目录下：曾经的允许根只有工作目录与数据目录，read 会直接拒绝这条路径
      expect(text.startsWith("   1\tspill-line-0")).toBe(true);
    } finally {
      // 落盘目录是内核为这次 spill 新建的一次性目录：验证完就清掉，别留在系统临时目录里
      await rm(path.dirname(spillPath), { recursive: true, force: true });
    }
  });
});
