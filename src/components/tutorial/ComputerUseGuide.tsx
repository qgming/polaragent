// Computer Use 教程
// src/components/tutorial/ComputerUseGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function ComputerUseGuide() {
  return (
    <section>
      <TutorialTitle
        title="Computer Use"
        description="让 AI 控制你的计算机，执行鼠标点击、键盘输入和屏幕操作。"
      />

      <SectionTitle>什么是 Computer Use</SectionTitle>
      <Paragraph>
        Computer Use 允许 AI 直接控制你的计算机进行操作：
      </Paragraph>
      <List>
        <ListItem><strong>屏幕控制</strong>：AI 可以查看屏幕内容并定位元素</ListItem>
        <ListItem><strong>鼠标操作</strong>：点击、双击、拖拽等鼠标动作</ListItem>
        <ListItem><strong>键盘输入</strong>：输入文字、快捷键等</ListItem>
        <ListItem><strong>截图分析</strong>：捕获屏幕并理解界面内容</ListItem>
      </List>

      <TipCard>
        Computer Use 功能非常强大，但也有较高的风险。建议在使用时保持警惕，避免让 AI 执行敏感操作。
      </TipCard>

      <SectionTitle>启用 Computer Use</SectionTitle>
      <Paragraph>
        Computer Use 功能默认可用，无需额外安装：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏的 <strong>「设置」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={2}>
          选择 <strong>「高级」</strong> → <strong>「Computer Use」</strong>
        </OrderedListItem>
        <OrderedListItem number={3}>
          查看和调整相关配置参数
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>配置选项</SectionTitle>
      <Paragraph>
        可以调整以下参数优化 Computer Use 的行为：
      </Paragraph>
      <List>
        <ListItem><strong>持久化 Worker</strong>：保持后台进程运行，提高响应速度</ListItem>
        <ListItem><strong>最大搜索深度</strong>：界面元素的搜索层级限制（默认 5）</ListItem>
        <ListItem><strong>最大节点数</strong>：一次分析的界面元素数量（默认 250）</ListItem>
        <ListItem><strong>截图模式</strong>：选择截图的存储和传输方式</ListItem>
        <ListItem><strong>恢复剪贴板</strong>：操作后恢复原剪贴板内容</ListItem>
        <ListItem><strong>操作超时时间</strong>：单个操作的最大等待时间（默认 60 秒）</ListItem>
      </List>

      <SectionTitle>使用 Computer Use</SectionTitle>
      <Paragraph>
        在对话中请求 AI 执行计算机操作：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          创建新对话
        </OrderedListItem>
        <OrderedListItem number={2}>
          描述你想要执行的操作，例如：
          <ul className="ml-6 mt-2 space-y-1 text-sm">
            <li>• "打开记事本并输入一段文字"</li>
            <li>• "截取当前屏幕并分析内容"</li>
            <li>• "点击屏幕左上角的按钮"</li>
          </ul>
        </OrderedListItem>
        <OrderedListItem number={3}>
          AI 会请求 Computer Use 权限
        </OrderedListItem>
        <OrderedListItem number={4}>
          确认授权后，AI 将执行操作
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        首次使用时，建议选择「总是询问」权限模式，这样每次操作都需要你的确认。
      </TipCard>

      <SectionTitle>使用场景</SectionTitle>
      <List>
        <ListItem><strong>自动化任务</strong>：重复性的界面操作自动化</ListItem>
        <ListItem><strong>截图分析</strong>：让 AI 查看和理解屏幕内容</ListItem>
        <ListItem><strong>软件测试</strong>：自动测试软件界面功能</ListItem>
        <ListItem><strong>演示录制</strong>：自动执行演示步骤</ListItem>
        <ListItem><strong>数据录入</strong>：批量填写表单或输入数据</ListItem>
      </List>

      <SectionTitle>安全注意事项</SectionTitle>
      <List>
        <ListItem><strong>权限控制</strong>：使用「总是询问」模式，避免误操作</ListItem>
        <ListItem><strong>敏感操作</strong>：涉及文件删除、系统设置等要格外小心</ListItem>
        <ListItem><strong>监督执行</strong>：AI 执行时要在旁观察，随时准备中止</ListItem>
        <ListItem><strong>备份数据</strong>：重要操作前先备份相关数据</ListItem>
        <ListItem><strong>隐私保护</strong>：AI 会截取屏幕，注意不要泄露敏感信息</ListItem>
      </List>

      <TipCard>
        Computer Use 会将屏幕截图发送给 AI 模型进行分析。如果屏幕上有敏感信息（密码、个人资料等），请避免使用此功能。
      </TipCard>

      <SectionTitle>限制和注意事项</SectionTitle>
      <List>
        <ListItem>操作速度受限于 AI 的理解和决策速度，不适合实时性要求高的任务</ListItem>
        <ListItem>复杂界面可能难以准确识别，导致操作失败</ListItem>
        <ListItem>某些应用程序可能阻止自动化操作</ListItem>
        <ListItem>多显示器环境下可能出现定位偏差</ListItem>
        <ListItem>频繁使用会消耗较多 AI Token（因为需要传输截图）</ListItem>
      </List>

      <SectionTitle>最佳实践</SectionTitle>
      <List>
        <ListItem>将复杂任务拆分成多个简单步骤，逐步执行</ListItem>
        <ListItem>给 AI 提供明确的界面位置描述（左上角、中间按钮等）</ListItem>
        <ListItem>在简单、熟悉的界面上使用效果最好</ListItem>
        <ListItem>先在测试环境中尝试，确认可行后再用于正式工作</ListItem>
        <ListItem>保持窗口焦点稳定，避免在 AI 操作时切换窗口</ListItem>
      </List>

      <SectionTitle>故障排查</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: AI 无法找到屏幕上的元素？</Paragraph>
      <List>
        <ListItem>尝试提供更详细的位置描述</ListItem>
        <ListItem>确保目标元素清晰可见，没有被遮挡</ListItem>
        <ListItem>增大窗口或调整界面布局</ListItem>
        <ListItem>使用具体的颜色、文字等特征描述</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 操作执行失败或超时？</Paragraph>
      <List>
        <ListItem>检查应用程序是否响应正常</ListItem>
        <ListItem>增加操作超时时间配置</ListItem>
        <ListItem>将复杂操作拆分成更小的步骤</ListItem>
        <ListItem>确保没有弹窗或对话框阻塞操作</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: Computer Use 与 Browser Use 有什么区别？</Paragraph>
      <Paragraph>
        Browser Use 专门用于浏览器自动化，可以直接访问网页 DOM，更精确高效。Computer Use 是通用的桌面自动化，通过视觉识别控制任何应用程序，但速度较慢且准确性较低。对于网页操作，优先使用 Browser Use。
      </Paragraph>
    </section>
  );
}