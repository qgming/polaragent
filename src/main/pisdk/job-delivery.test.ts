// 后台作业结果组装的测试。
//
// 为什么单独测这层：作业的成败判据是**退出码**，而不是状态枚举 ——
// `exited` 既可能表示正常跑完（退出码 0），也可能表示跑挂了（退出码非 0），
// 而 `killed` 是「有人主动叫停」、不该算失败。这三条最容易写错，
// 且写错的表现是界面给错图标（把停掉的显示成跑挂的，或反过来），很难在手动测试里发现。

import { describe, expect, it } from "vitest";
import type { JobInfo, JobStatus } from "@/shared/contracts/job";
import {
  buildJobResult,
  describeJobOutcome,
  jobIsError,
  MAX_JOB_RESULT_CHARS,
} from "./job-delivery";

function makeJob(patch: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "job-1",
    sessionId: "s-1",
    command: "npm run dev",
    cwd: "D:/dev/proj",
    pid: 1234,
    status: "running",
    startedAt: 1_000,
    totalBytes: 0,
    truncated: false,
    ...patch,
  };
}

describe("jobIsError", () => {
  it("exited + 退出码 0 → 不算失败（正常跑完）", () => {
    expect(jobIsError(makeJob({ status: "exited", exitCode: 0, endedAt: 2_000 }))).toBe(false);
  });

  it("exited + 非零退出码 → 算失败（进程挂了）", () => {
    expect(jobIsError(makeJob({ status: "exited", exitCode: 1, endedAt: 2_000 }))).toBe(true);
    expect(jobIsError(makeJob({ status: "exited", exitCode: 127, endedAt: 2_000 }))).toBe(true);
  });

  it("failed → 算失败（服务侧已判定）", () => {
    expect(jobIsError(makeJob({ status: "failed" }))).toBe(true);
  });

  it("killed → **不算**失败：那是有人主动叫停，不是跑挂", () => {
    expect(jobIsError(makeJob({ status: "killed", endedAt: 2_000 }))).toBe(false);
  });

  it("exited 但没有退出码（被信号杀死）→ 不瞎猜成失败", () => {
    expect(jobIsError(makeJob({ status: "exited", endedAt: 2_000 }))).toBe(false);
  });

  it("running → 不算失败（还没结束）", () => {
    expect(jobIsError(makeJob({ status: "running" }))).toBe(false);
  });
});

describe("describeJobOutcome", () => {
  it("running 说的是「正在运行」，不是完成", () => {
    expect(describeJobOutcome(makeJob())).toContain("正在运行");
  });

  it("every status 都有可辨识的说法（重复意味着界面分不清这几种结束）", () => {
    const texts = (["running", "exited", "failed", "killed"] as JobStatus[]).map((status) =>
      describeJobOutcome(makeJob({ status, exitCode: status === "exited" ? 0 : undefined })),
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("退出码 0 说「已完成」，非 0 说「已退出」——两件事不能混成一句", () => {
    const ok = describeJobOutcome(makeJob({ status: "exited", exitCode: 0, endedAt: 2_000 }));
    const bad = describeJobOutcome(makeJob({ status: "exited", exitCode: 2, endedAt: 2_000 }));
    expect(ok).toContain("已完成");
    expect(ok).toContain("退出码 0");
    expect(bad).not.toContain("已完成");
    expect(bad).toContain("退出码 2");
  });

  it("被停止的带着「已停止」，不带退出码那套话术", () => {
    const text = describeJobOutcome(makeJob({ status: "killed", endedAt: 2_000 }));
    expect(text).toContain("已被停止");
    expect(text).toContain("用时");
  });

  it("有 endedAt 才报用时，跑着的作业不报一个假时长", () => {
    expect(describeJobOutcome(makeJob({ status: "running" }))).not.toContain("用时");
    expect(
      describeJobOutcome(makeJob({ status: "exited", exitCode: 0, endedAt: 61_000 })),
    ).toContain("用时 1m");
  });
});

describe("buildJobResult", () => {
  it("running 不产出结果：还没结束就没有结论可写", () => {
    expect(buildJobResult(makeJob(), "启动中")).toBeNull();
  });

  it("终态：状态 + 命令 + 工作目录 + 输出都在同一份结果里", () => {
    const result = buildJobResult(
      makeJob({ status: "exited", exitCode: 0, endedAt: 2_000 }),
      "ready in 320ms",
    );
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain("已完成");
    expect(result?.text).toContain("npm run dev"); // 命令：好几个作业时靠它区分
    expect(result?.text).toContain("D:/dev/proj");
    expect(result?.text).toContain("ready in 320ms");
  });

  it("没有捕获到输出时明说，而不是留一个空块", () => {
    const text = buildJobResult(makeJob({ status: "exited", exitCode: 0 }), "   ")?.text ?? "";
    expect(text).toContain("没有捕获到输出");
  });

  it("非零退出码 → isError 为真（界面据此给红叉）", () => {
    const result = buildJobResult(
      makeJob({ status: "exited", exitCode: 1, endedAt: 2_000 }),
      "boom",
    );
    expect(result?.isError).toBe(true);
  });

  it("被停止的 → isError 为假", () => {
    expect(buildJobResult(makeJob({ status: "killed", endedAt: 2_000 }), "partial")?.isError).toBe(
      false,
    );
  });

  it("告诉模型输出还能再读一次（drain 语义下这个指向很重要）", () => {
    const text = buildJobResult(makeJob({ status: "exited", exitCode: 0 }), "x")?.text ?? "";
    expect(text).toContain("job_output");
    expect(text).toContain("job-1");
  });

  it("超长输出被截断并写明原文长度", () => {
    const long = "x".repeat(MAX_JOB_RESULT_CHARS + 500);
    const text = buildJobResult(makeJob({ status: "exited", exitCode: 0 }), long)?.text ?? "";
    expect(text).toContain("输出已截断");
    expect(text).toContain(String(long.length));
    expect(text.length).toBeLessThan(long.length);
  });
});
