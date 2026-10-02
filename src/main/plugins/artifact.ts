import path from "node:path";
import { readFacetBundleArtifact } from "@earendil-works/chord/node";
import { validateRealPathAccess } from "@/main/security/path-guard";
import type { PluginPackage } from "@/shared/contracts/plugin";

/** Verify prebuilt bytes before installing; no plugin code or lifecycle scripts run here. */
export async function verifyPluginArtifact(dir: string, metadata: PluginPackage): Promise<void> {
  if (!metadata.agentFacet) return;
  const manifestPath = path.join(dir, "dist", "chord-facets.json");
  const access = await validateRealPathAccess(manifestPath, [dir]);
  if (!access.ok) throw new Error(access.reason);
  const artifact = await readFacetBundleArtifact({ manifestPath, entry: "agent" });
  if (artifact.plugin.id !== metadata.id || artifact.plugin.version !== metadata.version)
    throw new Error("Chord bundle identity does not match package.json");
  const codeAccess = await validateRealPathAccess(path.join(dir, "dist", artifact.entry.file), [
    dir,
  ]);
  if (!codeAccess.ok) throw new Error(codeAccess.reason);
}
