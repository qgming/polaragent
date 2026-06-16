// 团队协作教程
// src/components/tutorial/TeamGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function TeamGuide() {
  return (
    <section>
      <TutorialTitle
        title="团队协作"
        description="了解如何使用团队功能让多个 AI 协同工作。"
      />

      <SectionTitle>什么是团队</SectionTitle>
      <Paragraph>
        团队功能允许多个 AI 智能体协同完成复杂任务：
      </Paragraph>
      <List>
        <ListItem><strong>多智能体协作</strong>：不同专长的 AI 共同解决问题</ListItem>
        <ListItem><strong>任务分工</strong>：根据能力自动分配子任务</ListItem>
        <ListItem><strong>信息共享</strong>：团队成员共享上下文和中间结果</ListItem>
        <ListItem><strong>决策协商</strong>：多角度分析和验证方案</ListItem>
      </List>

      <SectionTitle>创建团队</SectionTitle>
      <OrderedList>
        <OrderedListItem number={1}>
          进入「团队」页面，点击「创建团队」
        </OrderedListItem>
        <OrderedListItem number={2}>
          为团队命名并添加描述
        </OrderedListItem>
        <OrderedListItem number={3}>
          添加团队成员（智能体），至少 2 个
        </OrderedListItem>
        <OrderedListItem number={4}>
          为每个成员分配角色和职责
        </OrderedListItem>
        <OrderedListItem number={5}>
          配置协作模式（串行、并行或混合）
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>使用团队</SectionTitle>
      <Paragraph>
        启动团队对话并提出需求：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在主页面或侧边栏选择要使用的团队
        </OrderedListItem>
        <OrderedListItem number={2}>
          描述你的任务或问题
        </OrderedListItem>
        <OrderedListItem number={3}>
          团队会自动分工并开始协作
        </OrderedListItem>
        <OrderedListItem number={4}>
          你可以查看每个成员的工作进度
        </OrderedListItem>
        <OrderedListItem number={5}>
          最终会给出综合的结果和建议
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        团队适合处理需要多种专业能力的复杂任务，如：软件开发（需求分析+编码+测试）、内容创作（策划+撰写+审核）等。
      </TipCard>

      <SectionTitle>协作模式</SectionTitle>
      <Paragraph>
        不同的协作模式适用于不同场景：
      </Paragraph>
      <List>
        <ListItem><strong>串行模式</strong>：成员按顺序工作，后者依赖前者的输出</ListItem>
        <ListItem><strong>并行模式</strong>：成员同时工作，各自独立完成子任务</ListItem>
        <ListItem><strong>混合模式</strong>：根据任务自动选择串行或并行</ListItem>
      </List>

      <SectionTitle>团队管理</SectionTitle>
      <List>
        <ListItem>可以随时调整团队成员和职责</ListItem>
        <ListItem>查看团队的历史协作记录</ListItem>
        <ListItem>导出团队工作报告</ListItem>
        <ListItem>不需要的团队可以归档或删除</ListItem>
      </List>

      <SectionTitle>典型应用场景</SectionTitle>
      <List>
        <ListItem><strong>软件开发</strong>：产品经理+架构师+开发+测试</ListItem>
        <ListItem><strong>内容创作</strong>：策划+写作+编辑+校对</ListItem>
        <ListItem><strong>数据分析</strong>：数据采集+清洗+分析+可视化</ListItem>
        <ListItem><strong>决策支持</strong>：多角度分析+风险评估+方案对比</ListItem>
      </List>
    </section>
  );
}
