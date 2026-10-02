import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "./manifest";

const metadata = (oint: Record<string, unknown> = {}) => ({
  name: "@example/tools",
  version: "1.0.0",
  chord: { facets: { agent: "./agent.ts" } },
  oint: { permissions: [], ...oint },
});
describe("native plugin package metadata", () => {
  it("uses npm package identity and Chord source mapping", () => {
    expect(validatePluginManifest(metadata())).toMatchObject({
      ok: true,
      manifest: { id: "@example/tools", agentFacet: "./agent.ts" },
    });
  });
  it.each(["fs.read", "fs.write", "ui.view", "session.read", "shell.openExternal"])(
    "rejects unsupported capability %s",
    (permission) => {
      expect(validatePluginManifest(metadata({ permissions: [permission] })).ok).toBe(false);
    },
  );
  it("does not interpret the removed execution manifest", () => {
    expect(
      validatePluginManifest({
        name: "example",
        version: "1.0.0",
        extensions: { "dev.oint": { id: "example", main: "./main.cjs" } },
      }).ok,
    ).toBe(false);
  });
  it("requires executable facet and capability for native hooks", () => {
    expect(validatePluginManifest(metadata({ hooks: ["beforeTool"] })).ok).toBe(false);
    expect(
      validatePluginManifest(
        metadata({ hooks: ["beforeTool"], permissions: ["hostHooks.register"] }),
      ).ok,
    ).toBe(true);
  });
  it("requires real surface grants and preserves false window options", () => {
    const surface = {
      id: "main",
      kind: "window",
      title: "Main",
      entry: "./ui/main.html",
      resizable: false,
    };
    expect(validatePluginManifest(metadata({ surfaces: [surface] })).ok).toBe(false);
    expect(
      validatePluginManifest(metadata({ surfaces: [surface], permissions: ["ui.window"] })),
    ).toMatchObject({ ok: true, manifest: { surfaces: [{ resizable: false }] } });
  });
  it.each(["./../outside.ts", "./ui/../../outside.ts", "C:/outside.ts", "./ui\\..\\outside.ts"])(
    "rejects escaping artifact path %s",
    (agent) => {
      expect(validatePluginManifest({ ...metadata(), chord: { facets: { agent } } }).ok).toBe(
        false,
      );
    },
  );
  it("requires narrow outbound and executable capabilities", () => {
    expect(validatePluginManifest(metadata({ permissions: ["shell.exec"] })).ok).toBe(false);
    expect(
      validatePluginManifest(metadata({ permissions: ["net.fetch"], net: { domains: ["*"] } })).ok,
    ).toBe(false);
    expect(
      validatePluginManifest(metadata({ permissions: ["shell.exec"], shell: { exec: ["git"] } }))
        .ok,
    ).toBe(true);
  });
});
