# Native plugin implementation

2026-10-02. Current implementation replaces the earlier plugin-system plans. Author contract and examples: [plugin-authoring skill](../resources/skills/plugin-authoring/SKILL.md), [agent service](../src/main/plugins/agent-service.ts), [toolkit facet](../resources/plugins/toolkit/agent.ts).

Package identity comes from package.json. Oint keeps presentation/capability metadata under `oint`; executable plugins use Chord's `chord.facets.agent` and prebuilt `dist/chord-facets.json`. Official loaders verify the bundle. Local ZIP install runs no package scripts. Development mounts rebuild with `bundleFacetPackage` on explicit reload.

Each source has one utilityProcess shared across workspaces. Chord owns facet activation/services/disposal. Pi Client, Server and Protocol own framed bytes, request correlation, cancellation and service subscriptions. The Electron adapter only transports ordered byte chunks. A host-owned disposal service releases facets before process termination, bounded to one second.

Each plugin publishes a distinct Durable Extension with direct schema-bearing tools, static sections, and native beforeTool/afterTool hooks. Host policy follows plugin argument transformation. Native function-valued task/commit APIs remain local to the Harness; the isolated service boundary exposes serializable results and descriptors. Surface BrowserWindow/webview ownership, CSP, URL/file guards and actual capability checks remain application responsibilities.

Changed packages create a new host rather than invoking Chord reload with a different dependency/service shape. Publication replaces extension objects only after successful activation. Started service calls lease the old worker until completion; failed candidate activation retains a working previous generation. A failed required beforeTool extension blocks calls rather than silently disappearing. No old manifest, RPC envelope, hook matcher chain, tool gateway or generation-counter compatibility layer remains.

Project resources, extensions and plugin MCP endpoints are selected using the conversation cwd. Global sources share processes and MCP connections; project endpoint identifiers include the source identity. Disabling a plugin refreshes every loaded workspace. UI cwd selects only the management surface.

Switching the management workspace synchronously revokes project surface owners and closes their guests before updating cwd. Project partitions and protocol handlers bind to the original source/workspace, including when both projects contain the same package id. Global Git surfaces retain their partition and follow the selected cwd. MCP endpoint names always hash the original source/member pair before readable-name normalization.

Verification commands:

```text
node scripts/build-plugins.mjs
npx vitest run src/main/plugins
node scripts/probe-native-plugins.mjs
node scripts/probe-native-plugins.mjs --packaged
```

The packaged probe requires `npm run pack`. It launches the actual worker from app.asar, resolves its packaged official dependencies, loads the unpacked toolkit artifact, invokes the native hash tool and verifies utilityProcess teardown. It is a worker/artifact test; main application GUI tests remain separate.
