// Keep the desktop dependency graph on the approved native ecosystem.
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const errors = [];
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  if (/^@earendil-works\/(?:pi-|chord$)/.test(name) && version !== "1.0.0") {
    errors.push(`${name} must use exact 1.0.0, found ${version}`);
  }
}
const native = [];
for (const [location, pkg] of Object.entries(lock.packages ?? {})) {
  if (!location) continue;
  const name = location.split("node_modules/").at(-1);
  if (/(?:^|\/)pi-(?:coding-agent|tui)$/.test(name)) {
    errors.push(`CLI/TUI dependency is excluded: ${location}`);
  }
  if (/^@earendil-works\/(?:pi-|chord$)/.test(name)) {
    if (pkg.version !== "1.0.0") errors.push(`${location} resolved to ${pkg.version}`);
    native.push(`${name}@${pkg.version}`);
  }
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(`Pi dependency graph verified: ${[...new Set(native)].sort().join(", ")}; no coding-agent/TUI`);
