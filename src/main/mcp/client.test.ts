import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpAbortError } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import { createMcpClient, type McpClient } from "./client";

const config = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "test",
  name: "test",
  enabled: true,
  transport: "http",
  command: "",
  args: [],
  env: {},
  cwd: "",
  url: "",
  headers: {},
  createdAt: 0,
  ...overrides,
});
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function httpFixture() {
  const seen: { method: string; params?: Record<string, unknown> }[] = [];
  const streams = new Set<ServerResponse>();
  let deleted = false;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ready\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    seen.push(message);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) =>
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture", version: "1" },
      });
    } else if (message.method === "tools/list") {
      reply(
        message.params?.cursor
          ? { tools: [tool("one"), tool("two")] }
          : { tools: [tool("one")], nextCursor: "second" },
      );
    } else if (message.params.name === "wait") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": waiting\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
    } else if (message.params.name === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "streamed before EOF" }] } })}\n\n`,
      );
      streams.add(res);
      req.on("close", () => streams.delete(res));
    } else {
      reply({
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "resource", resource: { uri: "test://resource", text: "resource text" } },
        ],
        isError: message.params.name === "error",
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const client = createMcpClient({
    config: config({ url: `http://127.0.0.1:${address.port}/mcp` }),
    warn: () => {},
  });
  cleanups.push(async () => {
    await client.close();
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, seen, streams, deleted: () => deleted };
}

describe("pi-mcp native HTTP integration", () => {
  it("negotiates, follows pagination, deduplicates and preserves native image/resource content", async () => {
    const { client, seen } = await httpFixture();
    expect((await client.connect()).serverName).toBe("fixture");
    expect((await client.listTools()).map((item) => item.name)).toEqual(["one", "two"]);
    const result = await client.callTool("echo", { q: "kept" });
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "resource text" },
    ]);
    expect(seen.find((item) => item.method === "tools/call")?.params).toMatchObject({
      arguments: { q: "kept" },
    });
    expect((await client.callTool("error", {})).isError).toBe(true);
  });

  it("dispatches live tool notifications and reads SSE responses before EOF", async () => {
    const fixture = await httpFixture();
    await fixture.client.connect();
    const changed = vi.fn();
    fixture.client.onToolsChanged(changed);
    await vi.waitFor(() => expect(fixture.streams.size).toBe(1));
    for (const stream of fixture.streams)
      stream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect((await fixture.client.callTool("stream", {})).content).toEqual([
      { type: "text", text: "streamed before EOF" },
    ]);
  });

  it("forwards cancellation and closes active requests and the HTTP session", async () => {
    const fixture = await httpFixture();
    await fixture.client.connect();
    const controller = new AbortController();
    const pending = fixture.client.callTool("wait", {}, controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(McpAbortError);
    await vi.waitFor(() =>
      expect(fixture.seen.some((item) => item.method === "tools/call")).toBe(true),
    );
    controller.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(fixture.seen.some((item) => item.method === "notifications/cancelled")).toBe(true),
    );
    const second = fixture.client.callTool("wait", {});
    const closed = expect(second).rejects.toThrow();
    await fixture.client.close();
    await closed;
    expect(fixture.deleted()).toBe(true);
  });
});

const STDIO_SERVER = `
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
 const m = JSON.parse(line);
 if (m.id === undefined) return;
 let result;
 if(m.method === "initialize") result = { protocolVersion:m.params.protocolVersion, capabilities:{tools:{}},serverInfo:{name:"stdio",version:"1"} };
 else if(m.method === "tools/list") result = {tools:[{name:"env",inputSchema:{type:"object"}}]};
 else result = {content:[{type:"text",text:JSON.stringify({private:process.env.OINT_TEST_PRIVATE_TOKEN,explicit:process.env.EXPLICIT_TOKEN})}]};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
});
`;

describe("pi-mcp native stdio integration", () => {
  async function stdioFixture(shim: boolean): Promise<McpClient> {
    const dir = await mkdtemp(path.join(tmpdir(), "oint mcp "));
    cleanups.push(async () => {
      if (path.dirname(path.resolve(dir)) !== path.resolve(tmpdir()))
        throw new Error("Unsafe test cleanup");
      await rm(dir, { recursive: true, force: true });
    });
    const script = path.join(dir, "server.mjs");
    await writeFile(script, STDIO_SERVER);
    const command = shim ? path.join(dir, "server.cmd") : process.execPath;
    if (shim) await writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
    const client = createMcpClient({
      config: config({
        transport: "stdio",
        command,
        args: shim ? [] : [script],
        env: { EXPLICIT_TOKEN: "provided" },
      }),
      warn: () => {},
    });
    cleanups.push(() => client.close());
    return client;
  }

  it("starts a real process with a spaced path and does not inherit parent secrets", async () => {
    vi.stubEnv("OINT_TEST_PRIVATE_TOKEN", "must-not-leak");
    const client = await stdioFixture(false);
    expect((await client.connect()).serverName).toBe("stdio");
    expect((await client.listTools())[0]?.name).toBe("env");
    expect((await client.callTool("env", {})).content).toEqual([
      { type: "text", text: '{"explicit":"provided"}' },
    ]);
    await client.close();
    await expect(client.listTools()).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")(
    "runs Windows .cmd shims with spaced paths through native cross-spawn",
    async () => {
      const client = await stdioFixture(true);
      expect((await client.connect()).serverName).toBe("stdio");
      expect((await client.listTools())[0]?.name).toBe("env");
    },
  );
});
