// 模型设置教程
// src/components/tutorial/ModelGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function ModelGuide() {
  return (
    <section>
      <TutorialTitle
        title="模型设置"
        description="了解如何配置和管理 AI 模型服务提供商。"
      />

      <SectionTitle>支持的模型提供商</SectionTitle>
      <Paragraph>
        PolarAgent 支持多个主流的 AI 模型服务：
      </Paragraph>
      <List>
        <ListItem><strong>OpenAI</strong>：GPT-4, GPT-3.5 等系列模型</ListItem>
        <ListItem><strong>Anthropic</strong>：Claude 系列模型</ListItem>
        <ListItem><strong>Google</strong>：Gemini 系列模型</ListItem>
        <ListItem><strong>本地模型</strong>：Ollama、LM Studio 等本地部署</ListItem>
        <ListItem><strong>其他</strong>：兼容 OpenAI API 格式的自定义服务</ListItem>
      </List>

      <SectionTitle>添加模型服务商</SectionTitle>
      <OrderedList>
        <OrderedListItem number={1}>
          进入设置 → 模型设置
        </OrderedListItem>
        <OrderedListItem number={2}>
          点击「添加服务商」按钮
        </OrderedListItem>
        <OrderedListItem number={3}>
          选择服务商类型（OpenAI、Anthropic 等）
        </OrderedListItem>
        <OrderedListItem number={4}>
          填写 API 密钥和其他必要配置
        </OrderedListItem>
        <OrderedListItem number={5}>
          点击「测试连接」确保配置正确
        </OrderedListItem>
        <OrderedListItem number={6}>
          保存后即可在对话中使用
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        建议配置多个服务商作为备选，当主服务出现问题时可以快速切换。
      </TipCard>

      <SectionTitle>配置本地模型</SectionTitle>
      <Paragraph>
        使用 Ollama 等工具在本地运行模型：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在本地安装并启动 Ollama 服务
        </OrderedListItem>
        <OrderedListItem number={2}>
          下载需要的模型（如 llama2、mistral）
        </OrderedListItem>
        <OrderedListItem number={3}>
          在 PolarAgent 中添加「本地模型」服务商
        </OrderedListItem>
        <OrderedListItem number={4}>
          设置服务地址（通常是 http://localhost:11434）
        </OrderedListItem>
        <OrderedListItem number={5}>
          选择要使用的模型名称
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        本地模型无需网络和 API 费用，但需要较好的硬件（显卡）支持，且推理速度较在线服务慢。
      </TipCard>

      <SectionTitle>设置默认模型</SectionTitle>
      <Paragraph>
        为不同场景设置合适的默认模型：
      </Paragraph>
      <List>
        <ListItem>在模型卡片上点击「设为默认」</ListItem>
        <ListItem>新创建的对话会自动使用默认模型</ListItem>
        <ListItem>可以在对话中随时切换模型</ListItem>
      </List>

      <SectionTitle>模型对比</SectionTitle>
      <Paragraph>
        不同模型有各自的特点和适用场景：
      </Paragraph>
      <List>
        <ListItem><strong>GPT-4</strong>：综合能力最强，适合复杂推理和代码</ListItem>
        <ListItem><strong>GPT-3.5</strong>：响应快速，适合简单问答</ListItem>
        <ListItem><strong>Claude</strong>：擅长长文本理解和生成</ListItem>
        <ListItem><strong>Gemini</strong>：多模态能力强，支持图像理解</ListItem>
      </List>

      <SectionTitle>成本优化</SectionTitle>
      <Paragraph>
        合理使用模型以降低成本：
      </Paragraph>
      <List>
        <ListItem>简单任务使用较小的模型（如 GPT-3.5）</ListItem>
        <ListItem>复杂任务才使用大模型（如 GPT-4）</ListItem>
        <ListItem>避免过长的上下文，及时清空历史</ListItem>
        <ListItem>本地模型适合高频使用场景</ListItem>
      </List>

      <SectionTitle>API 密钥管理</SectionTitle>
      <List>
        <ListItem>妥善保管 API 密钥，不要泄露给他人</ListItem>
        <ListItem>定期更换密钥提高安全性</ListItem>
        <ListItem>设置用量限制防止意外消耗</ListItem>
        <ListItem>在服务商后台监控使用情况</ListItem>
      </List>
    </section>
  );
}
