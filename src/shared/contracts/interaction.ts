/**
 * 提问（ask_user）的契约：模型提问、用户作答、以及「没人回答」的两种收尾。
 *
 * 与审批（approval.ts）是两件事：审批问的是「这个工具调用能不能跑」，结论只有放行/拒绝；
 * 提问问的是「你要什么」，结论是用户给出的内容。所以两者的形状与结算语义都不共用。
 */

/** 一道题：header 是短标签，question 是正文，options 是可选答案 */
export interface AskQuestion {
  id: string;
  /** 一两个词的短标签，卡片上作标题用 */
  header: string;
  question: string;
  /** 候选答案；缺省表示只能自由输入。自由输入框由界面自带，模型不要把「其他」写进这里 */
  options?: string[];
  /** 多选；缺省为单选 */
  multiSelect?: boolean;
}

/** 一次提问请求：一次 ask_user 调用可以带多道题，登记成一条请求 */
export interface AskRequest {
  id: string;
  sessionId: string;
  /** 产生这次提问的工具调用 id：同一次调用只登记一条（见 interactions.ts 的去重） */
  toolCallId: string;
  questions: AskQuestion[];
  createdAt: number;
}

/** 单题的回答：选项与自由输入可以并存（选了现成答案再补一句说明） */
export interface AskAnswerItem {
  questionId: string;
  /** 用户勾选的选项文本，原样回传；空数组表示这题没选 */
  selected: string[];
  /** 自由输入的补充说明；缺省表示没写 */
  text?: string;
}

/** 提问结果：已回答 / 超时没回应 / 运行被停止 */
export type AskOutcome = "answered" | "unanswered" | "cancelled";

/** 结算后的回答：id 与对应请求一致 */
export interface AskResponse {
  id: string;
  outcome: AskOutcome;
  answers: AskAnswerItem[];
  /** 补充说明（超时原因等）；缺省表示没有 */
  note?: string;
}

/** respond 的载荷：id 由服务按请求带出，调用方只交结论 */
export type AskReply = Omit<AskResponse, "id">;
