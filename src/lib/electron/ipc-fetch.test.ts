// 出网桥接的回归测试。
//
// 背景：Response / ReadableStream 无法跨 contextBridge，因此 preload 只回传
// 事件与字节，Response 必须由渲染层组装。这些用例锁住那条契约。
import { afterEach, describe, expect, it, vi } from "vitest";

import { ipcFetch, type FetchStreamEvent } from "./electron-api";

type BridgeRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** 可控的假桥：测试自行决定何时推送 meta / chunk / done / error */
function createFakeBridge() {
  let emit: ((event: FetchStreamEvent) => void) | null = null;
  let aborted = false;
  const requests: BridgeRequest[] = [];

  const bridge = {
    fetchStream(request: BridgeRequest, onEvent: (event: FetchStreamEvent) => void) {
      requests.push(request);
      emit = onEvent;
      return {
        abort() {
          aborted = true;
        },
      };
    },
  };

  return {
    bridge,
    requests,
    wasAborted: () => aborted,
    meta(status = 200, headers: Array<[string, string]> = [["content-type", "text/plain"]]) {
      emit?.({ type: "meta", status, statusText: "OK", headers });
    },
    chunk(text: string) {
      emit?.({ type: "chunk", data: new TextEncoder().encode(text).buffer });
    },
    done() {
      emit?.({ type: "done" });
    },
    fail(message: string) {
      emit?.({ type: "error", message });
    },
  };
}

const URL_UNDER_TEST = "https://example.com/v1/chat/completions";

function installBridge(bridge: ReturnType<typeof createFakeBridge>["bridge"]) {
  vi.stubGlobal("window", { polaragent: { network: { fetchStream: bridge.fetchStream } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ipcFetch", () => {
  it("把请求原样交给主进程桥，并在渲染层还原出可读的 Response", async () => {
    const fake = createFakeBridge();
    installBridge(fake.bridge);

    const promise = ipcFetch(URL_UNDER_TEST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: '{"stream":true}',
    });

    fake.meta(200, [["content-type", "text/event-stream"]]);
    fake.chunk("data: one\n\n");
    fake.chunk("data: two\n\n");
    fake.done();

    const response = await promise;

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: URL_UNDER_TEST,
      method: "POST",
      body: '{"stream":true}',
    });
    expect(fake.requests[0].headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    });

    // Response 是真的：状态、响应头、body 流都能用
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("中止时以 AbortError 拒绝，并通知主进程停止出网", async () => {
    const fake = createFakeBridge();
    installBridge(fake.bridge);

    const controller = new AbortController();
    const promise = ipcFetch(URL_UNDER_TEST, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.wasAborted()).toBe(true);
  });

  it("出网失败时合成 502，并让真实原因出现在错误描述里", async () => {
    const fake = createFakeBridge();
    installBridge(fake.bridge);

    const promise = ipcFetch(URL_UNDER_TEST, { method: "POST" });
    fake.fail("主进程请求失败（POST https://example.com/v1/chat/completions）：net::ERR_CONNECTION_TIMED_OUT");

    const response = await promise;

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("net::ERR_CONNECTION_TIMED_OUT");
  });

  it("首字节之后的失败让 body 流报错，而不是伪造状态码", async () => {
    const fake = createFakeBridge();
    installBridge(fake.bridge);

    const promise = ipcFetch(URL_UNDER_TEST);
    fake.meta();
    fake.chunk("data: partial");

    const response = await promise;
    fake.fail("连接被重置");

    await expect(response.text()).rejects.toThrow("连接被重置");
  });

  // 回归：meta 已到达后中止，body 流必须以 AbortError 终结。
  // 否则调用方（openai SDK 的流迭代器、llm-call 的 response.text()）不与 signal
  // 竞速，等不到任何事件就会永久挂起 —— 表现为点「停止」后整轮对话卡死。
  it("收到响应头后中止，body 读取以 AbortError 结束而不是永久挂起", async () => {
    const fake = createFakeBridge();
    installBridge(fake.bridge);

    const controller = new AbortController();
    const response = await (async () => {
      const promise = ipcFetch(URL_UNDER_TEST, { signal: controller.signal });
      fake.meta(200, [["content-type", "text/event-stream"]]);
      fake.chunk("data: partial\n\n");
      return promise;
    })();

    expect(response.status).toBe(200);
    controller.abort();

    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.wasAborted()).toBe(true);
  });

  // 回归：中止后不应再补发失败响应（502），中止与传输失败必须可区分。
  it("收到响应头后中止，不会被误判成出网失败", async () => {
    const fake = createFakeBridge();
    installBridge(fake.bridge);

    const controller = new AbortController();
    const promise = ipcFetch(URL_UNDER_TEST, { signal: controller.signal });
    fake.meta();
    const response = await promise;

    controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });

    // 中止之后即使再收到 error 事件，也不该改变已终结的流
    fake.fail("主进程请求失败：连接被重置");
    expect(response.status).toBe(200);
  });
});
