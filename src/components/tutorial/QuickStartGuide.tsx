// 快速开始指南
// src/components/tutorial/QuickStartGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, OrderedList, OrderedListItem, TipCard, List, ListItem } from "./tutorial-shared";

export function QuickStartGuide() {
  return (
    <section>
      <TutorialTitle
        title="快速开始指南"
        description="欢迎使用 PolarAgent！本指南将帮助你快速上手基本功能。"
      />

      <SectionTitle>第一步：配置模型服务（必需）</SectionTitle>
      <Paragraph>
        在开始使用前，你需要先配置至少一个模型服务提供商，这是使用 PolarAgent 的前提条件：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏底部的 <strong>「设置」</strong> 按钮（齿轮图标）
        </OrderedListItem>
        <OrderedListItem number={2}>
          在设置页面左侧选择 <strong>「模型设置」</strong>
        </OrderedListItem>
        <OrderedListItem number={3}>
          点击右上角的 <strong>「添加服务」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={4}>
          选择你要使用的模型提供商（如 OpenAI、Anthropic、Google 等）
        </OrderedListItem>
        <OrderedListItem number={5}>
          填写以下必要信息：
          <ul className="ml-6 mt-2 space-y-1 text-sm">
            <li>• <strong>API Key</strong>：从服务商官网获取的密钥</li>
            <li>• <strong>Base URL</strong>：服务的 API 地址（通常自动填写）</li>
            <li>• <strong>模型名称</strong>：选择要使用的具体模型</li>
          </ul>
        </OrderedListItem>
        <OrderedListItem number={6}>
          点击右下角的 <strong>「保存」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={7}>
          确保该服务商卡片上的开关是 <strong>启用</strong> 状态
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        如果你还没有 API Key，请访问对应服务商的官网注册并获取。常见服务商：OpenAI (platform.openai.com)、Anthropic (console.anthropic.com)、Google AI Studio (aistudio.google.com)。大部分服务商都提供免费试用额度。
      </TipCard>

      <SectionTitle>第二步：个性化设置（可选）</SectionTitle>
      <Paragraph>
        根据个人喜好调整应用设置，提升使用体验：
      </Paragraph>

      <Paragraph className="mt-4 font-medium">偏好设置</Paragraph>
      <List>
        <ListItem><strong>主题</strong>：选择亮色、深色或跟随系统</ListItem>
        <ListItem><strong>对话字体</strong>：无衬线、衬线或等宽字体</ListItem>
        <ListItem><strong>对话字号</strong>：小、中、大、特大</ListItem>
        <ListItem><strong>语音输入</strong>：配置自动发送和文本优化</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">图片设置</Paragraph>
      <List>
        <ListItem>配置图片生成服务（OpenAI DALL-E、Google Gemini 等）</ListItem>
        <ListItem>填写相应的 API Key 和配置参数</ListItem>
        <ListItem>设置默认的图片尺寸和质量</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">音频设置</Paragraph>
      <List>
        <ListItem><strong>语音识别（ASR）</strong>：配置 Whisper、Azure Speech 等服务</ListItem>
        <ListItem><strong>语音合成（TTS）</strong>：配置文字转语音服务</ListItem>
        <ListItem>填写 API Key 和选择语音模型</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">网络搜索</Paragraph>
      <List>
        <ListItem>配置搜索引擎（Brave Search、Exa、SearXNG）</ListItem>
        <ListItem>填写 API Key 或服务器地址</ListItem>
        <ListItem>让 AI 可以实时搜索网络信息</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">嵌入配置（知识库）</Paragraph>
      <List>
        <ListItem>配置文档向量化服务（OpenAI Embeddings、本地模型等）</ListItem>
        <ListItem>用于知识库的语义搜索功能</ListItem>
      </List>

      <SectionTitle>第三步：创建你的第一个对话</SectionTitle>
      <Paragraph>
        模型配置完成后，就可以开始与 AI 对话了：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏顶部的 <strong>「新对话」</strong> 按钮（+ 图标）
        </OrderedListItem>
        <OrderedListItem number={2}>
          在主页面底部的输入框中输入你的问题或需求
        </OrderedListItem>
        <OrderedListItem number={3}>
          按 <strong>Enter</strong> 键发送消息（不是 Shift + Enter）
        </OrderedListItem>
        <OrderedListItem number={4}>
          AI 助手将开始回复，你可以继续追问或调整需求
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        按住 <strong>Shift + Enter</strong> 可以在输入框中换行，而不是发送消息。这在输入多行文本时很有用。
      </TipCard>

      <SectionTitle>第四步：选择助手（可选）</SectionTitle>
      <Paragraph>
        PolarAgent 支持多个助手角色，每个助手都有不同的专长和能力：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏的 <strong>「扩展」</strong> 分组展开菜单
        </OrderedListItem>
        <OrderedListItem number={2}>
          选择 <strong>「助手」</strong> 进入助手管理页面
        </OrderedListItem>
        <OrderedListItem number={3}>
          浏览可用的助手卡片，查看它们的介绍和能力
        </OrderedListItem>
        <OrderedListItem number={4}>
          点击助手卡片上的 <strong>「开始对话」</strong> 按钮，使用该助手创建新对话
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        在主页面（点击侧边栏「新对话」进入）也可以通过下拉菜单快速选择助手。
      </TipCard>

      <SectionTitle>管理对话历史</SectionTitle>
      <Paragraph>
        左侧侧边栏会显示你的所有对话历史：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击任意对话标题即可切换到该对话
        </OrderedListItem>
        <OrderedListItem number={2}>
          右键点击对话可以重命名、清空或删除
        </OrderedListItem>
        <OrderedListItem number={3}>
          使用顶部标题栏的 <strong>搜索按钮</strong>（放大镜图标）可以快速查找历史对话内容
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>快捷键提示</SectionTitle>
      <Paragraph>
        掌握这些快捷键可以提高使用效率：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          <strong>Enter</strong>：发送消息
        </OrderedListItem>
        <OrderedListItem number={2}>
          <strong>Shift + Enter</strong>：在输入框中换行
        </OrderedListItem>
        <OrderedListItem number={3}>
          <strong>Escape</strong>：停止 AI 生成回复
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        你也可以使用顶部按钮来打开搜索、切换侧边栏等功能。
      </TipCard>

      <SectionTitle>下一步</SectionTitle>
      <Paragraph>
        完成快速入门后，你可以：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          查看 <strong>「对话功能」</strong> 教程，了解更多对话技巧
        </OrderedListItem>
        <OrderedListItem number={2}>
          探索 <strong>「技能使用」</strong> 和 <strong>「工具集成」</strong>，扩展 AI 的能力
        </OrderedListItem>
        <OrderedListItem number={3}>
          尝试 <strong>「团队协作」</strong> 功能，让多个 AI 协同工作
        </OrderedListItem>
        <OrderedListItem number={4}>
          配置 <strong>Browser Use</strong> 和 <strong>Computer Use</strong> 等高级功能
        </OrderedListItem>
        <OrderedListItem number={5}>
          阅读 <strong>「使用技巧」</strong>，掌握高效使用方法
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        如果在使用过程中遇到问题，可以查看 <strong>「常见问题」</strong> 章节获取帮助。
      </TipCard>
    </section>
  );
}
