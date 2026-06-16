// 技能使用教程
// src/components/tutorial/SkillGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function SkillGuide() {
  return (
    <section>
      <TutorialTitle
        title="技能使用"
        description="了解如何使用和管理 AI 的扩展技能。"
      />

      <SectionTitle>什么是技能</SectionTitle>
      <Paragraph>
        技能（Skill）是扩展 AI 能力的模块化功能单元：
      </Paragraph>
      <List>
        <ListItem><strong>预定义能力</strong>：技能封装了特定的任务处理逻辑</ListItem>
        <ListItem><strong>即插即用</strong>：可以随时启用或禁用，无需重启应用</ListItem>
        <ListItem><strong>可组合</strong>：多个技能可以配合使用完成复杂任务</ListItem>
        <ListItem><strong>可更新</strong>：技能可以独立更新，获取新功能</ListItem>
      </List>

      <SectionTitle>浏览技能</SectionTitle>
      <Paragraph>
        在技能页面查看所有可用技能：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧导航栏的「技能」进入技能管理页面
        </OrderedListItem>
        <OrderedListItem number={2}>
          浏览已安装的技能列表和技能商店
        </OrderedListItem>
        <OrderedListItem number={3}>
          点击技能卡片查看详细说明和使用示例
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>安装技能</SectionTitle>
      <Paragraph>
        从技能商店安装新技能：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在技能页面切换到「技能商店」标签
        </OrderedListItem>
        <OrderedListItem number={2}>
          搜索或浏览你需要的技能
        </OrderedListItem>
        <OrderedListItem number={3}>
          点击「安装」按钮，等待下载和安装完成
        </OrderedListItem>
        <OrderedListItem number={4}>
          安装完成后，技能会自动启用
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        建议先从官方技能开始尝试，这些技能经过充分测试，稳定可靠。
      </TipCard>

      <SectionTitle>使用技能</SectionTitle>
      <Paragraph>
        在对话中调用技能功能：
      </Paragraph>
      <List>
        <ListItem>AI 会根据你的需求自动选择合适的技能</ListItem>
        <ListItem>你也可以明确要求使用某个技能："使用 XXX 技能帮我..."</ListItem>
        <ListItem>技能执行时会显示进度和状态</ListItem>
        <ListItem>执行完成后会返回结果和详细信息</ListItem>
      </List>

      <SectionTitle>常用技能类型</SectionTitle>
      <Paragraph>
        PolarAgent 提供多种类型的技能：
      </Paragraph>
      <List>
        <ListItem><strong>数据处理</strong>：文件读写、格式转换、数据分析</ListItem>
        <ListItem><strong>网络请求</strong>：API 调用、网页抓取、数据获取</ListItem>
        <ListItem><strong>代码执行</strong>：运行代码、执行脚本、环境管理</ListItem>
        <ListItem><strong>多媒体</strong>：图像处理、音频转换、视频编辑</ListItem>
        <ListItem><strong>办公自动化</strong>：文档生成、表格处理、邮件发送</ListItem>
      </List>

      <SectionTitle>管理技能</SectionTitle>
      <Paragraph>
        对已安装的技能进行管理：
      </Paragraph>
      <List>
        <ListItem>在「已安装」列表中可以启用或禁用技能</ListItem>
        <ListItem>禁用的技能不会在对话中被调用</ListItem>
        <ListItem>可以更新技能到最新版本</ListItem>
        <ListItem>不需要的技能可以直接卸载</ListItem>
      </List>

      <TipCard>
        如果某个技能频繁被误触发，可以临时禁用它。需要时再重新启用即可。
      </TipCard>

      <SectionTitle>技能权限</SectionTitle>
      <Paragraph>
        某些技能需要特定权限才能正常工作：
      </Paragraph>
      <List>
        <ListItem><strong>文件系统</strong>：读写本地文件和目录</ListItem>
        <ListItem><strong>网络访问</strong>：访问互联网和外部 API</ListItem>
        <ListItem><strong>系统命令</strong>：执行系统命令和脚本</ListItem>
      </List>

      <Paragraph>
        首次使用需要权限的技能时，会弹出授权确认。仔细阅读权限说明后再授予。
      </Paragraph>
    </section>
  );
}
