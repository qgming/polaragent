import {
  ErrorPrimitive,
  type FileMessagePartComponent,
  groupPartByType,
  type ImageMessagePartComponent,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { File } from "@/renderer/components/assistant-ui/elements/file";
import { Image } from "@/renderer/components/assistant-ui/elements/image";
import { MarkdownText } from "@/renderer/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/renderer/components/assistant-ui/elements/reasoning.aui";
import { ThinkingIndicator } from "@/renderer/components/assistant-ui/elements/thinking-indicator";
import { ToolCallPart, ToolRunGroup, toolActiveLabelKey } from "./ToolParts";

/**
 * 消息正文的共享渲染件：主线程（Thread.tsx）与右侧「子智能体」面板（SubagentPanel 的
 * PanelThread）渲染的是**同一种消息形状** —— ChatMessage 经 message-converter 转成
 * assistant-ui 线程消息后，正文该长什么样由这里这一份实现决定。
 *
 * **为什么必须共用**：同一份消息形状在两个现场各画一遍，两边一定会漂移 —— 改一处的
 * Markdown 排版、工具卡或思考折叠，另一处不会跟着动，用户看到的就是「同一件事有两个样子」。
 * 面板要的是**真的那一套**，不是主线程的近似（面板里曾经用纯文本 + 自制工具行凑合，
 * 结果 Markdown、代码高亮、工具卡全都不见了）。所以正文本体放在这里，
 * 两个调用方只负责各自的外壳：主线程带操作栏与跨天分隔（Thread.tsx），
 * 面板只读、不带动作用于会话的按钮（SubagentPanel.tsx）。
 */

/**
 * 这条助手消息是不是**当前正在跑的那次运行**的第一条。
 *
 * 状态行只挂在这一条上：一次运行会落成好几条相邻的助手消息，状态要显示在整段的左上角，
 * 而不是当前恰好在流式的那一条（它会随着工具调用往后挪）。
 * 必须是「当前这次」而不是「任一次」—— 否则历史上每次运行的段首都会在任一次运行期间亮起。
 * 默认 true：渲染在消息流之外时按"段首"处理。
 */
export const IsRunStartContext = createContext(true);

/**
 * 助手消息的 part 分组：连续推理与工具调用折进「思维链」组，其余按类型单独出。
 * 这张表决定折叠边界，改它等于改消息的阅读节奏，不要随手加项。
 */
export const ASSISTANT_GROUP_BY = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

/** 用户消息里的文本不做 Markdown 解析，原样保留换行 */
const USER_PARTS = {
  Text: ({ text }: { text: string }) => <p className="whitespace-pre-wrap">{text}</p>,
} satisfies MessagePrimitive.Parts.Props["components"];

/**
 * 消息里的错误行：正文渲染完毕后由两个调用方接上（主线程的 AssistantMessage 与面板的
 * PanelAssistantMessage）。挂在消息作用域里而不是抽到外面 —— 它渲染的就是「这条消息
 * 自己在转换时带的错误」（见 message-converter 的 toMessageStatus）。
 */
export function MessageError(): React.JSX.Element {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive dark:bg-destructive/5">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}

/**
 * 运行秒数。官方没有 selector —— `metadata.timing` 要等消息结束才定下来 —— 所以自己起计时器。
 */
function useElapsedLabel(active: boolean): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      setLabel(undefined);
      return;
    }
    const start = Date.now();
    setLabel("0s");
    const id = setInterval(() => {
      setLabel(`${Math.round((Date.now() - start) / 1000)}s`);
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return label;
}

/**
 * 一段过程的耗时（秒）：跑的时候不给值，跑完给总秒数。
 *
 * 挂载时就已经结束（历史回读）不给值 —— 那种情况下没有起点，凭空的耗时是编的，
 * 触发行的文字就退回「思考过程」。
 */
function useFinishedSeconds(active: boolean): number | undefined {
  const startRef = useRef<number | null>(null);
  const [seconds, setSeconds] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (active) {
      startRef.current = Date.now();
      setSeconds(undefined);
      return;
    }
    const start = startRef.current;
    if (start === null) return;
    startRef.current = null;
    // 不足一秒也记 1s：既然跑过一轮，显示 0s 会显得没执行
    setSeconds(Math.max(1, Math.round((Date.now() - start) / 1000)));
  }, [active]);

  return seconds;
}

/**
 * 思考块：不描边的折叠块（ghost），触发行直接坐在正文左线上。
 * 收尾后带上实际耗时 —— 上游的 `duration` 一直是个悬着的参数，从未被传入，这里把它接上。
 */
function ReasoningGroup({ running, children }: { running: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  const duration = useFinishedSeconds(running);

  return (
    <ReasoningRoot variant="ghost" streaming={running}>
      <ReasoningTrigger
        active={running}
        label={t("chat.thinking")}
        duration={duration}
        durationLabel={(seconds) => t("chat.thoughtFor", { seconds })}
      />
      <ReasoningContent aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

/**
 * 运行状态行：整段回复还在跑时展示，有未完成的工具调用就报它的名字，否则是笼统的思考中。
 *
 * 标签从**线程**里取而不是从所在消息取：状态行挂在段首，而正在流式的往往已经是后面那几条
 * （工具调用会把运行切成多条助手消息），只看自己这条会读不到在跑的工具。
 * 只看最后一条助手消息：一次运行里只有它在流式；从尾部往前找，找到就停。
 * 用词条键（字符串）而不是译文做选择器的返回值，Object.is 才稳定。
 */
function AssistantThinking() {
  const { t } = useTranslation();
  const labelKey = useAuiState((s) => {
    if (!s.thread.isRunning) return undefined;
    for (let i = s.thread.messages.length - 1; i >= 0; i -= 1) {
      const message = s.thread.messages[i];
      if (message?.role !== "assistant") continue;
      if (message.status?.type !== "running") break;
      const pending = message.parts.find(
        (part) => part.type === "tool-call" && part.result === undefined,
      );
      return pending?.type === "tool-call"
        ? toolActiveLabelKey(pending.toolName)
        : "tools.thinking";
    }
    return "tools.thinking";
  });
  const elapsed = useElapsedLabel(labelKey !== undefined);

  if (labelKey === undefined) return null;
  return <ThinkingIndicator label={t(labelKey)} elapsed={elapsed} />;
}

/**
 * 助手消息的正文：运行状态行 + 分组后的 part 开关。
 *
 * 消息外壳留在调用方，因为两处的差别是**设计上刻意**的：主线程要操作栏、跨天分隔与
 * 「哪一条是段首」的上下文（Thread.tsx 的 AssistantMessage），面板是只读证据视图，
 * 不要这些（SubagentPanel.tsx 的 PanelAssistantMessage）。
 *
 * `showRunStatus` 是调用方的附加闸门：主线程恒为 true（是不是段首、整段是否在跑由下面
 * 两条判定），面板只在它那条运行真的还活着时传 true —— 历史运行不该再亮「思考中」。
 */
export function AssistantMessageParts({
  showRunStatus,
}: {
  showRunStatus: boolean;
}): React.JSX.Element {
  const isRunStart = useContext(IsRunStartContext);
  // 整段是否还在跑：状态行挂在段首，所以看的是线程而不是这条消息
  const runRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <>
      {/*
        运行状态固定在**整段回复**的左上角：只在段首渲染，且整段还在跑时一直显示。
        不去跟正文抢位置、也不随正文增长往下漂。
      */}
      {isRunStart && runRunning && showRunStatus && <AssistantThinking />}
      <MessagePrimitive.GroupedParts groupBy={ASSISTANT_GROUP_BY} indicator="never">
        {({ part, children }) => {
          switch (part.type) {
            case "group-chainOfThought":
              // 思维链把推理与工具折在一起，这里也要 flex + gap，否则组内两块贴在一起
              return (
                <div
                  data-slot="aui_chain-of-thought"
                  className="flex flex-col gap-y-(--density-gap)"
                >
                  {children}
                </div>
              );
            case "group-tool":
              return <ToolRunGroup indices={part.indices}>{children}</ToolRunGroup>;
            case "group-reasoning":
              return (
                <ReasoningGroup running={part.status.type === "running"}>{children}</ReasoningGroup>
              );
            case "text":
              return <MarkdownText />;
            case "reasoning":
              return <Reasoning {...part} />;
            case "tool-call":
              return part.toolUI ?? <ToolCallPart {...part} />;
            case "data":
              return part.dataRendererUI;
            case "file":
              return (
                <div data-slot="aui_assistant-message-file" className="py-1">
                  <File {...part} />
                </div>
              );
            case "image":
              return (
                <div data-slot="aui_assistant-message-image" className="py-1">
                  <Image {...part} />
                </div>
              );
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
    </>
  );
}

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

/**
 * 用户消息的正文。外壳（气泡、附件、操作栏）留在调用方：主线程是 Thread.tsx 的
 * UserMessage，面板是 SubagentPanel.tsx 的 PanelUserMessage。
 * File / Image 外面各包一层带 data-slot 的容器：那是气泡内的纵向留白，属于正文的一部分。
 */
export function UserMessageParts(): React.JSX.Element {
  return (
    <MessagePrimitive.Parts
      components={{ ...USER_PARTS, File: UserFilePart, Image: UserImagePart }}
    />
  );
}
