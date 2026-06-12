# PolarAgent Browser Use Extension

PolarAgent 浏览器控制功能所需的 Chrome 扩展。

## 安装说明

1. 打开 Chrome: `chrome://extensions/`
2. 开启"开发者模式"（右上角开关）
3. 点击"加载已解压的扩展程序"
4. 选择此目录：`chrome-extension`

## 使用要求

- 至少打开一个普通网页（不是 `about:blank` 或 `chrome://` 页面）
- PolarAgent 应用已启动

## 连接状态

扩展会自动连接到 PolarAgent（WebSocket 端口 18765）。
点击扩展图标查看连接状态：

- 🟢 **已连接** - 正常工作
- 🔴 **未连接** - 请确保 PolarAgent 已启动

## 功能说明

扩展提供以下能力：
- ✅ 标签页控制（列出/打开/关闭）
- ✅ 页面内容读取
- ✅ 元素定位和操作
- ✅ JavaScript 执行
- ✅ 页面截图
- ✅ 网络请求监控

## 技术细节

- WebSocket 连接：`ws://127.0.0.1:18765`
- 基于 Chrome DevTools Protocol (CDP)
- 复用真实浏览器会话（保留登录态）

## 来源

基于 [agent-browser-cli](https://github.com/sleepinginsummer/agent-browser-cli) 项目。

