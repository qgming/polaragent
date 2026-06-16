// Browser Use 教程
// src/components/tutorial/BrowserUseGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, OrderedList, OrderedListItem, TipCard } from "./tutorial-shared";

export function BrowserUseGuide() {
  return (
    <section>
      <TutorialTitle
        title="Browser Use"
        description="通过 Chrome 扩展控制真实浏览器，让 AI 自动操作网页。"
      />

      <SectionTitle>什么是 Browser Use</SectionTitle>
      <Paragraph>
        Browser Use 是 PolarAgent 的高级功能，允许 AI 助手控制真实的 Chrome 浏览器：
      </Paragraph>
      <List>
        <ListItem><strong>真实浏览器环境</strong>：在实际的 Chrome 中操作，保留登录态和 Cookie</ListItem>
        <ListItem><strong>自动化操作</strong>：AI 可以点击、输入、滚动、截图等</ListItem>
        <ListItem><strong>网页交互</strong>：填写表单、浏览网站、提取信息等</ListItem>
        <ListItem><strong>持久化会话</strong>：登录信息在对话间保持</ListItem>
      </List>

      <SectionTitle>第一步：导出浏览器扩展</SectionTitle>
      <Paragraph>
        首先需要将 Browser Use 扩展导出到本地文件夹：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          点击左侧侧边栏底部的 <strong>「设置」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={2}>
          在左侧导航选择 <strong>「高级」</strong> → <strong>「Browser Use」</strong>
        </OrderedListItem>
        <OrderedListItem number={3}>
          找到「安装浏览器扩展」卡片
        </OrderedListItem>
        <OrderedListItem number={4}>
          点击 <strong>「导出扩展到文件夹」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={5}>
          选择一个容易找到的位置保存（如桌面或文档文件夹）
        </OrderedListItem>
        <OrderedListItem number={6}>
          记住导出的文件夹路径（名为 PolarAgent-BrowserUse）
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        导出后的文件夹包含扩展的所有文件，不要修改或删除其中的内容。
      </TipCard>

      <SectionTitle>第二步：在 Chrome 中加载扩展</SectionTitle>
      <Paragraph>
        将导出的扩展安装到 Chrome 浏览器：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          打开 Chrome 浏览器
        </OrderedListItem>
        <OrderedListItem number={2}>
          在地址栏输入并访问：<code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">chrome://extensions</code>
        </OrderedListItem>
        <OrderedListItem number={3}>
          在页面右上角找到并开启 <strong>「开发者模式」</strong> 开关
        </OrderedListItem>
        <OrderedListItem number={4}>
          点击左上角的 <strong>「加载已解压的扩展程序」</strong> 按钮
        </OrderedListItem>
        <OrderedListItem number={5}>
          在弹出的文件选择对话框中，找到并选择刚才导出的 <strong>PolarAgent-BrowserUse</strong> 文件夹
        </OrderedListItem>
        <OrderedListItem number={6}>
          点击 <strong>「选择文件夹」</strong> 完成安装
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        如果看到「开发者模式扩展已停用」的警告，点击「保留」或「仍然使用」继续。这是正常现象，不影响使用。
      </TipCard>

      <SectionTitle>第三步：验证扩展连接</SectionTitle>
      <Paragraph>
        确认扩展已成功连接到 PolarAgent：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          扩展安装完成后，在 Chrome 右上角的扩展图标区域会出现 PolarAgent 图标
        </OrderedListItem>
        <OrderedListItem number={2}>
          回到 PolarAgent 的 Browser Use 设置页面
        </OrderedListItem>
        <OrderedListItem number={3}>
          查看顶部的「Browser Use」卡片，状态应显示为 <strong>「已连接」</strong>
        </OrderedListItem>
        <OrderedListItem number={4}>
          「可操作标签页」应该显示当前打开的标签页数量
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        如果状态显示「未连接」，尝试刷新 Chrome 标签页或重启 PolarAgent。
      </TipCard>

      <SectionTitle>使用 Browser Use</SectionTitle>
      <Paragraph>
        在对话中让 AI 使用浏览器执行任务：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          创建一个新对话
        </OrderedListItem>
        <OrderedListItem number={2}>
          在输入框中输入需要浏览器操作的任务，例如：
          <ul className="ml-6 mt-2 space-y-1 text-sm">
            <li>• "打开 GitHub 并搜索 TypeScript 项目"</li>
            <li>• "访问天气网站查询北京的天气"</li>
            <li>• "帮我填写这个表单"（需要先打开表单页面）</li>
          </ul>
        </OrderedListItem>
        <OrderedListItem number={3}>
          AI 会自动调用 Browser Use 工具
        </OrderedListItem>
        <OrderedListItem number={4}>
          你可以在 Chrome 中实时看到 AI 的操作过程
        </OrderedListItem>
      </OrderedList>

      <SectionTitle>高级配置</SectionTitle>
      <Paragraph>
        在 Browser Use 设置页面可以调整以下参数：
      </Paragraph>
      <List>
        <ListItem><strong>WebSocket 端口</strong>：扩展连接 PolarAgent 的本地端口（默认 18765）</ListItem>
        <ListItem><strong>HTTP API 端口</strong>：API 服务端口（默认 18767）</ListItem>
        <ListItem><strong>操作超时时间</strong>：单个操作的最大等待时间（默认 30 秒）</ListItem>
        <ListItem><strong>操作后等待时间</strong>：每次操作后的延迟，避免过快（默认 300 毫秒）</ListItem>
        <ListItem><strong>详细日志</strong>：开启后会输出更多调试信息</ListItem>
      </List>

      <TipCard>
        一般情况下使用默认配置即可。只有在遇到问题或需要特殊优化时才调整这些参数。
      </TipCard>

      <SectionTitle>使用场景示例</SectionTitle>
      <List>
        <ListItem><strong>信息搜集</strong>：让 AI 访问网站并提取特定信息</ListItem>
        <ListItem><strong>表单填写</strong>：自动填写重复性的网页表单</ListItem>
        <ListItem><strong>网页测试</strong>：测试网站的交互功能是否正常</ListItem>
        <ListItem><strong>网页监控</strong>：定期检查网页内容变化</ListItem>
        <ListItem><strong>数据收集</strong>：从多个页面批量收集数据</ListItem>
      </List>

      <SectionTitle>注意事项</SectionTitle>
      <List>
        <ListItem>Browser Use 会控制真实的浏览器，AI 的操作会影响你的浏览器状态</ListItem>
        <ListItem>涉及敏感操作（如支付、删除）时要格外小心，建议使用权限询问模式</ListItem>
        <ListItem>某些网站可能会检测自动化行为并限制访问</ListItem>
        <ListItem>保持 Chrome 浏览器和 PolarAgent 同时运行才能使用此功能</ListItem>
        <ListItem>不要在 AI 操作时手动操作同一个标签页，可能导致冲突</ListItem>
      </List>

      <SectionTitle>常见问题</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: 扩展安装后显示未连接？</Paragraph>
      <List>
        <ListItem>确认 PolarAgent 正在运行</ListItem>
        <ListItem>检查 WebSocket 端口配置是否正确</ListItem>
        <ListItem>尝试刷新 Chrome 标签页</ListItem>
        <ListItem>重启 PolarAgent 或 Chrome</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: AI 无法操作某些网页元素？</Paragraph>
      <List>
        <ListItem>某些动态加载的内容可能需要等待</ListItem>
        <ListItem>复杂的 JavaScript 交互可能不被支持</ListItem>
        <ListItem>尝试让 AI 使用不同的定位方式</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 可以同时控制多个浏览器窗口吗？</Paragraph>
      <Paragraph>
        可以。Browser Use 会自动管理所有打开的标签页，AI 可以在不同标签页间切换操作。
      </Paragraph>
    </section>
  );
}