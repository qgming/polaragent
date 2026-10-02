import { defineDoc } from "@earendil-works/pi-durable";
import type { AgentMode } from "@/shared/contracts/common";
import { WEB_READ_ONLY_TOOL_NAMES } from "@/shared/contracts/web";

/** Persist the admitted turn's policy independently of the user's next-turn preference. */
export const RunModeDoc = defineDoc<{ mode: AgentMode | null }>({
  kind: "oint.run-mode",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ mode: null }),
});

// Unknown tools fail closed. Shell parsing and third-party annotations cannot establish safety.
const PLAN_TOOLS = new Set<string>([
  "read", "read_image", "glob", "grep", "ask_user", ...WEB_READ_ONLY_TOOL_NAMES,
]);
export function allowedInPlan(toolName: string): boolean {
  return PLAN_TOOLS.has(toolName);
}
