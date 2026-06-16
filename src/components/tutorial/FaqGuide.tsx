// 常见问题教程
// src/components/tutorial/FaqGuide.tsx

import { TutorialTitle, SectionTitle, Paragraph, List, ListItem, TipCard, OrderedList, OrderedListItem } from "./tutorial-shared";

export function FaqGuide() {
  return (
    <section>
      <TutorialTitle
        title="常见问题"
        description="常见问题解答和故障排查指南。"
      />

      <SectionTitle>模型配置问题</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: API 密钥配置后仍然无法使用？</Paragraph>
      <List>
        <ListItem>检查 API 密钥是否正确复制，注意前后空格</ListItem>
        <ListItem>确认 API 密钥在服务商后台是否有效且有余额</ListItem>
        <ListItem>检查网络连接是否正常</ListItem>
        <ListItem>尝试点击「测试连接」查看具体错误信息</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 本地模型连接失败？</Paragraph>
      <List>
        <ListItem>确认 Ollama 或其他本地服务已启动</ListItem>
        <ListItem>检查服务地址是否正确（通常是 http://localhost:11434）</ListItem>
        <ListItem>确认模型已经下载完成</ListItem>
        <ListItem>检查防火墙是否阻止了连接</ListItem>
      </List>

      <SectionTitle>对话问题</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: AI 回复速度很慢？</Paragraph>
      <List>
        <ListItem>检查网络连接速度</ListItem>
        <ListItem>尝试切换到其他模型服务商</ListItem>
        <ListItem>对话历史过长时，考虑清空或开启新对话</ListItem>
        <ListItem>本地模型需要较好的硬件性能</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: AI 的回复不准确或答非所问？</Paragraph>
      <List>
        <ListItem>尝试更清晰地描述问题和需求</ListItem>
        <ListItem>提供更多上下文和背景信息</ListItem>
        <ListItem>检查是否选择了合适的智能体</ListItem>
        <ListItem>对话历史过长可能导致混乱，建议重新开始</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 对话突然中断或报错？</Paragraph>
      <List>
        <ListItem>检查 API 余额是否充足</ListItem>
        <ListItem>可能触发了内容审核，调整提问方式</ListItem>
        <ListItem>单次回复过长可能导致超时，要求分段回复</ListItem>
        <ListItem>查看错误详情并根据提示操作</ListItem>
      </List>

      <SectionTitle>功能使用问题</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: 如何让 AI 访问本地文件？</Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          创建知识库并上传文件
        </OrderedListItem>
        <OrderedListItem number={2}>
          或在对话中直接描述文件内容
        </OrderedListItem>
        <OrderedListItem number={3}>
          使用具有文件访问权限的技能
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        出于安全考虑，AI 不能直接访问你的文件系统。需要通过知识库或手动提供内容。
      </TipCard>

      <Paragraph className="mt-4 font-medium">Q: 技能安装失败？</Paragraph>
      <List>
        <ListItem>检查网络连接</ListItem>
        <ListItem>确认存储空间充足</ListItem>
        <ListItem>尝试重启应用后再次安装</ListItem>
        <ListItem>查看日志了解具体错误原因</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 团队协作效果不理想？</Paragraph>
      <List>
        <ListItem>检查团队成员的角色定义是否清晰</ListItem>
        <ListItem>调整协作模式（串行/并行/混合）</ListItem>
        <ListItem>确保任务描述足够明确</ListItem>
        <ListItem>考虑调整团队成员组成</ListItem>
      </List>

      <SectionTitle>性能优化问题</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: 应用运行卡顿？</Paragraph>
      <List>
        <ListItem>关闭不需要的对话和团队</ListItem>
        <ListItem>定期清理历史对话</ListItem>
        <ListItem>减少同时运行的任务数量</ListItem>
        <ListItem>检查系统资源使用情况</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 占用存储空间过大？</Paragraph>
      <List>
        <ListItem>定期删除不需要的对话历史</ListItem>
        <ListItem>清理知识库中的过期文档</ListItem>
        <ListItem>卸载不使用的技能</ListItem>
        <ListItem>在设置中查看存储使用详情</ListItem>
      </List>

      <SectionTitle>账户与安全</SectionTitle>

      <Paragraph className="mt-4 font-medium">Q: API 密钥安全吗？</Paragraph>
      <List>
        <ListItem>API 密钥加密存储在本地</ListItem>
        <ListItem>不会上传到任何服务器</ListItem>
        <ListItem>定期更换密钥提高安全性</ListItem>
        <ListItem>不要在对话中直接发送密钥</ListItem>
      </List>

      <Paragraph className="mt-4 font-medium">Q: 对话记录会被上传吗？</Paragraph>
      <List>
        <ListItem>对话记录仅存储在本地设备</ListItem>
        <ListItem>不会上传到 PolarAgent 服务器</ListItem>
        <ListItem>但会发送给你配置的模型服务商</ListItem>
        <ListItem>注意不要在对话中发送敏感信息</ListItem>
      </List>

      <SectionTitle>仍然无法解决？</SectionTitle>
      <Paragraph>
        如果以上方法都无法解决你的问题，可以尝试：
      </Paragraph>
      <OrderedList>
        <OrderedListItem number={1}>
          查看应用日志获取详细错误信息
        </OrderedListItem>
        <OrderedListItem number={2}>
          在设置中点击「重置为默认设置」
        </OrderedListItem>
        <OrderedListItem number={3}>
          访问 GitHub 仓库提交问题反馈
        </OrderedListItem>
        <OrderedListItem number={4}>
          加入社区讨论群寻求帮助
        </OrderedListItem>
      </OrderedList>

      <TipCard>
        提交问题时，请附上详细的错误信息、操作步骤和截图，这样能更快得到帮助。
      </TipCard>
    </section>
  );
}
