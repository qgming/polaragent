// 系统 MCP 预设的**真实连通性**测试：对着注册表里每个端点跑一次真正的握手（initialize +
// tools/list），确认「零配置可用」这句话今天仍然成立。
//
// 默认跳过（`OINT_LIVE_MCP=1` 才跑），因为它依赖外网与第三方服务的可用性：
// 放进默认测试集里，某天对方抽风就会让 CI 变红 —— 而那时红的不是我们的代码。
//
// 跑法：
//   PowerShell:  $env:OINT_LIVE_MCP=1; npx vitest run --project node src/main/pisdk/mcp-presets.live.test.ts
//   bash:        OINT_LIVE_MCP=1 npx vitest run --project node src/main/pisdk/mcp-presets.live.test.ts
//
// 什么时候该跑：**往注册表里加预设时**（这是准入证据），以及怀疑某个预设「面板里一直连接失败」
// 到底是对方挂了还是我们坏了的时候。

import { describe, expect, it } from "vitest";
import { createMcpClient } from "@/main/mcp/client";
import { BUILTIN_MCP_SERVERS, builtinMcpConfig } from "@/shared/mcp/builtin-servers";

const live = process.env.OINT_LIVE_MCP === "1";

describe.skipIf(!live)("系统 MCP 预设：真实握手", () => {
  // 远端服务冷启动（GitMCP 实测约 23 秒）比默认的 5 秒宽限长得多
  const TIMEOUT = 60_000;

  it("注册表非空（跳过时也能看出这张表有没有内容）", () => {
    expect(BUILTIN_MCP_SERVERS.length).toBeGreaterThan(0);
  });

  for (const preset of BUILTIN_MCP_SERVERS) {
    it(
      `${preset.id}（${preset.url}）能连上并列出工具`,
      async () => {
        const client = createMcpClient({
          config: builtinMcpConfig(preset, true),
          warn: () => undefined,
        });
        try {
          const handshake = await client.connect();
          expect(handshake.protocolVersion).not.toBe("");
          const tools = await client.listTools();
          // 一个工具都列不出来 = 这个预设对模型没有任何用处（面板会显示「还没有工具」）
          expect(tools.length).toBeGreaterThan(0);
          for (const tool of tools) {
            expect(tool.name).not.toBe("");
          }
          console.log(`  ✓ ${preset.id}: ${handshake.serverName}（${tools.length} 个工具）`);
        } finally {
          await client.close().catch(() => undefined);
        }
      },
      TIMEOUT,
    );
  }
});
