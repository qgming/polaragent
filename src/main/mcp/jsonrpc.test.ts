import { describe, expect, it } from "vitest";
import {
  createLineSplitter,
  createSseSplitter,
  describeError,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  parseIncoming,
} from "./jsonrpc";

describe("encodeMessage", () => {
  it("序列化成 JSON 文本（不含换行；分帧由传输层负责）", () => {
    const text = encodeMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(text).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
    expect(text.includes("\n")).toBe(false);
  });
});

describe("parseIncoming", () => {
  it("成功应答：result 为 null 也算合法", () => {
    expect(parseIncoming('{"jsonrpc":"2.0","id":7,"result":null}')).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: null,
    });
  });

  it("失败应答：缺失 code 时回落到 -32700", () => {
    const message = parseIncoming('{"jsonrpc":"2.0","id":"a","error":{"message":"boom"}}');
    expect(message).toEqual({
      jsonrpc: "2.0",
      id: "a",
      error: { code: -32700, message: "boom" },
    });
  });

  it("带 id 的 method 是 server → client 请求，不带 id 的是通知", () => {
    const request = parseIncoming('{"jsonrpc":"2.0","id":3,"method":"sampling/createMessage"}');
    const notification = parseIncoming('{"jsonrpc":"2.0","method":"notifications/message"}');
    expect(request !== null && isRequest(request)).toBe(true);
    expect(notification !== null && isNotification(notification)).toBe(true);
  });

  it("无法识别的输入返回 null", () => {
    expect(parseIncoming("not json")).toBeNull();
    expect(parseIncoming("[1,2]")).toBeNull();
    expect(parseIncoming('{"id":1,"result":1}')).toBeNull();
    expect(parseIncoming('{"jsonrpc":"2.0","id":1}')).toBeNull();
  });

  it("应答可被 isResponse 识别", () => {
    const message = parseIncoming('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(message !== null && isResponse(message)).toBe(true);
  });
});

describe("describeError", () => {
  it("把错误对象压成一行文本", () => {
    expect(describeError({ code: -32601, message: "method not found" })).toBe(
      "method not found（code -32601）",
    );
  });
});

describe("createLineSplitter", () => {
  it("跨 chunk 的报文能拼回来，行尾 \\r 被忽略", () => {
    const messages: string[] = [];
    const splitter = createLineSplitter((text) => messages.push(text));
    splitter.push('{"jsonrpc":"2.0","id":1,');
    splitter.push('"result":{"ok":true}}\r\n');
    splitter.push('{"jsonrpc":"2.0","id":2,"result":{}}\n');
    expect(messages).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '{"jsonrpc":"2.0","id":2,"result":{}}',
    ]);
  });

  it("一次 push 里的多条报文逐条回调", () => {
    const messages: string[] = [];
    const splitter = createLineSplitter((text) => messages.push(text));
    splitter.push('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("createSseSplitter", () => {
  it("按空行切事件块，多行 data 用换行拼接", () => {
    const payloads: string[] = [];
    const splitter = createSseSplitter((payload) => payloads.push(payload));
    splitter.push('event: message\ndata: {"a":1}\n\n');
    splitter.push('data: {"b":\ndata: 2}\n\n');
    expect(payloads).toEqual(['{"a":1}', '{"b":\n2}']);
  });

  it("注释行与没有 data 的块被忽略；未闭合的尾巴不派发", () => {
    const payloads: string[] = [];
    const splitter = createSseSplitter((payload) => payloads.push(payload));
    splitter.push(": keep-alive\n\n");
    splitter.push("event: ping\n\n");
    splitter.push("data: {\"c\":3}\n");
    expect(payloads).toEqual([]);
  });

  it("CRLF 分帧同样成立", () => {
    const payloads: string[] = [];
    const splitter = createSseSplitter((payload) => payloads.push(payload));
    splitter.push('data: {"d":4}\r\n\r\n');
    expect(payloads).toEqual(['{"d":4}']);
  });
});
