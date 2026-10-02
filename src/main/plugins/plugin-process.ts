import path from "node:path";
import {
  type Context,
  createRemoteServiceBinding,
  type RemoteServiceBinding,
} from "@earendil-works/chord";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Client, createClientServiceTransport } from "@earendil-works/pi-client";
import { buildChildEnv } from "@/main/security/child-env";
import { PluginAgent, type PluginAgentService, validateAgentDescription } from "./agent-service";
import { type BytePort, portTransportFactory } from "./transport";

export interface PluginProcess {
  readonly service: PluginAgentService;
  readonly alive: boolean;
  invoke<T>(
    operation: (service: PluginAgentService, context: Context) => Promise<T>,
    context: Context,
    timeoutMs?: number,
  ): Promise<T>;
  /** Retire after existing invocations finish; new registry publication points to a new process. */
  retire(): void;
  stop(): void;
}
export type PluginProcessFactory = (options: {
  pluginId: string;
  pluginDir: string;
  manifestPath: string;
  dataDir: string;
  workerEntry?: string;
  onExit: (message: string) => void;
}) => Promise<PluginProcess>;

/** Connect a real byte transport; shared by Electron production and MessagePort behavioral tests. */
export async function connectPluginProcess(
  port: BytePort,
  serverId: string,
  onExit: (message: string) => void,
): Promise<PluginProcess> {
  const client = new Client({ serverId, transportFactory: portTransportFactory(port) });
  let binding: RemoteServiceBinding | undefined;
  let stopping = false;
  let retired = false;
  let calls = 0;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void client
      .request(
        { serverId },
        { serviceId: "oint.plugin.runtime", member: "dispose", args: [] },
        AbortSignal.timeout(1000),
      )
      .catch(() => undefined)
      .finally(() => {
        void client.dispose();
        void binding?.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
      });
  };
  client.onConnectionStateChange((change) => {
    if (change.state === "disconnected" && !stopping)
      onExit(change.error?.message ?? "插件进程连接已断开");
  });
  try {
    const context = withAbortSignal(AbortSignal.timeout(10000), BACKGROUND_CONTEXT);
    await awaitWithContext(client.connect(), context);
    binding = createRemoteServiceBinding({
      services: [PluginAgent],
      transport: createClientServiceTransport(client, () => ({ serverId })),
      bound: true,
    });
    const service = binding.use(PluginAgent);
    await binding.ready(context);
    validateAgentDescription(service.description.value);
    return {
      service,
      get alive() {
        return client.connected && !stopping;
      },
      async invoke(operation, parent, timeoutMs = 120000) {
        if (stopping || retired) throw new Error("插件版本已卸载，请重试调用");
        calls += 1;
        const context = withAbortSignal(AbortSignal.timeout(timeoutMs), parent);
        try {
          return await operation(service, context);
        } finally {
          calls -= 1;
          if (retired && calls === 0) stop();
        }
      },
      retire() {
        retired = true;
        if (calls === 0) stop();
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

export const startPluginProcess: PluginProcessFactory = async (options) => {
  const { utilityProcess } = await import("electron");
  const serverId = crypto.randomUUID();
  const env = {
    ...buildChildEnv(),
    OINT_PLUGIN_BUNDLE: options.manifestPath,
    OINT_PLUGIN_SERVER_ID: serverId,
    OINT_PLUGIN_DATA_DIR: options.dataDir,
  };
  const child = utilityProcess.fork(
    options.workerEntry ?? path.join(import.meta.dirname, "plugin-worker.js"),
    [],
    { cwd: options.pluginDir, env, stdio: "pipe", serviceName: `Oint plugin: ${options.pluginId}` },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  child.stdout?.resume();
  const port: BytePort = {
    postMessage: (bytes) => child.postMessage(bytes),
    onData(listener) {
      child.on("message", listener);
      return () => child.off("message", listener);
    },
    onClose(listener) {
      child.on("exit", listener);
      return () => child.off("exit", listener);
    },
    close() {
      child.kill();
    },
  };
  try {
    return await connectPluginProcess(port, serverId, (message) =>
      options.onExit(`${message}${stderr ? `: ${stderr}` : ""}`),
    );
  } catch (error) {
    child.kill();
    throw new Error(
      `插件启动失败：${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr}` : ""}`,
      { cause: error },
    );
  }
};
