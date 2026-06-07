# 技能目录与内容设计

## 最小结构

```text
skill-name/
  SKILL.md
```

只在技能确实需要时添加资源目录：

```text
skill-name/
  SKILL.md
  references/
  scripts/
  assets/
```

## SKILL.md frontmatter

必需字段：

```yaml
---
name: skill-name
description: 清楚说明技能能做什么，以及用户在什么场景下应该触发它。
---
```

可选字段：

```yaml
license: MIT
allowed-tools: web_search, web_fetch, read_file, write_file
metadata:
  author: PolarAgent
  version: "1.0.0"
  category: 分类
```

## description 写法

好的 description 同时包含两类信息：

- 能力：这个技能能完成什么任务。
- 触发：用户怎么说、遇到什么场景时应该使用它。

示例：

```yaml
description: 创建品牌一致的社交媒体海报和横幅，包括尺寸选择、文案排版、视觉风格、导出检查。当用户要求设计海报、社媒图、广告横幅、活动 banner 或需要多平台图片规格时使用。
```

## 资源目录选择

使用 `references/`：

- 领域知识很长，放在 SKILL.md 会过载。
- 有标准、规范、检查表、API 说明、口径定义。
- 未来助手只在特定任务下需要读取。

使用 `scripts/`：

- 步骤重复、脆弱，手写容易出错。
- 需要确定性处理文件，如转换、校验、批量生成。
- 脚本能用命令行参数复用。

使用 `assets/`：

- 有模板、示例工程、图片、字体、样板文件。
- 这些文件通常会被复制或改写为输出，而不是读入上下文。

## 常见错误

- `name` 与文件夹名不一致。
- description 只写“帮助创建文档”，没有触发场景。
- SKILL.md 过长，把所有背景资料都塞进去。
- 创建 README、快速开始、变更日志等与助手执行无关的文件。
- scripts 没有说明什么时候运行、需要什么参数。
