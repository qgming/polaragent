/**
 * 内置指令的执行逻辑（node project）。
 *
 * 这里钉的是三件容易悄悄坏掉的事：
 * 1. **可用性**：运行中 / 压缩中执行 `/compact` 必须被拦住，且原因分得清
 *    （内核会以 LaneBusy 拒收，界面要在此之前说清楚）；
 * 2. **参数**：`rest` 原样交给指令（`/compact 保留数据库讨论` 里的说明不能被吞掉）；
 * 3. **失败文案**：busy / nothing 是两种不同的结局，不能都显示成「压缩失败」。
 */

import { describe, expect, it, vi } from "vitest";
import type { CompactOutcome } from "@/shared/contracts/chat";
import { BUILTIN_COMMANDS, type CommandSpec, findCommandSpec } from "@/shared/contracts/commands";
import { compactFailureNotice, runCommand, unavailableReason } from "./commands";

const compact = BUILTIN_COMMANDS[0] as CommandSpec;

function deps(outcome: CompactOutcome) {
  const compactSpy = vi.fn(async () => outcome);
  return { compactSpy, deps: { compact: compactSpy } };
}

describe("内置指令清单", () => {
  it("compact 是内置指令：名称、参数口径与可用条件都写死在代码里", () => {
    expect(compact.id).toBe("compact");
    expect(compact.name).toBe("compact");
    // 说明是可选参数：`/compact 保留数据库相关的讨论`
    expect(compact.argMode).toBe("rest");
    // 压缩要占 lane，运行中或已在压缩时不可用
    expect(compact.availability).toBe("idle");
  });

  it("按名字找指令时不区分大小写（与斜杠菜单的匹配口径一致）", () => {
    expect(findCommandSpec("Compact")?.id).toBe("compact");
    expect(findCommandSpec("nope")).toBeUndefined();
  });
});

describe("unavailableReason", () => {
  it("空闲时可用", () => {
    expect(unavailableReason(compact, { running: false, compacting: false })).toBeNull();
  });

  it("运行中被拒（内核一定会以 LaneBusy 拒收，界面先说明白）", () => {
    expect(unavailableReason(compact, { running: true, compacting: false })?.messageKey).toBe(
      "chat.commandUnavailableRunning",
    );
  });

  it("压缩中被拒", () => {
    expect(unavailableReason(compact, { running: false, compacting: true })?.messageKey).toBe(
      "chat.commandUnavailableCompacting",
    );
  });

  it("运行中优先报「运行中」：那时更该等这一轮结束，而不是等压缩", () => {
    expect(unavailableReason(compact, { running: true, compacting: true })?.messageKey).toBe(
      "chat.commandUnavailableRunning",
    );
  });
});

describe("runCommand", () => {
  it("成功：调用 compact 并原样带上说明", async () => {
    const { compactSpy, deps: d } = deps({ ok: true });
    await expect(runCommand(compact, "保留数据库相关的讨论", d)).resolves.toEqual({ ok: true });
    expect(compactSpy).toHaveBeenCalledWith("保留数据库相关的讨论");
  });

  it("只敲命令名：不带参数调用（而不是带一个空串）", async () => {
    const { compactSpy, deps: d } = deps({ ok: true });
    await runCommand(compact, "   ", d);
    expect(compactSpy).toHaveBeenCalledWith(undefined);
  });

  it("busy：一句话说明会话正忙，不是「压缩失败」", async () => {
    const { deps: d } = deps({ ok: false, code: "busy", message: "会话正忙，暂时无法压缩上下文" });
    await expect(runCommand(compact, "", d)).resolves.toEqual({
      ok: false,
      notice: { messageKey: "chat.compactBusy", level: "error" },
    });
  });

  it("没什么可压：这是**正常结局**，用 info 而不是 error", async () => {
    const { deps: d } = deps({ ok: false, code: "nothing", message: "没有可压缩的历史" });
    await expect(runCommand(compact, "", d)).resolves.toEqual({
      ok: false,
      notice: { messageKey: "chat.compactNothing", level: "info" },
    });
  });

  it("其他失败：带上主进程给的原因（未知 code 也要有话说）", async () => {
    const { deps: d } = deps({ ok: false, code: "failed", message: "压缩上下文失败：模型超时" });
    await expect(runCommand(compact, "", d)).resolves.toEqual({
      ok: false,
      notice: {
        messageKey: "chat.compactFailed",
        params: { error: "压缩上下文失败：模型超时" },
        level: "error",
      },
    });
  });

  it("不接受参数的命令多写了就报用法（不静默丢弃用户输入）", async () => {
    const noArgs: CommandSpec = { ...compact, id: "compact", argMode: "none" };
    const { compactSpy, deps: d } = deps({ ok: true });
    await expect(runCommand(noArgs, "别压缩这一段", d)).resolves.toEqual({
      ok: false,
      notice: {
        messageKey: "chat.commandNoArguments",
        params: { name: "compact" },
        level: "error",
      },
    });
    expect(compactSpy).not.toHaveBeenCalled();
  });
});

describe("compactFailureNotice", () => {
  it("三种 code 给出三种不同的话", () => {
    const keys = (["busy", "nothing", "failed"] as const).map(
      (code) => compactFailureNotice({ ok: false, code, message: "m" }).messageKey,
    );
    expect(new Set(keys).size).toBe(3);
  });
});
