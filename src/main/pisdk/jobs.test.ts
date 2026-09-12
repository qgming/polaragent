// jobs 单测：真实进程的作业生命周期、drain 语义、上限淘汰、会话 fence、kill 与清理。
//
// 命令一律写成 `node <脚本文件名>`，作业 cwd 就是临时目录 —— 命令里没有空格也没有引号：
// - 不依赖 bash / cmd / timeout 等外部命令，Windows 与 POSIX 走同一条路径；
// - 引号在不同 shell 上的下场不一样（作业命令最后是交给 shell 再去起 node 的）：Windows 上
//   没有 Git Bash 时兜底是 cmd.exe，带引号的命令会被参数转义打坏（独立探针实测
//   `node -e "console.log(1)"` 经这条链路跑不出任何输出），所以脚本落成临时文件、命令只带裸文件名。
//
// 「脚本什么时候写下一段输出」由脚本轮询一个 gate 文件决定（见 gatedScript）：测试能精确控制
// 两次 read 之间的输出，不必用 sleep 赌时序。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type { JobInfo } from "@/shared/contracts/job";
import { createJobService, type JobService, type JobServiceDeps } from "./jobs";

/** 被测会话；另一个会话用来验证 fence */
const SESSION = "s1";
const OTHER_SESSION = "s2";
/** 调小缓冲（1024 → 头部采样 128 字节）：让 read 真的走「头部 + 滚动窗口」那条路径 */
const SMALL_BUFFER_BYTES = 1024;

let dir = "";
let originalPath = "";

/** 脚本写到临时目录；命令里的脚本名是相对名，命令因此不含空格与引号 */
function writeScript(name: string, source: string): string {
  writeFileSync(path.join(dir, name), source, "utf8");
  return name;
}

/** 作业命令：只跑 node 本体（process.execPath 含空格时退回 PATH 上的 node） */
function nodeCommand(file: string): string {
  const exe = /[\s"']/.test(process.execPath) ? "node" : process.execPath;
  return `${exe} ${file}`;
}

/**
 * 脚本：先写 before，等 gate 文件出现后再写 after 并自然退出（退出码 0）。
 * 这样测试能确定「read 第一次返回时脚本还没写 after」。
 */
function gatedScript(gate: string, before: string, after: string): string {
  return [
    "const fs = require('node:fs');",
    `const gate = ${JSON.stringify(gate)};`,
    `process.stdout.write(${JSON.stringify(before)});`,
    "const timer = setInterval(() => {",
    "  if (!fs.existsSync(gate)) return;",
    "  clearInterval(timer);",
    `  process.stdout.write(${JSON.stringify(after)});`,
    "}, 20);",
    "// 兜底：测试挂了也别把这个进程留在机器上（正常路径下它早就退出了）",
    "setTimeout(() => process.exit(9), 10_000).unref();",
  ].join("\n");
}

interface Harness {
  service: JobService;
  /** 原始信封：断言事件归属的会话 id 与事件内容 */
  events: ChatEventEnvelope[];
  /** onExited 每次调用追加一条（用来验证「每个作业恰好一次」） */
  exits: JobInfo[];
}

const harnesses: Harness[] = [];

function createHarness(
  options: { maxJobs?: number; bufferBytes?: number; emitThrows?: boolean } = {},
): Harness {
  const events: ChatEventEnvelope[] = [];
  const exits: JobInfo[] = [];
  const deps: JobServiceDeps = {
    emit: (payload) => {
      if (options.emitThrows === true) throw new Error("渲染层挂了");
      events.push(payload);
    },
    onExited: (job) => exits.push(job),
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    ...(options.bufferBytes === undefined ? {} : { bufferBytes: options.bufferBytes }),
  };
  const harness: Harness = { service: createJobService(deps), events, exits };
  harnesses.push(harness);
  return harness;
}

function start(service: JobService, command: string, sessionId = SESSION): Promise<JobInfo> {
  return service.start({ sessionId, command, cwd: dir });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等到条件成立；超时抛错（测试失败信息里能直接看到在等什么） */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(10);
  }
}

function waitForStatus(service: JobService, id: string, status: JobInfo["status"]): Promise<void> {
  return waitFor(`${id} 变为 ${status}`, () => service.get(id)?.status === status);
}

/** 进程是否还在：process.kill(pid, 0) 抛错即已消失 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 从 read 结果里剥掉省略标记；剩下的是真正返回给模型的字节（ASCII 下 1 字符 = 1 字节） */
function stripMarker(output: string): { text: string; omitted: number | undefined } {
  const match = /\n\.\.\.\[(\d+) bytes omitted\]\.\.\.\n/.exec(output);
  if (match === null) return { text: output, omitted: undefined };
  return { text: output.replace(match[0], ""), omitted: Number(match[1]) };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oint-jobs-test-"));
  // 命令里不带引号意味着要用 PATH 上的 `node`；把 node 所在目录补进 PATH 保证它能被找到
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${originalPath}`;

  writeScript("ok.cjs", "process.stdout.write('hello-job\\n');\n");
  writeScript("fail.cjs", "process.stderr.write('boom\\n');\nprocess.exitCode = 7;\n");
  // 靠 interval 挂在事件循环上：只有被 kill 才会退出
  writeScript("live.cjs", "setInterval(() => {}, 1000);\n");
  writeScript(
    "lines.cjs",
    "for (let i = 0; i < 30; i += 1) process.stdout.write('line-' + i + '\\n');\n",
  );
});

afterAll(async () => {
  process.env.PATH = originalPath;
  // 进程刚被杀掉时 Windows 还锁着作为 cwd 的目录；删不掉也无妨，别让清理本身失败
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.service.dispose();
  vi.restoreAllMocks();
});

describe("createJobService", () => {
  it("start 立刻返回 running 快照，退出后 status=exited 且 exitCode 正确（非 0 → failed）", async () => {
    const { service, events, exits } = createHarness();

    const started = await start(service, nodeCommand("ok.cjs"));
    expect(started.id).toBe("job-1");
    expect(started.sessionId).toBe(SESSION);
    expect(started.command).toBe(nodeCommand("ok.cjs"));
    expect(started.cwd).toBe(dir);
    expect(started.status).toBe("running");
    expect(typeof started.pid).toBe("number");
    expect(started.endedAt).toBeUndefined();
    expect(started.totalBytes).toBe(0);
    expect(started.truncated).toBe(false);
    expect(service.list(SESSION).map((job) => job.id)).toEqual(["job-1"]);
    // 立刻发一次 job-changed：渲染层要马上看到「起了一个作业」，而不是等它第一次输出
    expect(events[0]).toEqual({
      sessionId: SESSION,
      event: { type: "job-changed", job: started },
    });

    await waitForStatus(service, "job-1", "exited");
    const done = service.get("job-1");
    expect(done?.exitCode).toBe(0);
    expect(done?.endedAt).toBeGreaterThanOrEqual(started.startedAt);
    expect(done?.totalBytes).toBe("hello-job\n".length);
    expect(done?.truncated).toBe(false);
    expect(events.at(-1)?.event).toMatchObject({
      type: "job-changed",
      job: { id: "job-1", status: "exited" },
    });
    expect(exits.map((job) => job.status)).toEqual(["exited"]);

    // 非 0 退出码 → failed；stderr 与 stdout 进同一个缓冲
    const second = await start(service, nodeCommand("fail.cjs"));
    expect(second.id).toBe("job-2");
    await waitForStatus(service, "job-2", "failed");
    expect(service.get("job-2")?.exitCode).toBe(7);
    const drained = await service.read(SESSION, "job-2");
    expect(drained.output).toBe("boom\n");
    expect(drained.running).toBe(false);
    expect(drained.job.status).toBe("failed");
  });

  it("drain：第二次 read 只返回上一次之后的新增内容", async () => {
    const { service } = createHarness({ bufferBytes: SMALL_BUFFER_BYTES });
    const gate = path.join(dir, "gate-drain");
    writeScript("drain.cjs", gatedScript(gate, "A".repeat(200), "B".repeat(30)));

    const job = await start(service, nodeCommand("drain.cjs"));
    const first = await service.read(SESSION, job.id, { waitMs: 5_000 });
    // 200 字节跨过 128 字节的头部采样：读出来的必须是完整输出，不能静默吞掉中间一段
    expect(first.output).toBe("A".repeat(200));
    expect(first.job.totalBytes).toBe(200);
    expect(first.running).toBe(true);

    writeFileSync(gate, "", "utf8"); // 放行：脚本随后写 B 并退出
    await waitForStatus(service, job.id, "exited"); // 先等进程收尾，drain 语义与退出时序无关
    const second = await service.read(SESSION, job.id);
    expect(second.output).toBe("B".repeat(30));
    expect(second.job.totalBytes).toBe(230);
    expect(second.running).toBe(false);
    expect(second.job.status).toBe("exited");
    expect(second.job.exitCode).toBe(0);

    // 游标已推进到末尾：再读一次只会拿到「没有新输出」
    const third = await service.read(SESSION, job.id);
    expect(third.output).toBe("");
    expect(third.job.totalBytes).toBe(230);
  });

  it("peekTail 不推进 drain 游标；超 20 行注明省略行数；未知 id 返回空串", async () => {
    const { service } = createHarness();
    const job = await start(service, nodeCommand("lines.cjs"));
    await waitForStatus(service, job.id, "exited");

    // 通知文案用的尾部取样：最多 20 行，超出时在开头注明省略了几行
    const tail = service.peekTail(job.id);
    expect(tail).toContain("(11 lines omitted)");
    expect(tail).toContain("line-29");
    expect(tail).not.toContain("line-0\n");
    // 明确给出上限时不触发行数压缩
    expect(service.peekTail(job.id, 1_000)).toContain("line-29");

    // peek 不消耗游标：read 仍然拿到完整输出
    const body = `${Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n")}\n`;
    const drained = await service.read(SESSION, job.id);
    expect(drained.output).toBe(body);
    expect(drained.running).toBe(false);

    // 读完之后 peek 仍是同一段（peek 与游标无关），再 read 没有新内容
    expect(service.peekTail(job.id)).toBe(tail);
    expect((await service.read(SESSION, job.id)).output).toBe("");
    expect(service.peekTail("job-404")).toBe("");
  });

  it("onExited 恰好一次：正常退出与 spawn 失败（error 之后再 close）都不重复结算", async () => {
    const { service, exits } = createHarness();

    const first = await start(service, nodeCommand("ok.cjs"));
    await waitForStatus(service, first.id, "exited");
    await sleep(150); // close 之后若还有第二次结算，这里能观察到
    expect(exits.map((job) => job.id)).toEqual([first.id]);
    expect(exits[0]?.status).toBe("exited");

    // spawn 失败：cwd 不存在（error 事件之后 close 也会到，只能结算一次）
    const badCwd = path.join(dir, "missing-dir");
    let failedId: string | undefined;
    try {
      const info = await service.start({
        sessionId: SESSION,
        command: nodeCommand("ok.cjs"),
        cwd: badCwd,
      });
      failedId = info.id;
    } catch (error) {
      // 平台直接在 spawn 阶段同步失败：作业按 failed 记账，但由调用方承担失败（不回调）
      expect(String(error)).toContain("后台作业启动失败");
    }

    if (failedId === undefined) {
      expect(exits).toHaveLength(1);
      expect(service.list(SESSION).map((job) => job.status)).toEqual(["exited", "failed"]);
      return;
    }

    await waitForStatus(service, failedId, "failed");
    await sleep(150);
    expect(exits.map((job) => job.id)).toEqual([first.id, failedId]);
    expect(exits[1]?.status).toBe("failed");
    expect(exits[1]?.exitCode).toBeUndefined();
    expect(service.get(failedId)?.pid).toBeUndefined();
  });

  it("会话 fence：别的会话 list / read / kill 都拿不到，两个会话的 job-1 互不覆盖", async () => {
    const { service, exits } = createHarness();
    const mine = await start(service, nodeCommand("live.cjs"), SESSION);
    const other = await start(service, nodeCommand("live.cjs"), OTHER_SESSION);

    // id 落在同一张作业表上：两个会话各自的第一个作业不能撞成同一个 id
    expect(mine.id).toBe("job-1");
    expect(other.id).not.toBe(mine.id);
    expect(service.list(SESSION).map((job) => job.id)).toEqual([mine.id]);
    expect(service.list(OTHER_SESSION).map((job) => job.id)).toEqual([other.id]);
    expect(service.list("s3")).toEqual([]);
    expect(service.get(mine.id)?.sessionId).toBe(SESSION);
    expect(service.get(other.id)?.sessionId).toBe(OTHER_SESSION);

    await expect(service.read(OTHER_SESSION, mine.id)).rejects.toThrow(
      `找不到后台作业 ${mine.id}（会话 ${OTHER_SESSION}）`,
    );
    await expect(service.kill(OTHER_SESSION, mine.id)).rejects.toThrow("找不到后台作业");
    await expect(service.kill(SESSION, other.id)).rejects.toThrow("找不到后台作业");
    await expect(service.read(SESSION, "job-404")).rejects.toThrow("找不到后台作业 job-404");
    expect(service.get(mine.id)?.status).toBe("running");
    expect(service.get(other.id)?.status).toBe("running");

    // 关掉另一个会话不能顺手把本会话的作业一起删掉
    service.cancelSession(OTHER_SESSION);
    expect(service.get(other.id)).toBeUndefined();
    expect(service.get(mine.id)?.status).toBe("running");
    expect(service.list(SESSION).map((job) => job.id)).toEqual([mine.id]);
    expect(exits).toEqual([]);
  });

  it("maxJobs：先淘汰已结束的老作业，全是活作业时 start 直接拒绝", async () => {
    const { service, events } = createHarness({ maxJobs: 2 });
    const finished = await start(service, nodeCommand("ok.cjs"));
    await waitForStatus(service, finished.id, "exited");
    const busy = await start(service, nodeCommand("live.cjs"));
    expect(service.list(SESSION).map((job) => job.id)).toEqual([finished.id, busy.id]);

    // 第 3 个：已结束的 finished 被淘汰（活作业保留），新作业照常起来
    const third = await start(service, nodeCommand("live.cjs"));
    expect(service.list(SESSION).map((job) => job.id)).toEqual([busy.id, third.id]);
    expect(service.get(finished.id)).toBeUndefined();
    expect(events).toContainEqual({
      sessionId: SESSION,
      event: { type: "job-removed", id: finished.id },
    });

    // 上限内全是活作业：拒绝而不是静默丢掉（表格不变，活作业一个都不少）
    await expect(start(service, nodeCommand("live.cjs"))).rejects.toThrow(/已达上限（2 个/);
    expect(service.list(SESSION).map((job) => job.id)).toEqual([busy.id, third.id]);
    expect(service.get(busy.id)?.status).toBe("running");
    expect(service.get(third.id)?.status).toBe("running");
  });

  it("kill：状态变 killed，进程真的没了（心跳文件停止增长）", async () => {
    const { service, exits } = createHarness();
    const ticks = path.join(dir, "ticks.txt");
    writeScript(
      "beat.cjs",
      [
        "const fs = require('node:fs');",
        `const out = ${JSON.stringify(ticks)};`,
        "process.stdout.write('beat-start\\n');",
        "setInterval(() => { fs.appendFileSync(out, 'tick;'); }, 25);",
      ].join("\n"),
    );

    const job = await start(service, nodeCommand("beat.cjs"));
    expect(typeof job.pid).toBe("number");
    const pid = job.pid ?? 0;
    await waitFor("作业开始写心跳文件", () => existsSync(ticks));
    await waitFor("作业的第一行输出到达缓冲", () => (service.get(job.id)?.totalBytes ?? 0) > 0);

    const killed = await service.kill(SESSION, job.id);
    expect(killed.status).toBe("killed");
    expect(service.get(job.id)?.status).toBe("killed");

    await waitFor("进程退出", () => !pidAlive(pid));
    const sizeAfterDeath = readFileSync(ticks, "utf8").length;
    await sleep(150);
    expect(readFileSync(ticks, "utf8").length).toBe(sizeAfterDeath);
    expect(existsSync(ticks)).toBe(true);

    // 被杀之后输出仍然可读（模型还能补读最后几行）
    const drained = await service.read(SESSION, job.id);
    expect(drained.output).toBe("beat-start\n");
    expect(drained.running).toBe(false);
    expect(exits.map((info) => info.status)).toEqual(["killed"]);
  });

  it("waitMs：等到退出即返回；作业还活着时到点返回并标明 running", async () => {
    const { service } = createHarness();
    writeScript("later.cjs", "setTimeout(() => { process.exitCode = 0; }, 150);\n");

    const short = await start(service, nodeCommand("later.cjs"));
    const waited = await service.read(SESSION, short.id, { waitMs: 2_000 });
    // 一次 read 就把「进程退出」等到了（否则这里还是 running）
    expect(waited.job.status).toBe("exited");
    expect(waited.job.exitCode).toBe(0);
    expect(waited.running).toBe(false);

    const live = await start(service, nodeCommand("live.cjs"));
    const startedAt = Date.now();
    const timedOut = await service.read(SESSION, live.id, { waitMs: 150 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(130);
    expect(timedOut.running).toBe(true);
    expect(timedOut.job.status).toBe("running");
    expect(timedOut.output).toBe("");

    // 缺省（0）与非法值都不等：立刻返回当前积累内容
    const immediate = Date.now();
    await service.read(SESSION, live.id);
    expect(Date.now() - immediate).toBeLessThan(100);
    const negative = Date.now();
    const clamped = await service.read(SESSION, live.id, { waitMs: -5 });
    expect(Date.now() - negative).toBeLessThan(100);
    expect(clamped.running).toBe(true);
  });

  it("cancelSession：清掉本会话作业、杀掉进程、不回调 onExited，并抑制后续通知", async () => {
    const { service, events, exits } = createHarness();
    const ticks = path.join(dir, "cancel-ticks.txt");
    writeScript(
      "cancel-beat.cjs",
      [
        "const fs = require('node:fs');",
        `const out = ${JSON.stringify(ticks)};`,
        "setInterval(() => { fs.appendFileSync(out, 'tick;'); }, 25);",
      ].join("\n"),
    );

    const job = await start(service, nodeCommand("cancel-beat.cjs"));
    const pid = job.pid ?? 0;
    await waitFor("作业开始写心跳文件", () => existsSync(ticks));
    expect(service.isSuppressed(SESSION)).toBe(false);

    service.cancelSession(SESSION);
    expect(service.list(SESSION)).toEqual([]);
    expect(service.get(job.id)).toBeUndefined();
    expect(service.isSuppressed(SESSION)).toBe(true); // 运行时据此不再往已关闭的会话发通知
    expect(events).toContainEqual({ sessionId: SESSION, event: { type: "job-removed", id: job.id } });

    await waitFor("进程退出", () => !pidAlive(pid));
    const sizeAfterDeath = readFileSync(ticks, "utf8").length;
    await sleep(150);
    expect(readFileSync(ticks, "utf8").length).toBe(sizeAfterDeath);
    // 用户主动清理：不再打扰已经不要这些作业的会话
    expect(exits).toEqual([]);

    // 会话重新开始作业时撤回抑制标记
    const restarted = await start(service, nodeCommand("live.cjs"));
    expect(service.isSuppressed(SESSION)).toBe(false);
    expect(restarted.id).not.toBe(job.id);
  });

  it("dispose：杀掉全部作业并清空作业表，同样不回调 onExited", async () => {
    const { service, exits } = createHarness();
    const mine = await start(service, nodeCommand("live.cjs"), SESSION);
    const other = await start(service, nodeCommand("live.cjs"), OTHER_SESSION);

    await service.dispose();
    expect(service.list(SESSION)).toEqual([]);
    expect(service.list(OTHER_SESSION)).toEqual([]);
    expect(service.get(mine.id)).toBeUndefined();
    expect(service.get(other.id)).toBeUndefined();
    await waitFor("第一个进程退出", () => !pidAlive(mine.pid ?? 0));
    await waitFor("第二个进程退出", () => !pidAlive(other.pid ?? 0));
    expect(exits).toEqual([]);
  });

  it("emit 抛错（渲染层挂了）不会拖垮作业服务", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = createHarness({ emitThrows: true });

    const job = await start(service, nodeCommand("ok.cjs"));
    await waitForStatus(service, job.id, "exited");
    expect((await service.read(SESSION, job.id)).output).toBe("hello-job\n");
    expect(warn).toHaveBeenCalled();
  });

  it("截断：read 用 bytes omitted 标出缺口，返回的窗口是最近一段输出且字节可对账", async () => {
    const { service } = createHarness({ bufferBytes: SMALL_BUFFER_BYTES });
    const gate = path.join(dir, "gate-truncate");
    // 800 字节先把头部采样撑满（128），再把滚动窗口（1024）顶穿
    writeScript("truncate.cjs", gatedScript(gate, "A".repeat(800), "B".repeat(1_200)));

    const job = await start(service, nodeCommand("truncate.cjs"));
    const first = await service.read(SESSION, job.id, { waitMs: 5_000 });
    expect(first.output).toBe("A".repeat(800));
    expect(first.job.truncated).toBe(false);

    writeFileSync(gate, "", "utf8");
    // 先等进程收尾：这里要看的是「读到的窗口内容」，不是 read 的等待行为
    await waitForStatus(service, job.id, "exited");
    const second = await service.read(SESSION, job.id);
    // 游标停在 800 之后，[800, 976) 这段被丢弃 → 正好 176 字节的缺口
    const { text, omitted } = stripMarker(second.output);
    expect(omitted).toBe(176);
    expect(text).toBe("B".repeat(SMALL_BUFFER_BYTES)); // 窗口 = 最近 bufferBytes 字节
    expect(second.job.truncated).toBe(true);
    expect(second.job.totalBytes).toBe(2_000); // 含被丢弃的字节，单调增长
    expect(second.job.totalBytes).toBeGreaterThan(first.job.totalBytes);
    expect(second.running).toBe(false);
    expect(second.job.status).toBe("exited");
  });

  it("截断：单块输出一次性远超缓冲时丢弃从最老的一头推进（不会卡在丢弃循环里）", async () => {
    const { service } = createHarness({ bufferBytes: SMALL_BUFFER_BYTES });
    const payload = `HEAD-MARKER${"x".repeat(8_192 - "HEAD-MARKER".length)}`;
    writeScript("big.cjs", `process.stdout.write(${JSON.stringify(payload)});\n`);

    const job = await start(service, nodeCommand("big.cjs"));
    await waitForStatus(service, job.id, "exited");
    const { text, omitted } = stripMarker((await service.read(SESSION, job.id)).output);

    // 头部采样留着启动阶段那几行，缺口恰好是「总字节 - 头部 - 窗口」
    expect(text.startsWith("HEAD-MARKER")).toBe(true);
    expect(omitted).toBe(payload.length - text.length);
    expect(text.endsWith("x".repeat(SMALL_BUFFER_BYTES))).toBe(true);
    expect(payload.length - text.length).toBe(8_192 - 128 - SMALL_BUFFER_BYTES);
    expect(service.get(job.id)?.totalBytes).toBe(8_192);
    expect(service.get(job.id)?.truncated).toBe(true);
  });
});
