import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export function requireToolEnv(api: Pick<ToolExecutionApi, "env">): ExecutionEnv {
  if (api.env === undefined)
    throw new Error("This tool requires the session execution environment");
  return api.env;
}
