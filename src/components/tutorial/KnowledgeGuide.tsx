// 知识库配置教程
// src/components/tutorial/KnowledgeGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function KnowledgeGuide() {
  return (
    <section>
      <TutorialTitle
        title="知识库配置"
        description="了解如何配置知识库，让 AI 访问专业知识和文档。"
      />

      <SectionTitle>什么是知识库</SectionTitle>
      <Paragraph>
        知识库允许 AI 访问和检索你提供的文档和数据：
      </Paragraph>
      <List>
        <ListItem><strong>文档索引</strong>：自动分析和索引上传的文档</ListItem>
        <ListItem><strong>语义搜索</strong>：基于意图而非关键词查找信息</ListItem>
        <ListItem><strong>上下文增强</strong>：自动为回复补充相关知识</ListItem>
        <ListItem><strong>实时更新</strong>：添加新文档后立即可用</ListItem>
      </List>

      <SectionTitle>创建知识库</SectionTitle>
      <OrderedList>
        <OrderedListItem number={1}>
          进入「知识库」页面，点击「创建知识库」
        </OrderedListItem>
        <OrderedListItem number={2}>
          为知识库命名并添加描述
        </OrderedListItem>
        <OrderedListItem number={3}>
          选择嵌入模型（用于向量化文档）
        </OrderedListItem>
        <OrderedListItem number={4}>
          上传文档或添加文本内容
        </OrderedListItem>
        <OrderedListItem number={5}>
          等待索引完成后即可使用
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>支持的文档格式</SectionTitle>
      <Paragraph>
        知识库支持多种常见文档格式：
      </Paragraph>
      <List>
        <ListItem><strong>文本文档</strong>：TXT, MD, PDF, DOCX</ListItem>
        <ListItem><strong>代码文件</strong>：支持各种编程语言源码</ListItem>
        <ListItem><strong>数据文件</strong>：CSV, JSON, YAML</ListItem>
        <ListItem><strong>网页内容</strong>：HTML 或通过 URL 抓取</ListItem>
      </List>

      <TipCard>
        建议将同一主题或项目的相关文档放在同一个知识库中，便于 AI 理解上下文关系。
      </TipCard>

      <SectionTitle>使用知识库</SectionTitle>
      <Paragraph>
        在对话中引用知识库内容：
      </Paragraph>
      <List>
        <ListItem>创建对话时选择关联的知识库</ListItem>
        <ListItem>AI 会自动检索相关内容并引用</ListItem>
        <ListItem>可以明确要求："根据知识库回答..."</ListItem>
        <ListItem>引用的内容会在回复中标注来源</ListItem>
      </List>

      <SectionTitle>配置嵌入模型</SectionTitle>
      <Paragraph>
        嵌入模型负责将文档转换为向量表示：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          进入设置 → 嵌入配置
        </OrderedListItem>
        <OrderedListItem number={2}>
          选择嵌入模型提供商（OpenAI、本地模型等）
        </OrderedListItem>
        <OrderedListItem number={3}>
          填写 API 密钥或模型路径
        </OrderedListItem>
        <OrderedListItem number={4}>
          测试连接确保配置正确
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        本地嵌入模型无需 API 费用，但需要较好的硬件性能。在线服务响应更快但会产生费用。
      </TipCard>

      <SectionTitle>管理知识库</SectionTitle>
      <List>
        <ListItem>可以随时添加或删除文档</ListItem>
        <ListItem>更新文档后需要重新索引</ListItem>
        <ListItem>查看知识库的使用统计</ListItem>
        <ListItem>导出知识库内容和索引</ListItem>
      </List>

      <SectionTitle>最佳实践</SectionTitle>
      <List>
        <ListItem>文档内容保持清晰的结构和标题</ListItem>
        <ListItem>避免上传重复或过时的内容</ListItem>
        <ListItem>定期清理不需要的文档</ListItem>
        <ListItem>大文档建议分割成多个小文件</ListItem>
      </List>
    </section>
  );
}
