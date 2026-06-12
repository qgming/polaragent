document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('portSave')?.addEventListener('click', () => {
    savePort().catch((error) => showMessage(`保存失败: ${error.message}`));
  });

  document.getElementById('connectButton')?.addEventListener('click', () => {
    reconnect().catch((error) => showMessage(`连接失败: ${error.message}`));
  });

  checkConnectionStatus().catch((error) => showMessage(`错误: ${error.message}`));
  setInterval(() => {
    checkConnectionStatus().catch((error) => showMessage(`错误: ${error.message}`));
  }, 3000);
});

async function checkConnectionStatus() {
  const portInput = document.getElementById('portInput');
  const portValue = document.getElementById('portValue');

  try {
    const resp = await chrome.runtime.sendMessage({ cmd: 'status' });
    if (!resp?.ok) throw new Error(resp?.error || '未知错误');

    const data = resp.data || {};
    const isConnected = !!data.wsConnected;
    const wsPort = data.wsPort || 18765;
    const wsUrl = data.wsUrl || `ws://127.0.0.1:${wsPort}`;

    if (portInput) portInput.value = String(wsPort);
    if (portValue) portValue.textContent = String(wsPort);

    setStatusDot(isConnected ? 'connected' : '');
    setText('statusText', isConnected ? '已连接' : '未连接');
    setConnectButtonVisible(!isConnected);

    showMessage(isConnected ? `已连接到 ${wsUrl}` : `等待 PolarAgent 监听 ${wsUrl}`);
  } catch (error) {
    setStatusDot('warning');
    setText('statusText', '连接失败');
    setConnectButtonVisible(true);
    showMessage(`错误: ${error.message}`);
  }
}

async function reconnect() {
  const port = readPort();
  const button = document.getElementById('connectButton');
  if (button) button.disabled = true;
  try {
    await setPort(port);
    showMessage(`正在连接 ws://127.0.0.1:${port}`);
    await checkConnectionStatus();
  } finally {
    if (button) button.disabled = false;
  }
}

async function savePort() {
  const port = readPort();
  await setPort(port);
  showMessage(`已切换到 ws://127.0.0.1:${port}`);
  await checkConnectionStatus();
}

function readPort() {
  const input = document.getElementById('portInput');
  const port = Number(input?.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1-65535 的整数');
  }
  return port;
}

async function setPort(port) {
  const resp = await chrome.runtime.sendMessage({ cmd: 'setPort', port });
  if (!resp?.ok) throw new Error(resp?.error || '未知错误');
}

function setStatusDot(state) {
  const element = document.getElementById('statusIcon');
  if (!element || !element.classList) return;
  element.classList.remove('connected', 'warning');
  if (state) element.classList.add(state);
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function setConnectButtonVisible(visible) {
  const button = document.getElementById('connectButton');
  if (!button) return;
  button.disabled = false;
  button.textContent = '连接';
  button.style.display = visible ? '' : 'none';
}

function showMessage(message) {
  const el = document.getElementById('portMessage');
  if (el) el.textContent = message || '';
}
