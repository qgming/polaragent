import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { emptyUsage } from "../src/main/pisdk/durable-session";
import { checkpointUsage } from "../src/main/pisdk/native-usage";
import { createSessionStore } from "../src/main/pisdk/session-store";
import { createUsageStatsService } from "../src/main/stats/usage-stats";
import { createSettingsStore } from "../src/main/settings/store";
import { BUILTIN_MCP_SERVERS } from "../src/shared/mcp/builtin-servers";

/** Synthetic ledger only; no provider call, user database, internal SQL, or duplicate statistics implementation. */
export async function seedUsageStats(dataDir: string) {
  const settings = createSettingsStore(dataDir);
  await settings.save({ ...await settings.load(), systemMcpServerEnabled: Object.fromEntries(BUILTIN_MCP_SERVERS.map((server) => [server.id, false])) });
  const store = createSessionStore(dataDir);
  const summary = await store.create({ title: "Native usage probe fixture" });
  await store.close();
  const file = path.join(dataDir, "sessions-v1", `${summary.id}.sqlite`);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry: createRegistry() }, context);
  try {
    const root = await harness.root(context);
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const usage = (input: number) => ({ ...emptyUsage(), input, totalTokens: input });
    const ledger: UsageState = { models: { "fixture/dated-a": usage(100) }, tools: {} };
    await harness.commit(async (tx) => Object.assign(await tx.doc(UsageDoc, root.id), ledger), context);
    await checkpointUsage(harness, root.id, ledger, yesterday.getTime());
    ledger.models["fixture/dated-a"] = usage(400);
    ledger.models["fixture/dated-b"] = usage(200);
    ledger.tools["fixture-search"] = usage(50);
    await harness.commit(async (tx) => Object.assign(await tx.doc(UsageDoc, root.id), ledger), context);
    await checkpointUsage(harness, root.id, ledger, today.getTime());
    // An uncheckpointed balance has no retained date. The production projection must preserve that fact.
    ledger.models["fixture/undated-only"] = usage(75);
    await harness.commit(async (tx) => Object.assign(await tx.doc(UsageDoc, root.id), ledger), context);
  } finally { await harness.close(context); }
  const reopened = createSessionStore(dataDir);
  try {
    const report = await createUsageStatsService({ store: reopened }).report();
    const datedTokens = report.days.reduce((sum, day) => sum + day.tokens, 0);
    if (report.totalTokens !== 725 || report.undatedTokens !== 75 || datedTokens !== 650) throw new Error(`Native fixture mismatch: ${JSON.stringify(report)}`);
    return { sessionId: summary.id, totalTokens: 725, undatedTokens: 75, datedTokens: 650, datedModelCount: 3 };
  } finally { await reopened.close(); }
}
