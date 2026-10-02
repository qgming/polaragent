import { createRemoteServiceEndpoint, type RemoteServiceProvider } from "@earendil-works/chord";
import type { ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";
import { Server, type ServerListener } from "@earendil-works/pi-server";

/** Electron utilityProcess and Node MessagePort supply the same ordered message capability. */
export interface BytePort {
  postMessage(bytes: Uint8Array): void;
  onData(listener: (bytes: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

function receive(port: BytePort, handlers: ByteTransportHandlers): () => void {
  let ended = false;
  const stopData = port.onData((value) => {
    if (ended) return;
    if (!(value instanceof Uint8Array)) {
      ended = true;
      handlers.onError(new Error("插件传输只接受字节帧"));
      return;
    }
    handlers.onData(value);
  });
  const stopClose = port.onClose(() => {
    if (!ended) {
      ended = true;
      handlers.onClose();
    }
  });
  return () => {
    ended = true;
    stopData();
    stopClose();
  };
}

export function portTransportFactory(port: BytePort): ByteTransportFactory {
  return (handlers) => {
    const unsubscribe = receive(port, handlers);
    let closed = false;
    return {
      async send(chunk) {
        if (closed) throw new Error("插件连接已关闭");
        port.postMessage(chunk);
      },
      close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        port.close();
      },
    };
  };
}

/** The official server owns handshake, correlation, cancellation and subscription routing. */
export function createPluginServer(
  provider: RemoteServiceProvider,
  port: BytePort,
  serverId: string,
): Server {
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const listener: ServerListener = {
    async start(accept) {
      const handlers = accept({
        get closed() {
          return closed;
        },
        async send(chunk) {
          if (!closed) port.postMessage(chunk);
        },
        close(finalChunk) {
          if (closed) return;
          if (finalChunk) port.postMessage(finalChunk);
          closed = true;
          unsubscribe?.();
          port.close();
        },
      });
      unsubscribe = receive(port, handlers);
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      port.close();
    },
  };
  return new Server(
    {
      serverServices: {
        attachClient() {
          const endpoint = createRemoteServiceEndpoint(provider);
          return {
            invokeService: (call, publish, context) => endpoint.invoke(call, publish, context),
            release: () => endpoint.dispose(),
          };
        },
      },
      async resolveSession() {
        throw new Error("插件服务不提供会话路由");
      },
      async openSession() {
        throw new Error("插件服务不提供会话路由");
      },
    },
    { serverId, listeners: [listener] },
  );
}
