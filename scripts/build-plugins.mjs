import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { bundleFacetPackage } from "@earendil-works/chord/bundler";

const root = path.resolve(import.meta.dirname, "../resources/plugins");
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packagePath = path.join(root, entry.name);
  const metadata = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"));
  if (!metadata.chord?.facets?.agent) continue;
  await bundleFacetPackage({ packagePath, outdir: path.join(packagePath, "dist") });
}
