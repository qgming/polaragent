import type { AgentTurnPayload } from "@/types/schedule";

function normalizedDirs(contextDirs?: string[]): string[] {
  return (contextDirs || []).map((value) => value.trim()).filter(Boolean);
}

export function resolveScheduledWorkingDir(
  payload: AgentTurnPayload,
  fallbackWorkingDir: string,
): string {
  const explicitWorkingDir = payload.workingDir?.trim();
  if (explicitWorkingDir) {
    return explicitWorkingDir;
  }

  const [firstContextDir] = normalizedDirs(payload.contextDirs);
  return firstContextDir || fallbackWorkingDir;
}

export function buildScheduledAgentMessage(payload: AgentTurnPayload): string {
  const message = payload.message.trim();
  const contextDirs = normalizedDirs(payload.contextDirs);

  if (contextDirs.length === 0) {
    return message;
  }

  return [
    "Scheduled run context:",
    ...contextDirs.map((dir) => `- ${dir}`),
    "Inspect these directories as needed before making changes or producing output.",
    "",
    message,
  ].join("\n");
}
