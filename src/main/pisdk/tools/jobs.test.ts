import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createJobService } from "../jobs";
import { openNativeStateTest } from "../native-state-test";
import { createJobTools } from "./jobs";

function toolAt(tools: ReturnType<typeof createJobTools>, index: number) {
  const tool = tools[index];
  if (!tool) throw new Error("Missing job tool");
  return tool;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe("native job tool adapters", () => {
  it("exports four schemas with bounded read wait and required command/id", () => {
    const tools = createJobTools({ sessionId: "s1", jobs: createJobService({ emit() {} }) });
    expect(tools.map((tool) => tool.name)).toEqual([
      "bash_background",
      "job_output",
      "job_list",
      "job_kill",
    ]);
    expect(Value.Check(toolAt(tools, 0).parameters, { command: "" })).toBe(false);
    expect(Value.Check(toolAt(tools, 1).parameters, { id: "x", waitMs: 30001 })).toBe(false);
    expect(Value.Check(toolAt(tools, 3).parameters, {})).toBe(false);
  });
  it("reads the native conversation's job list and reports unknown jobs", async () => {
    const jobs = createJobService({ emit() {} });
    const test = await openNativeStateTest(jobs.taskDefinitions);
    await jobs.attach(test.attachment);
    cleanups.push(async () => {
      await jobs.dispose();
      await test.close();
    });
    const tools = createJobTools({ sessionId: "s1", jobs });
    const list = await test.invoke(async (api, ctx) => ({
      ...(await toolAt(tools, 2).execute({}, api, ctx)),
    }));
    expect(await list.result).toMatchObject({ details: { jobs: [] } });
    const read = await test.invoke(async (api, ctx) => ({
      ...(await toolAt(tools, 1).execute({ id: "missing" }, api, ctx)),
    }));
    expect(JSON.stringify(await read.result)).toContain("找不到");
  });
});
