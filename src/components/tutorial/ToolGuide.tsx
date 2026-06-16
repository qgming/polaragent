// 工具集成教程
// src/components/tutorial/ToolGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, TipCard } from "./tutorial-shared";

export function ToolGuide() {
  return (
    <section>
      <TutorialTitle
        title="工具集成"
        description="了解如何集成和使用外部工具扩展 AI 能力。"
      />

      <SectionTitle>什么是工具</SectionTitle>
      <Paragraph>
        工具（Tool）是 AI 可以调用的外部功能接口：
      </Paragraph>
      <List>
        <ListItem><strong>API 集成</strong>：连接第三方服务和 API</ListItem>
        <ListItem><strong>自动化</strong>：执行系统命令和脚本</ListItem>
        <ListItem><strong>数据源</strong>：访问数据库、文件系统等</ListItem>
      </List>

      <SectionTitle>浏览工具</SectionTitle>
      <Paragraph>
        在工具页面管理所有集成的工具：
      </Paragraph>
      <List>
        <ListItem>查看已配置的工具列表</ListItem>
        <ListItem>查看工具的状态和使用统计</ListItem>
        <ListItem>测试工具连接是否正常</ListItem>
      </List>

      <SectionTitle>配置工具</SectionTitle>
      <Paragraph>
        添加新工具需要提供必要的配置信息：
      </Paragraph>
      <List>
        <ListItem>API 密钥或访问令牌</ListItem>
        <ListItem>服务端点 URL</ListItem>
        <ListItem>认证方式和参数</ListItem>
      </List>

      <TipCard>
        妥善保管 API 密钥等敏感信息，不要在对话中直接发送或分享。
      </TipCard>

      <SectionTitle>常用工具类型</SectionTitle>
      <List>
        <ListItem><strong>搜索引擎</strong>：网页搜索、学术搜索</ListItem>
        <ListItem><strong>代码仓库</strong>：GitHub、GitLab 集成</ListItem>
        <ListItem><strong>云服务</strong>：云存储、云计算平台</ListItem>
        <ListItem><strong>数据库</strong>：SQL、NoSQL 数据库连接</ListItem>
      </List>
    </section>
  );
}
