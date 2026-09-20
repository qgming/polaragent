import blockedPatterns from "./blocked-patterns.json";

/** 命令风险等级：safe 可直接执行，high 需要拦截或额外审批 */
export type CommandRisk = "safe" | "high";

export interface CommandMatch {
  /** 命中的黑名单正则原始串 */
  pattern: string;
  description: string;
}

export interface CommandAssessment {
  risk: CommandRisk;
  matched?: CommandMatch;
}

interface CompiledPattern extends CommandMatch {
  test: RegExp;
}

// 模块加载时编译一次黑名单，后续每次评估复用，避免重复构建正则
const compiledPatterns: CompiledPattern[] = blockedPatterns.patterns.map((item) => ({
  pattern: item.pattern,
  description: item.description,
  test: new RegExp(item.pattern, item.flags),
}));

/** 评估命令风险：命中任一黑名单即 high，否则 safe */
export function assessCommand(command: string): CommandAssessment {
  for (const item of compiledPatterns) {
    if (item.test.test(command)) {
      return {
        risk: "high",
        matched: { pattern: item.pattern, description: item.description },
      };
    }
  }
  return { risk: "safe" };
}
