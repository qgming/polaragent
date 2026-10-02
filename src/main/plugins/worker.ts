import path from "node:path";
import {
  type Context,
  createFacetHost,
  defineService,
  RemoteServiceProvider,
} from "@earendil-works/chord";
import { createFacetBundleLoader } from "@earendil-works/chord/node";
import { PluginAgent } from "./agent-service";
import { type BytePort, createPluginServer } from "./transport";

const inbox: unknown[] = [];
let deliver: ((value: unknown) => void) | undefined;
process.parentPort?.on("message", (event: { data: unknown }) => {
  if (deliver) deliver(event.data);
  else if (inbox.length < 16) inbox.push(event.data);
  else throw new Error("Plugin bootstrap inbox overflow");
});

/** Electron owns the process boundary. Chord owns facet activation and disposal. */
async function main(): Promise<void> {
  const manifestPath = process.env.OINT_PLUGIN_BUNDLE;
  const serverId = process.env.OINT_PLUGIN_SERVER_ID;
  const parent = process.parentPort;
  if (!manifestPath || !serverId || !parent) throw new Error("Missing plugin process bootstrap");
  const loaded = await createFacetBundleLoader({
    manifestPath,
    entry: "agent",
    resolveExternal: (specifier) => import.meta.resolve(specifier),
  }).load();
  const host = await createFacetHost({ facets: loaded.facets });
  const lifecycle = defineService<{ dispose(context: Context): Promise<void> }>(
    "oint.plugin.runtime",
  );
  const provider = new RemoteServiceProvider([PluginAgent, lifecycle]);
  provider.provide(PluginAgent, host.services.use(PluginAgent));
  provider.provide(lifecycle, {
    async dispose() {
      await host.dispose();
      await loaded.dispose();
    },
  });
  const port: BytePort = {
    postMessage: (bytes) => parent.postMessage(bytes),
    onData(listener) {
      deliver = listener;
      for (const bytes of inbox.splice(0)) listener(bytes);
      return () => {
        deliver = undefined;
      };
    },
    onClose(listener) {
      process.once("disconnect", listener);
      return () => process.off("disconnect", listener);
    },
    close() {
      void shutdown();
    },
  };
  const server = createPluginServer(provider, port, serverId);
  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    await server.close();
    provider.dispose();
    await host.dispose();
    await loaded.dispose();
    process.exit(0);
  }
  process.once("SIGTERM", () => {
    void shutdown();
  });
  await server.start();
}
void main().catch((error: unknown) => {
  console.error(path.basename(process.env.OINT_PLUGIN_BUNDLE ?? "plugin"), error);
  process.exit(1);
});
