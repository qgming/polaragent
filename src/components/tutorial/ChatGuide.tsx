// 对话功能教程
// src/components/tutorial/ChatGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function ChatGuide() {
  return (
    <section>
      <TutorialTitle
        title="对话功能"
        description="了解如何高效地与 AI 助手进行对话交流。"
      />

      <SectionTitle>创建和切换对话</SectionTitle>
      <Paragraph>
        PolarAgent 支持多个并行对话，每个对话独立保存上下文：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏顶部的 <strong>「新对话」</strong> 按钮（+ 图标）创建新对话
        </OrderedListItem>
        <OrderedListItem number={2}>
          在侧边栏的对话列表中点击任意对话标题即可切换
        </OrderedListItem>
        <OrderedListItem number={3}>
          每个对话都会自动根据内容生成标题
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>输入和发送消息</SectionTitle>
      <Paragraph>
        掌握以下输入技巧可以提高对话效率：
      </Paragraph>
      <List>
        <ListItem>按 <strong>Enter</strong> 键发送消息</ListItem>
        <ListItem>按 <strong>Shift + Enter</strong> 在输入框中换行</ListItem>
        <ListItem>点击输入框右侧的发送按钮也可发送</ListItem>
        <ListItem>输入框支持自动调整高度，适应多行文本</ListItem>
      </List>

      <TipCard>
        输入框下方有工具栏，可以添加附件、引用知识库、设置权限模式等。
      </TipCard>

      <SectionTitle>停止生成</SectionTitle>
      <Paragraph>
        如果 AI 的回复不符合预期或生成时间过长，你可以随时中断：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          按 <strong>Escape</strong> 键立即停止生成
        </OrderedListItem>
        <OrderedListItem number={2}>
          或点击输入框右侧出现的 <strong>「停止」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={3}>
          停止后可以重新编辑提示词并再次发送
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>管理对话</SectionTitle>
      <Paragraph>
        右键点击侧边栏中的对话可以进行管理操作：
      </Paragraph>
      <List>
        <ListItem><strong>重命名</strong>：修改对话标题</ListItem>
        <ListItem><strong>清空对话</strong>：删除所有消息，但保留会话</ListItem>
        <ListItem><strong>删除对话</strong>：永久删除整个对话</ListItem>
      </List>

      <TipCard>
        清空对话后会重置上下文，AI 将不记得之前的交流内容。删除对话则会完全移除该会话。
      </TipCard>

      <SectionTitle>搜索对话历史</SectionTitle>
      <Paragraph>
        使用全局搜索快速找到历史对话：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击顶部标题栏的 <strong>搜索图标</strong>（放大镜）
        </OrderedListItem>
        <OrderedListItem number={2}>
          输入关键词搜索对话标题和消息内容
        </OrderedListItem>
        <OrderedListItem number={3}>
          点击搜索结果即可跳转到对应对话
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>复制消息内容</SectionTitle>
      <Paragraph>
        轻松复制 AI 的回复内容：
      </Paragraph>
      <List>
        <ListItem>将鼠标悬停在消息上，点击右上角的 <strong>「复制」</strong> 按钮</ListItem>
        <ListItem>代码块有独立的 <strong>「复制代码」</strong> 按钮</ListItem>
        <ListItem>复制后会显示「已复制」提示</ListItem>
      </List>

      <SectionTitle>工作目录设置</SectionTitle>
      <Paragraph>
        为对话设置工作目录后，AI 可以访问该目录中的文件：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          在主页面底部点击 <strong>「选择工作目录」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={2}>
          选择一个本地文件夹
        </OrderedListItem>
        <OrderedListItem number={3}>
          之后创建的对话都会使用这个目录
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        工作目录主要用于代码项目、文档整理等需要访问文件的场景。
      </TipCard>

      <SectionTitle>权限模式</SectionTitle>
      <Paragraph>
        控制 AI 使用工具时的权限：
      </Paragraph>
      <List>
        <ListItem><strong>总是询问</strong>：每次使用工具前都需要你确认</ListItem>
        <ListItem><strong>自动允许</strong>：信任的工具自动执行，无需确认</ListItem>
        <ListItem><strong>总是拒绝</strong>：禁止使用所有工具</ListItem>
      </List>

      <Paragraph>
        可以在输入框下方的工具栏中切换权限模式。
      </Paragraph>

      <SectionTitle>对话上下文管理</SectionTitle>
      <Paragraph>
        合理管理对话上下文可以提高 AI 的理解准确度：
      </Paragraph>
      <List>
        <ListItem>避免在一个对话中混合过多不相关的话题</ListItem>
        <ListItem>对话过长时（超过 20-30 轮）考虑清空历史或创建新对话</ListItem>
        <ListItem>使用「清空对话」功能可以重置上下文，但保留会话</ListItem>
        <ListItem>重要的对话建议保留，不要轻易删除</ListItem>
      </List>

      <TipCard>
        当 AI 回复出现混乱、重复或答非所问时，通常意味着上下文过长或混乱。此时建议清空对话或开启新会话。
      </TipCard>

      <SectionTitle>语音输入</SectionTitle>
      <Paragraph>
        如果配置了语音识别服务，可以使用语音输入：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击输入框旁边的 <strong>麦克风图标</strong>
        </OrderedListItem>
        <OrderedListItem number={2}>
          开始说话，系统会自动将语音转为文字
        </OrderedListItem>
        <OrderedListItem number={3}>
          再次点击麦克风图标停止录音
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        语音输入需要在设置中配置语音识别服务（如 Whisper、Azure 等）。
      </TipCard>
    </section>
  );
}
