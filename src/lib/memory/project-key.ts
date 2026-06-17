export function projectKeyFromWorkingDir(workingDir?: string): string | undefined {
  const normalized = workingDir
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return normalized || undefined;
}
