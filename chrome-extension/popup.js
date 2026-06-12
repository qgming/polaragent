// 页面加载时检查连接状态
document.addEventListener('DOMContentLoaded', () => {
  checkConnectionStatus();
  // 每3秒刷新一次状态
  setInterval(checkConnectionStatus, 3000);
});

async function checkConnectionStatus() {
  const statusIcon = document.getElementById('statusIcon');
  const statusText = document.getElementById('statusText');
  const statusDetail = document.getElementById('statusDetail');

  try {
    const resp = await chrome.runtime.sendMessage({ cmd: 'status' });

    if (!resp?.ok) {
      throw new Error(resp?.error || '未知错误');
    }

    const data = resp.data || {};
    const isConnected = data.wsConnected;
    const wsUrl = data.wsUrl || 'ws://127.0.0.1:18765';

    if (isConnected) {
      statusIcon.className = 'status-icon connected';
      statusText.textContent = '已连接';
      statusDetail.textContent = `与 PolarAgent 通信正常\n${wsUrl}`;
    } else {
      statusIcon.className = 'status-icon disconnected';
      statusText.textContent = '未连接';
      statusDetail.textContent = '请确保 PolarAgent 应用已启动，并在浏览器中打开至少一个正常网页';
    }
  } catch (e) {
    statusIcon.className = 'status-icon disconnected';
    statusText.textContent = '连接失败';
    statusDetail.textContent = `错误: ${e.message}`;
  }
}
