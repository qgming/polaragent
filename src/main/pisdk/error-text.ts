// 异常转文本：日志与错误文案共用一句话。
//
// 为什么单独放一个文件：这段逻辑在 runtime / ai-approver / subagent-runner /
// subagent-catalog / mcp-servers 里曾各写一份（五份逐字相同）。它的形态是被
// 实际踩出来的，散着放迟早会有一处被单独「改进」而另四处不动，日志口径就开始漂移。
//
// 为什么不是 `String(error)`：内核与 Electron 会抛**带 tag 的普通对象**
//（例如 pi 的 LaneBusy 是 `{ _tag, message }`，不是 Error 子类）。
// `String(obj)` 得到 "[object Object]"，而 JSON 化能保住 message 与 tag ——
// 日志里那两种写法一个能查问题、一个不能。
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    // 循环引用等无法序列化的情况：退回 String，至少不抛
    return String(error);
  }
}
