/**
 * 子进程环境变量白名单的回归保护。
 *
 * 这一组的核心是一条**否定性断言**：凭据类的变量必须消失。它比"PATH 还在"重要得多 ——
 * 漏掉一个允许项只是某个工具不工作（可见、可修），漏掉一个拒绝项是静默的凭据外带
 *（不可见、事后才发现）。所以下面把「哪些必须被丢掉」写得比「哪些必须保留」更细。
 */

import { describe, expect, it } from "vitest";
import { buildChildEnv, INHERITED_ENV_KEYS, isInheritedEnvKey } from "./child-env";

/** 一份"真实机器上大概长这样"的环境，凭据与工具链变量混在一起 */
function sampleEnv(): Record<string, string | undefined> {
  return {
    // 工具链：必须活下来
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/alice",
    USER: "alice",
    LANG: "zh_CN.UTF-8",
    TMPDIR: "/tmp",
    // 凭据：必须消失
    OINT_HOME: "/home/alice/.oint",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NPM_TOKEN: "npm-secret",
    MY_OWN_PASSWORD: "hunter2",
    DEEPSEEK_API_KEY: "ds-secret",
  };
}

describe("buildChildEnv", () => {
  it("工具链变量保留下来 —— 少了它们命令根本跑不起来", () => {
    const env = buildChildEnv(sampleEnv());
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.HOME).toBe("/home/alice");
    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(env.TMPDIR).toBe("/tmp");
  });

  it("**凭据类变量一个都不出现** —— 这是白名单存在的唯一理由", () => {
    const env = buildChildEnv(sampleEnv());
    // 逐条列出来而不是只测一两个：漏掉一个命名约定就是一个洞
    for (const key of [
      "OINT_HOME",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "NPM_TOKEN",
      "MY_OWN_PASSWORD",
      "DEEPSEEK_API_KEY",
    ]) {
      expect(env, `${key} 不该出现在子进程环境里`).not.toHaveProperty(key);
    }
  });

  it("是**允许清单**而不是黑名单：没列到的一律丢掉，哪怕名字看着无害", () => {
    const env = buildChildEnv({ PATH: "/bin", SOME_RANDOM_VAR: "x", FOO: "bar" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("大小写不敏感匹配，但按源里的原始拼写输出", () => {
    // Windows 上 Path / PATH 是同一个变量；用原样比较会整个漏掉
    const env = buildChildEnv({ Path: "C:\\Windows\\System32" });
    expect(env.Path).toBe("C:\\Windows\\System32");
    expect(isInheritedEnvKey("path")).toBe(true);
    expect(isInheritedEnvKey("PATH")).toBe(true);
  });

  it("空值省略，而不是写成空串", () => {
    // 语义不同：FOO= 与「没有 FOO」在很多工具里不是一回事（HOME="" 会让某些工具
    // 把家目录解析成当前目录）
    const env = buildChildEnv({ PATH: "/bin", HOME: "" });
    expect(env).not.toHaveProperty("HOME");
  });

  it("undefined 值同样省略", () => {
    const env = buildChildEnv({ PATH: "/bin", HOME: undefined });
    expect(env).not.toHaveProperty("HOME");
  });

  it("extra 覆盖白名单（MCP 的 config.env 走这条）", () => {
    const env = buildChildEnv({ PATH: "/bin", HOME: "/home/a" }, { HOME: "/custom", TOKEN: "t" });
    expect(env.HOME).toBe("/custom");
    // extra 是显式通道，不受白名单约束 —— 用户想传什么就传什么
    expect(env.TOKEN).toBe("t");
  });

  it("extra 给空串 = 明确删掉那个变量", () => {
    const env = buildChildEnv({ PATH: "/bin", HOME: "/home/a" }, { HOME: "" });
    expect(env).not.toHaveProperty("HOME");
    expect(env.PATH).toBe("/bin");
  });

  it("不修改入参", () => {
    const source = { PATH: "/bin", SECRET: "s" };
    buildChildEnv(source);
    expect(source).toEqual({ PATH: "/bin", SECRET: "s" });
  });
});

describe("INHERITED_ENV_KEYS", () => {
  it("清单里没有明显属于凭据的名字 —— 防止有人往后随手加一条", () => {
    // 这条是「未来有人想加 *_TOKEN 进白名单」时的刹车。真需要传凭据时，
    // 走 MCP 的 config.env / 插件的 settings，而不是把它加进全局继承表。
    const suspicious = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
    const offenders = INHERITED_ENV_KEYS.filter((key) => suspicious.test(key));
    expect(offenders).toEqual([]);
  });

  it("包含各平台的必需项", () => {
    for (const key of ["PATH", "HOME", "TEMP", "LANG", "SYSTEMROOT", "PATHEXT"]) {
      expect(isInheritedEnvKey(key)).toBe(true);
    }
  });
});
