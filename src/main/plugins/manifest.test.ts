/**
 * 清单校验器。
 *
 * 这一组按**规则**组织，而不是按函数 —— 每条规则一个 describe，
 * 因为校验器的价值就在"哪条规则会拦下什么"。其中几条是从 PI-Desktop 的
 * **实际行为**里学来的（那份方案 §2.1.4b 记了它规范与实现的四处背离），
 * 所以下面会在注释里点明"为什么这条不能松"。
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_SCHEMA_1_0_0,
  OINT_EXTENSION_NAMESPACE,
  type PluginManifestResult,
} from "@/shared/contracts/plugin";
import { isWholeTreePattern, validatePluginManifest } from "./manifest";

/** 一份合法的最小清单；各用例只改自己关心的那一处 */
function valid(): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGINS_SCHEMA_1_0_0,
    name: "git-lens",
    version: "1.0.0",
    description: "在右侧面板里查看 Git 状态",
    extensions: {
      [OINT_EXTENSION_NAMESPACE]: {
        id: "dev.example.git-lens",
        apiVersion: "1",
        permissions: [] as string[],
      },
    },
  };
}

/** 取出 `extensions["dev.oint"]` 并改一处 */
function withOint(patch: Record<string, unknown>): Record<string, unknown> {
  const manifest = valid();
  const extensions = manifest.extensions as Record<string, Record<string, unknown>>;
  Object.assign(extensions[OINT_EXTENSION_NAMESPACE] as Record<string, unknown>, patch);
  return manifest;
}

/** 断言失败，并返回全部错误文案（便于同时检查多条） */
function expectFail(result: PluginManifestResult): string[] {
  expect(result.ok, "本该校验失败").toBe(false);
  if (result.ok) return [];
  return result.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path}: ${issue.message}`);
}

describe("合法清单", () => {
  it("最小清单通过", () => {
    const result = validatePluginManifest(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe("dev.example.git-lens");
    expect(result.manifest.name).toBe("git-lens");
    expect(result.manifest.surfaces).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("不是对象直接失败", () => {
    expect(validatePluginManifest(null).ok).toBe(false);
    expect(validatePluginManifest([]).ok).toBe(false);
    expect(validatePluginManifest("x").ok).toBe(false);
  });
});

describe("$schema：不认识的版本必须拒绝", () => {
  it("缺 $schema 失败", () => {
    const manifest = valid();
    delete manifest.$schema;
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("$schema");
  });

  it("指向别的版本失败", () => {
    // 规范 §5.2：客户端不支持声明的版本时 MUST reject。
    // **不认识却继续加载**是最坏的宽容 —— 一份 2.0 的清单会被当成 1.0 解释，
    // 字段对不上而没有任何提示。
    const manifest = {
      ...valid(),
      $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
    };
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("$schema");
  });
});

describe("name 与 version", () => {
  it.each([
    ["大写", "Git-Lens"],
    ["以连字符开头", "-git"],
    ["连续连字符", "git--lens"],
    ["连续点", "git..lens"],
    ["空串", ""],
    ["过长", "a".repeat(65)],
  ])("name %s 失败", (_label, name) => {
    expect(expectFail(validatePluginManifest({ ...valid(), name })).length).toBeGreaterThan(0);
  });

  it("点号与连字符混用合法（acme.tools / lint3r）", () => {
    expect(validatePluginManifest({ ...valid(), name: "acme.tools" }).ok).toBe(true);
    expect(validatePluginManifest({ ...valid(), name: "lint3r" }).ok).toBe(true);
  });

  it("**version 不是 semver 也放行** —— 这是规范明确规定的", () => {
    // Agent Plugins §5.4 原文：Clients MUST NOT reject a manifest solely because
    // `version` is not valid Semantic Versioning。为一条不参与任何逻辑的元数据
    // 拒绝整个插件，收益是零而代价是兼容性。
    expect(validatePluginManifest({ ...valid(), version: "2026.09-preview" }).ok).toBe(true);
  });

  it("version 缺失或空串失败", () => {
    const noVersion = valid();
    delete noVersion.version;
    expect(validatePluginManifest(noVersion).ok).toBe(false);
    expect(validatePluginManifest({ ...valid(), version: "   " }).ok).toBe(false);
  });
});

describe("未知字段：根上警告、私有层失败", () => {
  it("**根上的未知字段只警告，仍然加载**（规范的 MUST：报告并忽略）", () => {
    // 别的客户端的命名空间必须能被无视地穿过 —— 一个 Oint 看不懂的
    // com.other.client 不该让整个插件装不上。
    const result = validatePluginManifest({ ...valid(), somethingElse: { x: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((issue) => issue.path)).toContain("somethingElse");
  });

  it("**私有层里的未知字段是错误**", () => {
    // 但对 Oint 作者来说它就是打错了。这条与 DSH 那个"非法配置键只 warn 后
    // 静默跳过"的教训同源：配置写错了与配置生效了但没效果，在界面上长得一样。
    const manifest = withOint({ permisions: ["ui.panel"] });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("permisions");
  });

  it("私有层缺 apiVersion 相关的未知字段也报出来", () => {
    const manifest = withOint({ engines: { oint: ">=1" } });
    // engines 是方案里明确不做的那种"发布了但没实现"的字段
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("engines");
  });

  it("缺 extensions 或私有层，直接失败并说明原因", () => {
    const noExtensions = valid();
    delete noExtensions.extensions;
    expect(expectFail(validatePluginManifest(noExtensions)).join()).toContain("extensions");

    const noOint = { ...valid(), extensions: { "com.other.client": {} } };
    expect(expectFail(validatePluginManifest(noOint)).join()).toContain(OINT_EXTENSION_NAMESPACE);
  });
});

describe("id 与 apiVersion", () => {
  it.each([
    ["非反向域名", "git-lens"],
    ["含大写", "Dev.Example"],
  ])("id %s 失败", (_label, id) => {
    expect(expectFail(validatePluginManifest(withOint({ id }))).length).toBeGreaterThan(0);
  });

  it("apiVersion 不认识时拒绝加载，而不是按旧版解释", () => {
    expect(expectFail(validatePluginManifest(withOint({ apiVersion: "2" }))).join()).toContain(
      "apiVersion",
    );
  });
});

describe("权限", () => {
  it("未知权限失败 —— 静默忽略会让作者以为自己申请到了这个能力", () => {
    expect(
      expectFail(
        validatePluginManifest(withOint({ permissions: ["ui.panel", "fs.everything"] })),
      ).join(),
    ).toContain("fs.everything");
  });

  it("重复声明失败", () => {
    expect(
      expectFail(
        validatePluginManifest(withOint({ permissions: ["ui.panel", "ui.panel"] })),
      ).join(),
    ).toContain("重复");
  });

  it("permissions 不是数组失败", () => {
    expect(
      expectFail(validatePluginManifest(withOint({ permissions: "ui.panel" }))).length,
    ).toBeGreaterThan(0);
  });
});

describe("fs 范围", () => {
  it("**读可以整树，写不行** —— 两边的风险不对称", () => {
    const read = withOint({
      permissions: ["fs.read"],
      fs: { read: { root: "workspace", scope: ["**/*"] } },
    });
    expect(validatePluginManifest(read).ok).toBe(true);

    const write = withOint({
      permissions: ["fs.write"],
      fs: { write: { root: "workspace", scope: ["**/*"] } },
    });
    expect(expectFail(validatePluginManifest(write)).join()).toContain("整树通配");
  });

  it.each([["**"], ["**/*"], ["*/**"], ["./*"]])("写范围的 %s 被拒", (pattern) => {
    const manifest = withOint({
      permissions: ["fs.write"],
      fs: { write: { root: "workspace", scope: [pattern] } },
    });
    expect(expectFail(validatePluginManifest(manifest)).length).toBeGreaterThan(0);
  });

  it("写范围写具体子目录放行", () => {
    const manifest = withOint({
      permissions: ["fs.write"],
      fs: { write: { root: "pluginData", scope: ["cache/**"] } },
    });
    expect(validatePluginManifest(manifest).ok).toBe(true);
  });

  it("声明了 fs 范围却没有对应权限，失败", () => {
    const manifest = withOint({ fs: { read: { root: "workspace", scope: ["src/**"] } } });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("fs.read");
  });

  it("有权限但不声明范围是合法的（那是 fail-closed 的形状）", () => {
    // 缺省 = 没有常驻可达范围，每次访问都落到运行期确认 —— "saying nothing grants nothing"
    expect(validatePluginManifest(withOint({ permissions: ["fs.read"] })).ok).toBe(true);
  });

  it("own 只对 delete 合法", () => {
    const manifest = withOint({
      permissions: ["fs.write"],
      fs: { write: { root: "workspace", scope: ["out/**"], own: true } },
    });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("own");
  });

  it("绝对路径与 .. 开头的范围被拒", () => {
    for (const scope of [["/etc/**"], ["../outside/**"]]) {
      const manifest = withOint({ permissions: ["fs.read"], fs: { read: { scope } } });
      expect(expectFail(validatePluginManifest(manifest)).length, String(scope)).toBeGreaterThan(0);
    }
  });
});

describe("net 出站白名单", () => {
  it("**裸 * 被拒** —— 那是「去哪都行」，等于没有白名单", () => {
    const manifest = withOint({ permissions: ["net.fetch"], net: { domains: ["*"] } });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("*");
  });

  it("带子域通配的主机名放行", () => {
    const manifest = withOint({ permissions: ["net.fetch"], net: { domains: ["*.example.com"] } });
    expect(validatePluginManifest(manifest).ok).toBe(true);
  });

  it("带协议/端口/路径的条目被拒（只写主机名）", () => {
    for (const domain of ["https://api.example.com", "api.example.com:443", "api.example.com/v1"]) {
      const manifest = withOint({ permissions: ["net.fetch"], net: { domains: [domain] } });
      expect(expectFail(validatePluginManifest(manifest)).length, domain).toBeGreaterThan(0);
    }
  });

  it("声明了白名单却没有 net.fetch 权限，失败", () => {
    const manifest = withOint({ net: { domains: ["api.example.com"] } });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("net.fetch");
  });
});

describe("shell 命令白名单", () => {
  it("裸命令名放行", () => {
    const manifest = withOint({ permissions: ["shell.exec"], shell: { exec: ["git"] } });
    expect(validatePluginManifest(manifest).ok).toBe(true);
  });

  it("带路径或空格的命令被拒", () => {
    for (const command of ["/usr/bin/git", "C:\\git.exe", "git status"]) {
      const manifest = withOint({ permissions: ["shell.exec"], shell: { exec: [command] } });
      expect(expectFail(validatePluginManifest(manifest)).length, command).toBeGreaterThan(0);
    }
  });

  it("**申请了 shell.exec 却没有白名单 = 失败**（一个用不了的权限是笔误）", () => {
    expect(
      expectFail(validatePluginManifest(withOint({ permissions: ["shell.exec"] }))).join(),
    ).toContain("shell.exec");
  });

  it("有白名单却没有 shell.exec 权限，失败", () => {
    expect(
      expectFail(validatePluginManifest(withOint({ shell: { exec: ["git"] } }))).join(),
    ).toContain("shell.exec");
  });
});

describe("界面声明", () => {
  const panel = {
    id: "git",
    kind: "panel",
    title: { en: "Git", "zh-CN": "Git" },
    entry: "./ui/git.html",
  };

  it("面板声明需要 ui.panel 权限", () => {
    expect(expectFail(validatePluginManifest(withOint({ surfaces: [panel] }))).join()).toContain(
      "ui.panel",
    );
    const withPermission = withOint({ permissions: ["ui.panel"], surfaces: [panel] });
    expect(validatePluginManifest(withPermission).ok).toBe(true);
  });

  it("窗口声明需要 ui.window 权限", () => {
    const window = { ...panel, kind: "window", shape: "widget" };
    expect(expectFail(validatePluginManifest(withOint({ surfaces: [window] }))).join()).toContain(
      "ui.window",
    );
    expect(
      validatePluginManifest(withOint({ permissions: ["ui.window"], surfaces: [window] })).ok,
    ).toBe(true);
  });

  it("模态窗声明需要 ui.modal 权限", () => {
    const modal = { ...panel, kind: "modal" };
    expect(expectFail(validatePluginManifest(withOint({ surfaces: [modal] }))).join()).toContain(
      "ui.modal",
    );
    expect(
      validatePluginManifest(withOint({ permissions: ["ui.modal"], surfaces: [modal] })).ok,
    ).toBe(true);
  });

  it("三种形态各要各的权限：有 ui.panel 也开不了模态窗", () => {
    // 权限卡上要能读出"界面会出现在哪" —— 共用一条权限会让这句话说不清
    const modal = { ...panel, kind: "modal" };
    expect(
      expectFail(
        validatePluginManifest(withOint({ permissions: ["ui.panel"], surfaces: [modal] })),
      ).join(),
    ).toContain("ui.modal");
  });

  it("模态窗接受 width / height（那是对话框尺寸），但拒绝窗口专有字段", () => {
    const modal = { ...panel, kind: "modal", width: 760, height: 560 };
    const ok = validatePluginManifest(withOint({ permissions: ["ui.modal"], surfaces: [modal] }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.surfaces[0]?.width).toBe(760);
      expect(ok.manifest.surfaces[0]?.height).toBe(560);
    }

    for (const field of ["alwaysOnTop", "skipTaskbar", "resizable"] as const) {
      const bad = { ...modal, [field]: true };
      expect(
        expectFail(validatePluginManifest(withOint({ permissions: ["ui.modal"], surfaces: [bad] })))
          .length,
        field,
      ).toBeGreaterThan(0);
    }
  });

  it("entry 必须是 ./ 开头的包内路径", () => {
    for (const entry of ["ui/git.html", "/abs/git.html", "./../outside.html"]) {
      const manifest = withOint({ permissions: ["ui.panel"], surfaces: [{ ...panel, entry }] });
      expect(expectFail(validatePluginManifest(manifest)).length, entry).toBeGreaterThan(0);
    }
  });

  it("title 用对象时必须同时给 en 与 zh-CN", () => {
    const manifest = withOint({
      permissions: ["ui.panel"],
      surfaces: [{ ...panel, title: { en: "Git" } }],
    });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("zh-CN");
  });

  it("界面 id 重复失败", () => {
    const manifest = withOint({ permissions: ["ui.panel"], surfaces: [panel, panel] });
    expect(expectFail(validatePluginManifest(manifest)).join()).toContain("重复");
  });

  it("panel 不能用 widget 形状（widget 是窗口的形态）", () => {
    const manifest = withOint({
      permissions: ["ui.panel"],
      surfaces: [{ ...panel, shape: "widget" }],
    });
    expect(expectFail(validatePluginManifest(manifest)).length).toBeGreaterThan(0);
  });
});

describe("钩子声明", () => {
  /** 一份合法的钩子声明（含它必需的权限与 main） */
  function withHook(hooks: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return withOint({
      permissions: ["hostHooks.register"],
      main: "./main.cjs",
      hooks,
      ...extra,
    });
  }

  it("合法声明通过，并按顺序进入 manifest.hooks", () => {
    const result = validatePluginManifest(
      withHook([
        { id: "no-bash-rm", event: "PreToolUse", matcher: "^bash$" },
        { id: "note", event: "PostToolUse" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.hooks.map((hook) => hook.id)).toEqual(["no-bash-rm", "note"]);
    expect(result.manifest.hooks[0]?.matcher).toBe("^bash$");
  });

  it("**缺 hostHooks.register 权限就失败** —— 用户在装之前必须看到这一条", () => {
    const messages = expectFail(
      validatePluginManifest(
        withOint({ main: "./main.cjs", hooks: [{ id: "guard", event: "PreToolUse" }] }),
      ),
    );
    expect(messages.join("\n")).toContain("hostHooks.register");
  });

  it("**缺 main 就失败** —— 钩子是宿主回调插件进程里的代码", () => {
    const messages = expectFail(
      validatePluginManifest(
        withOint({
          permissions: ["hostHooks.register"],
          hooks: [{ id: "guard", event: "PreToolUse" }],
        }),
      ),
    );
    expect(messages.join("\n")).toContain("main");
  });

  /**
   * 事件名写错分两类，报错文案**必须能区分**它们。
   *
   * 把"生态里有、我们还没做"（SessionStart）说成"未知事件"，作者会去翻文档、
   * 怀疑自己拼错了 —— 而真相是宿主这一侧还没有挂点。
   */
  it("未知事件被拒；生态里有但尚未支持的事件要说清是「还没做」", () => {
    const unknown = expectFail(
      validatePluginManifest(withHook([{ id: "a", event: "PreToolUse2" }])),
    );
    expect(unknown.join("\n")).toContain("未知事件");

    const planned = expectFail(
      validatePluginManifest(withHook([{ id: "a", event: "SessionStart" }])),
    );
    expect(planned.join("\n")).toContain("还没有支持");
    expect(planned.join("\n")).toContain("PreToolUse");
  });

  it("非法正则在校验期就被拒（ZCode 那边是静默不匹配）", () => {
    const messages = expectFail(
      validatePluginManifest(withHook([{ id: "a", event: "PreToolUse", matcher: "([" }])),
    );
    expect(messages.join("\n")).toContain("不是合法的正则");
  });

  it("钩子 id 重复被拒（宿主按 id 分派，重复会让其中一条收不到调用）", () => {
    const messages = expectFail(
      validatePluginManifest(
        withHook([
          { id: "same", event: "PreToolUse" },
          { id: "same", event: "PostToolUse" },
        ]),
      ),
    );
    expect(messages.join("\n")).toContain("重复");
  });

  it("**failure 只能写在 PreToolUse 上** —— 那两个事件拦不住任何东西", () => {
    const messages = expectFail(
      validatePluginManifest(withHook([{ id: "a", event: "PostToolUse", failure: "closed" }])),
    );
    expect(messages.join("\n")).toContain("做不到的承诺");
  });

  it("failure 的取值只能是 open / closed", () => {
    const messages = expectFail(
      validatePluginManifest(withHook([{ id: "a", event: "PreToolUse", failure: "maybe" }])),
    );
    expect(messages.join("\n")).toContain("open 或 closed");
  });

  it("未知字段被拒（表外一律失败，不是静默忽略）", () => {
    const messages = expectFail(
      validatePluginManifest(withHook([{ id: "a", event: "PreToolUse", priority: 3 }])),
    );
    expect(messages.join("\n")).toContain("未知字段");
  });

  it("条数有上限（每条都是一次跨进程往返）", () => {
    const many = Array.from({ length: 17 }, (_, index) => ({
      id: `hook-${index}`,
      event: "PreToolUse",
    }));
    const messages = expectFail(validatePluginManifest(withHook(many)));
    expect(messages.join("\n")).toContain("最多注册 16 条钩子");
  });

  it("没有钩子时 hooks 是空数组（界面据此判断「要不要画那一栏」）", () => {
    const result = validatePluginManifest(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.hooks).toEqual([]);
  });
});

describe("main 入口", () => {
  it("包内相对路径放行（仍需声明 main 的插件自己申请能力）", () => {
    expect(validatePluginManifest(withOint({ main: "./main.js" })).ok).toBe(true);
  });

  it("绝对路径与越界路径被拒", () => {
    for (const main of ["/abs/main.js", "./../main.js", "main.js"]) {
      expect(expectFail(validatePluginManifest(withOint({ main }))).length, main).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("isWholeTreePattern", () => {
  it.each([["**"], ["**/*"], ["*/**"], ["./*"], ["*"], ["./"], ["."]])("%s 是整树", (value) => {
    expect(isWholeTreePattern(value)).toBe(true);
  });

  it.each([["src/**"], ["cache/**/*"], ["*.ts"], ["a/b"]])("%s 不是整树", (value) => {
    expect(isWholeTreePattern(value)).toBe(false);
  });
});
