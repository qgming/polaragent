import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobService, type JobServiceDeps, JobsDoc } from "./jobs";
import { openNativeStateTest } from "./native-state-test";
import { createJobTools, JOB_OUTPUT_TOOL_NAME } from "./tools/jobs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oint-native-jobs-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}
async function setup(options: Partial<JobServiceDeps> = {}) {
  const dir = await directory();
  const exits: string[] = [];
  const service = createJobService({
    emit: () => {},
    onExited: (job) => {
      exits.push(job.id);
    },
    ...options,
  });
  const test = await openNativeStateTest(service.taskDefinitions);
  await service.attach(test.attachment);
  cleanups.push(async () => {
    await service.dispose();
    await test.close();
  });
  async function start(source: string) {
    await writeFile(path.join(dir, "run.cjs"), source);
    return service.start({
      sessionId: "s1",
      command: `"${process.execPath}" run.cjs`,
      cwd: dir,
      toolCallId: "call-start",
    });
  }
  return { ...test, dir, service, start, exits };
}
describe("native background job tasks", () => {
  it("runs a real process, commits terminal output/report and preserves drain cursor", async () => {
    const test = await setup();
    const job = await test.start("process.stdout.write('中文🙂hello\\n');");
    await expect.poll(async () => (await test.service.get(job.id))?.status).toBe("exited");
    const read = await test.service.read("s1", job.id);
    expect(read.output).toBe("中文🙂hello\n");
    expect((await test.service.read("s1", job.id)).output).toBe("");
    expect(await test.service.peekTail(job.id)).toBe("中文🙂hello\n");
    const saved = (await test.harness.snapshot(JobsDoc, test.root.id, context))?.entries[job.id];
    expect(saved?.cursor).toBe(Buffer.byteLength("中文🙂hello\n"));
    expect(saved?.result?.text).toContain("中文🙂hello");
    expect(await test.service.toolCallIdOf(job.id)).toBe("call-start");
    expect(test.exits).toEqual([job.id]);
  });
  it("keeps bounded head/tail output with explicit omitted byte count", async () => {
    const test = await setup({ bufferBytes: 1024 });
    const job = await test.start("process.stdout.write('HEAD'+ 'x'.repeat(5000)+'TAIL');");
    await expect.poll(async () => (await test.service.get(job.id))?.status).toBe("exited");
    const read = await test.service.read("s1", job.id);
    expect(read.output).toMatch(/^HEAD/);
    expect(read.output).toMatch(/TAIL$/);
    expect(read.output).toContain("bytes omitted");
    expect(read.job.totalBytes).toBe(5008);
    expect((await test.service.read("s1", job.id)).output).toBe("");
  });
  it("enforces admission atomically, fences sessions, and uses native task abort to kill", async () => {
    const test = await setup({ maxJobs: 1 });
    const job = await test.start("setInterval(() => {}, 1000);");
    await expect(
      test.service.start({ sessionId: "s1", command: "unused", cwd: test.dir }),
    ).rejects.toThrow("上限");
    const other = await test.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await test.service.attach({
      ...test.attachment,
      conversationId: other.id,
      sessionId: "s2",
      displaySessionId: "s2",
    });
    await expect(test.service.read("s2", job.id)).rejects.toThrow("找不到");
    expect((await test.service.kill("s1", job.id)).status).toBe("killed");
    expect((await test.service.get(job.id))?.endedAt).toBeTypeOf("number");
  });
  it("background ownership survives an ordinary conversation abort", async () => {
    const test = await setup();
    const job = await test.start("setInterval(() => {}, 1000);");
    await test.root.abort(context);
    expect((await test.service.get(job.id))?.status).toBe("running");
    await test.service.cancelSession("s1");
    expect(test.exits).toEqual([]);
  });
  it("cancels a native job_output wait promptly and releases its watch and timer", async () => {
    const test = await setup();
    const job = await test.start("setInterval(() => {}, 1000);");
    const output = createJobTools({ sessionId: "s1", jobs: test.service }).find(
      (tool) => tool.name === JOB_OUTPUT_TOOL_NAME,
    );
    if (!output) throw new Error("Missing job_output tool");
    const watchSpy = vi.spyOn(test.harness, "watchDoc");
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const call = await test.invoke((api, callContext) =>
        output.execute({ id: job.id, waitMs: 30_000 }, api, callContext),
      );
      await expect.poll(() => timerSpy.mock.calls.some((args) => args[1] === 30_000)).toBe(true);
      const timerIndex = timerSpy.mock.calls.findIndex((args) => args[1] === 30_000);
      const timer = timerSpy.mock.results[timerIndex]?.value;
      const watch = await watchSpy.mock.results[0]?.value;
      if (!watch) throw new Error("Missing native output watch");
      const started = performance.now();
      await test.harness.abortTask(call.id, context);
      await expect(call.result).rejects.toThrow("aborted");
      expect(performance.now() - started).toBeLessThan(1_000);
      await expect(watch.closed).resolves.toMatchObject({
        reason: expect.stringMatching(/cancelled|stopped/),
      });
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect((await test.service.get(job.id))?.status).toBe("running");
      expect(
        (await test.harness.snapshot(JobsDoc, test.root.id, context))?.entries[job.id]?.cursor,
      ).toBe(0);
    } finally {
      watchSpy.mockRestore();
      timerSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
  it("reopens actual JSONL storage with cursor/report retained and never reruns an interrupted command", async () => {
    const dir = await directory();
    const env = new NodeExecutionEnv({ cwd: dir });
    const service = createJobService({ emit: () => {} });
    const storage = await JsonlStorage.open(path.join(dir, "state"), env, context);
    const first = await openNativeStateTest(service.taskDefinitions, storage);
    await service.attach(first.attachment);
    await writeFile(
      path.join(dir, "run.cjs"),
      "require('node:fs').appendFileSync('effects.txt','ONCE\\n'); process.stdout.write('ready\\n'); setInterval(() => {},1000);",
    );
    const job = await service.start({
      sessionId: "s1",
      command: `"${process.execPath}" run.cjs`,
      cwd: dir,
    });
    await expect.poll(async () => (await service.get(job.id))?.totalBytes).toBe(6);
    expect((await service.read("s1", job.id)).output).toBe("ready\n");
    // Closing the Harness interrupts its invocation without the application's cancelSession path.
    await first.close();
    const recoveredService = createJobService({ emit: () => {} });
    const reopened = await openNativeStateTest(
      recoveredService.taskDefinitions,
      await JsonlStorage.open(path.join(dir, "state"), env, context),
    );
    await recoveredService.attach(reopened.attachment);
    cleanups.push(async () => {
      await recoveredService.dispose();
      await reopened.close();
    });
    reopened.harness.resume();
    await expect.poll(async () => (await recoveredService.get(job.id))?.status).toBe("failed");
    expect(await readFile(path.join(dir, "effects.txt"), "utf8")).toBe("ONCE\n");
    const remaining = await recoveredService.read("s1", job.id);
    expect(remaining.output).not.toContain("ready");
    expect(remaining.output).toContain("未自动重跑");
  });
});
