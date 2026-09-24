// 开发工具箱 —— 四个确定性的小工具，全部是**插件内置的代码**。
//
// ## ⚠️ 为什么扩展名是 `.cjs` 而不是 `.js`
//
// **踩过，而且很难查。** 这个文件用的是 `require()`（CommonJS），而 Node 决定
// "一个 `.js` 文件是 CJS 还是 ESM"靠的是**向上找最近的 `package.json` 的 `type` 字段**。
// 插件目录里没有 `package.json`，于是它一路找到**应用根**那份 —— 而应用是
// `"type": "module"`。结果：这个文件被当成 ESM 执行，
// `require is not defined in ES module scope`，进程**退出码 1**。
//
// 而宿主当时只报得出"插件进程在完成握手前退出（退出码 1）"—— 原因完全看不出来。
//
// `.cjs` **永远是 CommonJS**，与最近的 package.json 无关；`.mjs` 永远是 ESM。
// 插件想避开这个坑，就用这两个之一；用 `.js` 的话得自己放一份 `package.json`。
//
// ## 这个文件在演示什么
//
// 「插件给模型加工具」这件事**不需要任何外部服务**：没有 MCP server、没有网络、
// 没有云端。一个 `main.js` + 一段纯函数就够了 —— 模型看到的工具与连了远端 MCP
// 的那些**完全一样**（同一张工具表、同一种调用形状）。
//
// ## 权限：只要 `agent.tool.register`
//
// 没有 `fs`、没有 `shell.exec`、没有 `net.fetch`。这四个工具全是纯函数，
// 所以**一个危险权限都不申请** —— 用户面对权限卡时看到的是清一色的低风险。
// 这是刻意的示范：给模型加能力不必等于给它权限。
//
// ## 与技能的分工
//
// `skills/using-toolkit/SKILL.md` 讲的是"什么时候该用这些工具、输入要先怎么处理"。
// 工具本身只说"我接受什么"，技能说"你该怎么想"。两者一起才是完整的贡献：
// 光有工具，模型可能拿 `hash` 去算它本该用 `read` 读的文件。

const { createHash, randomUUID } = require("node:crypto");

/** 支持的哈希算法。**白名单而不是透传** —— 透传的话模型可以传 `md5-sha1` 之类 */
const HASH_ALGORITHMS = ["sha256", "sha512", "sha1", "md5"];

/**
 * 每个工具的声明。
 *
 * 三条来自宿主契约、写错了就会有可读错误的约束：
 *  - `v: 1` 必须对（版本不匹配直接拒绝启动）；
 *  - `parameters.type` 必须是 `"object"`（顶层不是对象的 schema 模型没法填）；
 *  - `description` 是写给**模型**看的，不是写给人看的 —— 它决定模型什么时候会想起这个工具。
 */
const TOOLS = [
  {
    name: "hash",
    description:
      "计算一段文本的哈希值（十六进制）。默认 sha256。用于校验下载内容、比对两段文本是否相同、生成内容指纹。**注意它算的是文本，不是文件** —— 要算文件请先用 read 读出内容。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要计算哈希的文本" },
        algorithm: {
          type: "string",
          enum: HASH_ALGORITHMS,
          description: "哈希算法，默认 sha256",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "encode",
    description:
      "文本的编码转换：base64 / hex / url 的编码与解码。用于看清一段编码过的数据到底写了什么，或把数据编成特定格式。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要转换的文本" },
        format: { type: "string", enum: ["base64", "hex", "url"], description: "编码格式" },
        direction: {
          type: "string",
          enum: ["encode", "decode"],
          description: "encode = 编码，decode = 解码；默认 encode",
        },
      },
      required: ["text", "format"],
    },
  },
  {
    name: "uuid",
    description:
      "生成一个随机的 UUID v4。用于造测试数据、给临时文件起名、生成幂等键。**每次调用结果都不同** —— 需要可复现的标识时不要用它。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "time",
    description:
      "当前时间，或把给定的时间值解析成多种表示（ISO / 本地时间 / Unix 秒 / 毫秒）。用于「今天是几号」、把时间戳翻成人话、比较两个时间点的间隔。**不传 value 就是当前时间。**",
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "string",
          description:
            "要解析的时间：ISO 字符串、Unix 秒或毫秒时间戳、或任何 Date.parse 认得的写法。不传则返回当前时间。",
        },
      },
    },
  },
];

// ── 工具的实现 ────────────────────────────────────────────────────────────────

/** 一个时间点的四种表示 —— 模型经常需要其中某一种，一次给全免得它再猜 */
function describeTime(date) {
  return [
    `ISO        ${date.toISOString()}`,
    `本地时间   ${date.toLocaleString("zh-CN", { timeZoneName: "short" })}`,
    `Unix 秒    ${Math.floor(date.getTime() / 1000)}`,
    `Unix 毫秒  ${date.getTime()}`,
    `星期       ${date.toLocaleDateString("zh-CN", { weekday: "long" })}`,
  ].join("\n");
}

/** `hash` */
function runHash(args) {
  const text = String(args.text ?? "");
  const algorithm = typeof args.algorithm === "string" ? args.algorithm : "sha256";
  // 白名单而不是让 createHash 自己抛：错误信息要能告诉模型"合法的有哪些"
  if (!HASH_ALGORITHMS.includes(algorithm)) {
    return { error: `不支持的算法「${algorithm}」。可用：${HASH_ALGORITHMS.join(", ")}` };
  }
  const digest = createHash(algorithm).update(text, "utf8").digest("hex");
  return { text: `${algorithm}(${text.length} 字符) = ${digest}` };
}

/** `encode` */
function runEncode(args) {
  const text = String(args.text ?? "");
  const format = String(args.format ?? "");
  const direction = args.direction === "decode" ? "decode" : "encode";
  if (!["base64", "hex", "url"].includes(format)) {
    return { error: `不支持的格式「${format}」。可用：base64, hex, url` };
  }

  if (direction === "encode") {
    if (format === "base64") return { text: Buffer.from(text, "utf8").toString("base64") };
    if (format === "hex") return { text: Buffer.from(text, "utf8").toString("hex") };
    return { text: encodeURIComponent(text) };
  }

  try {
    if (format === "base64") return { text: Buffer.from(text, "base64").toString("utf8") };
    if (format === "hex") return { text: Buffer.from(text, "hex").toString("utf8") };
    return { text: decodeURIComponent(text) };
  } catch {
    /*
      解码失败**必须给出可读原因**：一段不是 base64 的文本解出来会是乱码而不是报错
      （`Buffer.from` 不校验），所以这里只兜 URL 解码那种真的会抛的情况。
      乱码那条由技能提醒模型"解出来是乱码说明输入不是这个格式"。
    */
    return { error: `不是合法的 ${format} 编码，解不开` };
  }
}

/** `uuid` */
function runUuid() {
  return { text: randomUUID() };
}

/** `time` */
function runTime(args) {
  const raw = args.value;
  if (raw === undefined || raw === null || raw === "") {
    return { text: describeTime(new Date()) };
  }

  const value = String(raw).trim();
  let date;
  /*
    纯数字先按时间戳解：`Date.parse("1700000000")` 在多数引擎里会把它当成
    **年份** 1700000000 而不是 Unix 秒 —— 那是个静默的错误答案。
    先按 10 位/13 位判一次，剩下的才交给 Date.parse。
  */
  if (/^\d{10}$/.test(value)) {
    date = new Date(Number(value) * 1000);
  } else if (/^\d{13}$/.test(value)) {
    date = new Date(Number(value));
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return { error: `解析不出时间：「${value}」。可以给 ISO 字符串、Unix 秒/毫秒，或 "2024-01-01 10:00" 这类写法` };
  }
  return { text: describeTime(date) };
}

const HANDLERS = { hash: runHash, encode: runEncode, uuid: runUuid, time: runTime };

// ── 与宿主的协议 ──────────────────────────────────────────────────────────────

process.parentPort.on("message", (event) => {
  const message = event.data;
  if (message === null || typeof message !== "object") return;

  if (message.type === "init") {
    process.parentPort.postMessage({
      type: "ready",
      v: 1,
      tools: TOOLS,
      commands: [],
    });
    return;
  }

  if (message.type === "call") {
    const handler = HANDLERS[message.tool];
    if (handler === undefined) {
      // 宿主不会调用没声明的工具，但真到了这一步也要回一条可读的错误而不是静默
      process.parentPort.postMessage({
        type: "result",
        id: message.id,
        error: `不认识工具「${message.tool}」`,
      });
      return;
    }

    /*
      **工具实现抛错一律变成 `error` 字段，不让它冒出去。**
      未捕获的异常会打到进程的顶层，而宿主的处理是"挂起的调用全部按进程退出结算" ——
      那意味着模型看到的是"插件已退出"，而不是"你给的 base64 不合法"。
      前者让它以为自己搞坏了什么，后者它自己能修。
    */
    let result;
    try {
      result = handler(message.args ?? {});
    } catch (error) {
      result = { error: `工具执行出错：${error instanceof Error ? error.message : String(error)}` };
    }

    process.parentPort.postMessage({
      type: "result",
      id: message.id,
      ...(result.error === undefined ? { text: result.text } : { error: result.error }),
    });
  }
});
