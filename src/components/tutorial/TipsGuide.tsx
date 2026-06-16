// 使用技巧教程
// src/components/tutorial/TipsGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, TipCard } from "./tutorial-shared";

export function TipsGuide() {
  return (
    <section>
      <TutorialTitle
        title="使用技巧"
        description="掌握这些技巧，更高效地使用 PolarAgent。"
      />

      <SectionTitle>快捷键</SectionTitle>
      <Paragraph>
        常用快捷键可以大幅提升操作效率：
      </Paragraph>
      <List>
        <ListItem><strong>Enter</strong>：发送消息</ListItem>
        <ListItem><strong>Shift + Enter</strong>：输入框换行</ListItem>
        <ListItem><strong>Escape</strong>：停止 AI 生成</ListItem>
      </List>

      <TipCard>
        更多功能可以通过点击顶部按钮访问，如搜索、侧边栏切换、教程等。
      </TipCard>

      <SectionTitle>高效提问技巧</SectionTitle>
      <Paragraph>
        清晰准确的提问能获得更好的回复：
      </Paragraph>
      <List>
        <ListItem><strong>明确需求</strong>：说明你想要什么，而不只是问能不能</ListItem>
        <ListItem><strong>提供上下文</strong>：说明背景信息和限制条件</ListItem>
        <ListItem><strong>分步骤</strong>：复杂任务可以拆分成多个小问题</ListItem>
        <ListItem><strong>要求格式</strong>：明确指定输出格式（表格、代码、列表等）</ListItem>
        <ListItem><strong>提供示例</strong>：给出期望输出的示例更容易理解</ListItem>
      </List>

      <TipCard>
        示例对比：❌ "写个代码" → ✅ "用 Python 写一个函数，输入两个数字，返回它们的和，并包含错误处理"
      </TipCard>

      <SectionTitle>代码相关技巧</SectionTitle>
      <List>
        <ListItem>要求添加注释："请添加详细注释"</ListItem>
        <ListItem>要求错误处理："请添加异常处理和边界检查"</ListItem>
        <ListItem>要求测试："请生成单元测试"</ListItem>
        <ListItem>要求优化："请优化性能并说明优化点"</ListItem>
      </List>

      <SectionTitle>迭代优化</SectionTitle>
      <Paragraph>
        通过多轮对话逐步完善结果：
      </Paragraph>
      <List>
        <ListItem>第一轮：获取基本实现</ListItem>
        <ListItem>第二轮：指出不足，要求改进</ListItem>
        <ListItem>第三轮：添加边界情况和优化</ListItem>
        <ListItem>第四轮：完善文档和注释</ListItem>
      </List>

      <SectionTitle>利用对话历史</SectionTitle>
      <List>
        <ListItem>AI 会记住本次对话的所有内容</ListItem>
        <ListItem>可以引用之前的讨论："基于刚才的代码..."</ListItem>
        <ListItem>可以要求对比："这个方案和之前的有什么区别"</ListItem>
      </List>

      <TipCard>
        对话过长时（超过 20 轮），AI 可能遗忘早期内容。此时建议总结关键信息后开启新对话。
      </TipCard>

      <SectionTitle>专业领域应用</SectionTitle>
      <Paragraph>
        针对特定领域优化使用方式：
      </Paragraph>
      <List>
        <ListItem><strong>编程</strong>：明确语言、框架、版本；提供错误信息</ListItem>
        <ListItem><strong>写作</strong>：说明风格、受众、篇幅；给出大纲</ListItem>
        <ListItem><strong>学习</strong>：说明现有基础；要求举例和类比</ListItem>
        <ListItem><strong>分析</strong>：提供完整数据；明确分析维度</ListItem>
      </List>

      <SectionTitle>团队协作技巧</SectionTitle>
      <List>
        <ListItem>为团队设置清晰的角色分工</ListItem>
        <ListItem>让成员专注各自擅长的领域</ListItem>
        <ListItem>复杂任务使用串行模式，确保逻辑连贯</ListItem>
        <ListItem>简单任务使用并行模式，提高效率</ListItem>
      </List>

      <SectionTitle>知识库最佳实践</SectionTitle>
      <List>
        <ListItem>文档使用清晰的章节标题</ListItem>
        <ListItem>重要概念单独成段</ListItem>
        <ListItem>避免过长的单个文档（建议不超过 10000 字）</ListItem>
        <ListItem>相关文档放在同一知识库</ListItem>
      </List>
    </section>
  );
}
