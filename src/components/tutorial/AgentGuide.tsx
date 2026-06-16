// 助手管理教程
// src/components/tutorial/AgentGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function AgentGuide() {
  return (
    <section>
      <TutorialTitle
        title="助手管理"
        description="了解如何创建和管理不同角色的 AI 助手。"
      />

      <SectionTitle>什么是助手</SectionTitle>
      <Paragraph>
        助手（Agent）是具有特定角色和能力的 AI。每个助手都有：
      </Paragraph>
      <List>
        <ListItem><strong>头像和名称</strong>：用 Emoji 和名称标识助手</ListItem>
        <ListItem><strong>描述</strong>：说明助手适合处理什么任务</ListItem>
        <ListItem><strong>系统提示词</strong>：定义助手的身份、行为和回答风格</ListItem>
        <ListItem><strong>模型配置</strong>：指定使用的模型服务和具体模型</ListItem>
        <ListItem><strong>启用技能</strong>：选择助手可以调用哪些技能</ListItem>
      </List>

      <SectionTitle>访问助手页面</SectionTitle>
      <Paragraph>
        在助手页面可以查看和管理所有助手：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏的 <strong>「扩展」</strong> 分组展开菜单
        </OrderedListItem>
        <OrderedListItem number={2}>
          点击 <strong>「助手」</strong> 进入助手管理页面
        </OrderedListItem>
        <OrderedListItem number={3}>
          页面顶部有三个标签：助手广场、内置助手、自定义助手
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>助手页面的三个标签</SectionTitle>
      <List>
        <ListItem><strong>助手广场</strong>：浏览和安装社区分享的助手</ListItem>
        <ListItem><strong>内置助手</strong>：系统预装的助手，可以编辑但不能删除</ListItem>
        <ListItem><strong>自定义助手</strong>：你创建的助手，可以完全自定义</ListItem>
      </List>

      <SectionTitle>选择和使用助手</SectionTitle>
      <Paragraph>
        找到合适的助手并开始对话：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在助手页面浏览助手卡片
        </OrderedListItem>
        <OrderedListItem number={2}>
          查看助手的名称、描述和能力说明
        </OrderedListItem>
        <OrderedListItem number={3}>
          点击助手卡片上的 <strong>「开始对话」</strong> 按钮使用该助手创建新会话
        </OrderedListItem>
        <OrderedListItem number={4}>
          或者在主页面的助手下拉菜单中快速选择
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        不同助手适合不同场景：编程助手擅长代码，写作助手擅长文本创作，通用助手则适合日常问答。
      </TipCard>

      <SectionTitle>创建自定义助手</SectionTitle>
      <Paragraph>
        你可以创建符合特定需求的自定义助手：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在助手页面切换到 <strong>「自定义助手」</strong> 标签
        </OrderedListItem>
        <OrderedListItem number={2}>
          点击右上角的 <strong>「+ 创建」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={3}>
          在弹出的编辑器中配置助手（见下文）
        </OrderedListItem>
        <OrderedListItem number={4}>
          点击 <strong>「保存」</strong> 完成创建
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>配置助手：头像与名称</SectionTitle>
      <List>
        <ListItem>点击头像按钮可以选择 Emoji 表情作为助手头像</ListItem>
        <ListItem>在右侧输入框填写助手名称（如"Python 导师"、"文案助手"）</ListItem>
        <ListItem>名称要简洁明了，方便识别</ListItem>
      </List>

      <SectionTitle>配置助手：助手描述</SectionTitle>
      <Paragraph>
        在描述框中说明这个助手适合处理什么任务：
      </Paragraph>
      <List>
        <ListItem>简短描述助手的用途和特长</ListItem>
        <ListItem>让自己和其他用户快速了解助手的定位</ListItem>
        <ListItem>例如："专注于 Python 编程教学和代码优化"</ListItem>
      </List>

      <SectionTitle>配置助手：模型服务与模型</SectionTitle>
      <Paragraph>
        选择助手使用的 AI 模型：
      </Paragraph>
      <List>
        <ListItem><strong>模型服务</strong>：选择"跟随模型设置"使用默认配置，或指定特定服务商</ListItem>
        <ListItem><strong>模型</strong>：选择具体的模型（如 GPT-4、Claude 3.5 等）</ListItem>
        <ListItem>如果留空"跟随默认路由模型"，助手会使用模型设置中的默认模型</ListItem>
      </List>

      <TipCard>
        大部分情况下使用"跟随模型设置"即可。只有在需要特定模型能力时才单独配置。
      </TipCard>

      <SectionTitle>配置助手：系统提示词</SectionTitle>
      <Paragraph>
        系统提示词是定义助手行为的关键，编写时注意：
      </Paragraph>
      <List>
        <ListItem>明确定义助手的 <strong>身份和角色</strong>（"你是一位经验丰富的..."）</ListItem>
        <ListItem>说明 <strong>行为边界</strong>（可以做什么，不可以做什么）</ListItem>
        <ListItem>指定 <strong>回答风格</strong>（正式/轻松、简洁/详细等）</ListItem>
        <ListItem>定义 <strong>工具使用策略</strong>（何时主动使用工具，何时询问）</ListItem>
        <ListItem>提供必要的背景知识和示例</ListItem>
      </List>

      <TipCard>
        系统提示词示例："你是一位经验丰富的 Python 编程导师。请用简洁易懂的语言解答问题，并提供可运行的代码示例。代码要包含必要的注释。优先使用标准库，避免过度依赖第三方包。"
      </TipCard>

      <SectionTitle>配置助手：启用技能</SectionTitle>
      <Paragraph>
        选择助手可以使用哪些技能：
      </Paragraph>
      <List>
        <ListItem>开启 <strong>「全部技能」</strong> 开关，助手自动使用所有技能（包括以后新增的）</ListItem>
        <ListItem>或单独选择特定技能，更精确地控制助手能力</ListItem>
        <ListItem>每个技能都有名称和描述，方便选择</ListItem>
        <ListItem>已启用的技能会显示为选中状态</ListItem>
      </List>

      <TipCard>
        如果不确定需要哪些技能，建议开启"全部技能"，让 AI 根据需要自动选择。
      </TipCard>

      <SectionTitle>编辑和删除助手</SectionTitle>
      <Paragraph>
        管理已有的助手：
      </Paragraph>
      <List>
        <ListItem>在助手卡片上点击 <strong>齿轮图标</strong> 打开编辑器</ListItem>
        <ListItem>修改任何配置后点击「保存」</ListItem>
        <ListItem>新对话会使用更新后的配置，已有对话保持不变</ListItem>
        <ListItem>点击 <strong>垃圾桶图标</strong> 可以删除自定义助手</ListItem>
        <ListItem>内置助手只能编辑，不能删除</ListItem>
      </List>

      <SectionTitle>从助手广场安装</SectionTitle>
      <Paragraph>
        使用社区分享的助手：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          切换到 <strong>「助手广场」</strong> 标签
        </OrderedListItem>
        <OrderedListItem number={2}>
          浏览推荐的助手，查看描述和评分
        </OrderedListItem>
        <OrderedListItem number={3}>
          点击 <strong>「安装」</strong> 按钮添加到你的助手列表
        </OrderedListItem>
        <OrderedListItem number={4}>
          已安装的助手会在自定义助手标签中显示
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>设置默认助手</SectionTitle>
      <Paragraph>
        可以设置默认使用的助手：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在主页面的助手下拉菜单中选择一个助手
        </OrderedListItem>
        <OrderedListItem number={2}>
          之后点击「新对话」会自动使用这个助手
        </OrderedListItem>
        <OrderedListItem number={3}>
          也可以随时在下拉菜单中切换其他助手
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>助手编写技巧</SectionTitle>
      <List>
        <ListItem><strong>明确职责</strong>：一个助手专注做好一件事，而不是什么都做</ListItem>
        <ListItem><strong>清晰指令</strong>：系统提示词要具体，避免模糊的描述</ListItem>
        <ListItem><strong>举例说明</strong>：在提示词中给出期望的输出示例</ListItem>
        <ListItem><strong>控制范围</strong>：明确助手的能力边界，避免超出专长回答</ListItem>
        <ListItem><strong>迭代优化</strong>：根据实际使用效果不断调整提示词</ListItem>
      </List>

      <SectionTitle>助手与模型的关系</SectionTitle>
      <Paragraph>
        理解助手和模型的关系很重要：
      </Paragraph>
      <List>
        <ListItem><strong>模型</strong> 是底层的 AI 引擎（如 GPT-4、Claude）</ListItem>
        <ListItem><strong>助手</strong> 是基于模型的角色定制（通过系统提示词）</ListItem>
        <ListItem>多个助手可以使用同一个模型，但有不同的系统提示词</ListItem>
        <ListItem>助手可以指定专用模型，或使用默认模型</ListItem>
      </List>
    </section>
  );
}
