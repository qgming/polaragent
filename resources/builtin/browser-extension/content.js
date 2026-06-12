;(function(){ if (/streamlit/i.test(document.title)) return;
const TID = globalThis.__agent_browser_cli_TID || '__agent_browser_cli_bridge_26c9f1';
if (window.__agentBrowserCliCleanup) window.__agentBrowserCliCleanup();
if (window.__agentBrowserCliObserverCleanup) window.__agentBrowserCliObserverCleanup();
document.querySelectorAll('#agent-browser-cli-ind,#agent-browser-cli-style').forEach(e => e.remove());

// Remove meta CSP tags
document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(e => e.remove());

/**
 * Render a right-side floating badge that reflects the real bridge connection status.
 */
(function(){
  if(window.self!==window.top)return;
  const s=document.createElement('style');
  s.id='agent-browser-cli-style';
  s.textContent='#agent-browser-cli-ind{position:fixed;top:40%;right:0;display:flex;align-items:center;gap:10px;width:218px;height:36px;box-sizing:border-box;padding:0 8px 0 9px;color:white;border-radius:18px 0 0 18px;font-size:11px;font-weight:bold;line-height:36px;z-index:99999;cursor:grab;box-shadow:0 4px 12px rgba(0,0,0,0.22);background:#4CAF50;opacity:.72;overflow:visible;white-space:nowrap;user-select:none;transform:translateX(190px);transition:transform .18s ease,opacity .18s ease;}#agent-browser-cli-ind::after{content:"";position:absolute;inset:0;border-radius:18px 0 0 18px;background:#4CAF50;z-index:-1;}#agent-browser-cli-dot{flex:0 0 auto;width:10px;height:10px;border-radius:999px;background:white;}#agent-browser-cli-label{flex:0 0 auto;max-width:150px;overflow:hidden;}#agent-browser-cli-ind[data-expanded="1"]{opacity:.92;transform:translateX(0);}#agent-browser-cli-ind[data-dragging="1"]{cursor:grabbing;transition:none;}#agent-browser-cli-close{position:relative;flex:0 0 auto;width:20px;height:20px;border-radius:999px;line-height:18px;text-align:center;font-size:15px;font-weight:bold;background:#1f7a33;color:white;opacity:0;pointer-events:none;cursor:pointer;}#agent-browser-cli-ind[data-expanded="1"] #agent-browser-cli-close{opacity:1;pointer-events:auto;}#agent-browser-cli-close:hover{background:#145523;}#agent-browser-cli-close::after{content:"本次隐藏";position:absolute;right:0;bottom:28px;padding:4px 7px;border-radius:4px;background:#1f2937;color:white;font-size:12px;font-weight:500;line-height:16px;opacity:0;pointer-events:none;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease;}#agent-browser-cli-close:hover::after{opacity:1;transform:translateY(0);}';
  (document.head||document.documentElement).appendChild(s);
  const d=document.createElement('div');
  d.id='agent-browser-cli-ind';
  const dot=document.createElement('span');
  dot.id='agent-browser-cli-dot';
  const label=document.createElement('span');
  label.id='agent-browser-cli-label';
  label.textContent='agent_browser_cli: 已连接';
  const close=document.createElement('span');
  close.id='agent-browser-cli-close';
  close.textContent='×';
  d.appendChild(dot);
  d.appendChild(label);
  d.appendChild(close);
  let collapseTimer = null;
  let dragging = false;
  let moved = false;
  let dragOffsetY = 0;
  let dismissed = false;
  let wasConnected = false;
  let lastSeenCommandAt = 0;
  let lastTop = Math.round(window.innerHeight * 0.4);
  d.style.top = lastTop + 'px';
  /**
   * Show the badge only when the bridge is really connected.
   */
  function setBadgeState(connected, detail, lastCommandAt) {
    // 手动关闭只在当前连接周期生效；断开后下次重新连接会再次显示。
    if (connected && !wasConnected) dismissed = false;
    wasConnected = connected;
    const commandAt = Number(lastCommandAt) || 0;
    if (commandAt > lastSeenCommandAt) lastSeenCommandAt = commandAt;
    const activeRecently = lastSeenCommandAt > 0 && Date.now() - lastSeenCommandAt <= 10000;
    d.style.display = connected && !dismissed && activeRecently ? 'flex' : 'none';
    label.textContent = 'agent_browser_cli: 已连接';
    d.dataset.connected = connected ? '1' : '0';
    d.dataset.detail = detail || '';
  }
  function setExpanded(expanded) {
    d.dataset.expanded = expanded ? '1' : '0';
  }
  function clampTop(top) {
    return Math.max(8, Math.min(window.innerHeight - d.offsetHeight - 8, top));
  }
  /**
   * Poll background status and update the badge visibility.
   */
  async function refreshBadgeState() {
    try {
      const resp = await chrome.runtime.sendMessage({ cmd: 'status' });
      const connected = !!resp?.ok && !!resp?.data?.wsConnected;
      setBadgeState(connected, resp?.data?.wsUrl || '', resp?.data?.lastCommandAt);
    } catch (e) {
      setBadgeState(false, e.message || '', 0);
    }
  }
  d.addEventListener('mouseenter', () => {
    if (collapseTimer) clearTimeout(collapseTimer);
    setExpanded(true);
  });
  d.addEventListener('mouseleave', () => {
    if (collapseTimer) clearTimeout(collapseTimer);
    setExpanded(false);
  });
  d.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    dragOffsetY = e.clientY - d.getBoundingClientRect().top;
    d.dataset.dragging = '1';
    d.setPointerCapture(e.pointerId);
  });
  d.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nextTop = clampTop(e.clientY - dragOffsetY);
    if (Math.abs(nextTop - lastTop) > 2) moved = true;
    lastTop = nextTop;
    d.style.top = lastTop + 'px';
  });
  d.addEventListener('pointerup', (e) => {
    dragging = false;
    d.dataset.dragging = '0';
    try { d.releasePointerCapture(e.pointerId); } catch (_) {}
  });
  close.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissed = true;
    setExpanded(false);
    d.style.display = 'none';
  });
  window.addEventListener('resize', () => {
    lastTop = clampTop(lastTop);
    d.style.top = lastTop + 'px';
  });
  (document.body||document.documentElement).appendChild(d);
  setBadgeState(false, '');
  refreshBadgeState();
  const refreshTimer = setInterval(refreshBadgeState, 3000);
  window.__agentBrowserCliCleanup = () => {
    clearInterval(refreshTimer);
    d.remove();
    s.remove();
  };
})();

const agentBrowserCliObserver = new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.id === TID || (n.querySelector && n.querySelector('#' + TID))) {
      const el = n.id === TID ? n : n.querySelector('#' + TID);
      handle(el);
    }
  }
});
agentBrowserCliObserver.observe(document.documentElement, { childList: true, subtree: true });
window.__agentBrowserCliObserverCleanup = () => agentBrowserCliObserver.disconnect();

/**
 * Consume page-side bridge requests and forward them to the extension background worker.
 */
async function handle(el) {
  try {
    const req = el.textContent.trim() ? JSON.parse(el.textContent) : { cmd: 'cookies' };
    const cmd = req.cmd || 'cookies';
    let resp;
    if (cmd === 'cookies') {
      resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: req.url || location.href });
    } else if (cmd === 'cdp') {
      resp = await chrome.runtime.sendMessage({ cmd: 'cdp', method: req.method, params: req.params || {}, tabId: req.tabId, allowFocus: req.allowFocus });
    } else if (cmd === 'batch') {
      resp = await chrome.runtime.sendMessage({ cmd: 'batch', commands: req.commands, tabId: req.tabId });
    } else if (cmd === 'tabs') {
      resp = await chrome.runtime.sendMessage({ cmd: 'tabs', method: req.method, tabId: req.tabId, allowFocus: req.allowFocus });
    } else if (cmd === 'openTab') {
      resp = await chrome.runtime.sendMessage({ cmd: 'openTab', url: req.url, active: req.active, allowFocus: req.allowFocus, groupTitle: req.groupTitle });
    } else if (cmd === 'closeTab') {
      resp = await chrome.runtime.sendMessage({ cmd: 'closeTab', tabId: req.tabId });
    } else if (cmd === 'networkStart' || cmd === 'networkList' || cmd === 'networkDetail' || cmd === 'networkClear' || cmd === 'networkStop' || cmd === 'consoleStart' || cmd === 'consoleList' || cmd === 'consoleClear' || cmd === 'consoleStop' || cmd === 'debugClearAll') {
      resp = await chrome.runtime.sendMessage(Object.assign({}, req, { cmd }));
    } else {
      resp = { ok: false, error: 'unknown cmd: ' + cmd };
    }
    el.textContent = JSON.stringify(resp);
  } catch (e) {
    el.textContent = JSON.stringify({ ok: false, error: e.message });
  }
}
})();
