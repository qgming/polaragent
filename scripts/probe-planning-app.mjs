import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Real Electron + preload/IPC + native documents, with a local deterministic model.
// Usage: node scripts/probe-planning-app.mjs [--packaged]
const packaged = process.argv.includes('--packaged');
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'oint-planning-probe-'));
const output = path.join(root, '.slim/deepwork');
await mkdir(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok, label) => { if (!ok) throw new Error(label); console.log('PASS ' + label); };
let stage = 0;
let executed = 0;
const model = createServer(async (req, res) => {
  try {
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    const main = input.tools?.some(tool => tool.function?.name === 'save_plan');
    let name, args, content = 'Planning fixture';
    if (main) {
      const last = [...input.messages].reverse().find(message => message.role === 'tool');
      let state; try { state = JSON.parse(last?.content); } catch { /* first request */ }
      const version = state?.work && { workId: state.work.workId, workRevision: state.work.revision };
      if (stage === 0) { name = 'read_workflow'; args = {}; }
      else if (stage === 1) { name = 'set_work_contract'; args = { ...version, resolvedInputIds: state.work.pendingInputIds, requirementsChanged: false }; }
      else if (stage === 2) { name = 'save_plan'; args = { ...version, title: 'Native plan probe', markdown: '# Native plan probe\n\nReview this exact version before execution.' }; }
      else if (stage === 3) { name = 'present_plan'; args = { ...version, planId: state.plan.id, revision: state.plan.revision }; }
      else if (stage === 4) content = 'Saved for your review.';
      else { executed++; content = 'Executed the approved plan version.'; }
      stage++;
    }
    const id = `probe-${stage}`;
    if (!input.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    chunk({ role: 'assistant', ...(name ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content }) });
    chunk({}, name ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelPort = model.address().port;
const debugPort = packaged ? 19672 : 19671;
const require = createRequire(import.meta.url);
const executable = packaged ? path.join(root, 'release/win-unpacked/Oint.exe') : require('electron');
const env = { ...process.env, OINT_HOME: path.join(temporary, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const child = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temporary, 'profile')}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = ''; child.stdout.on('data', chunk => { appLog += chunk; }); child.stderr.on('data', chunk => { appLog += chunk; });
let ws;
try {
  let page;
  for (let attempt = 0; attempt < 250; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(item => item.type === 'page' && !item.url.startsWith('devtools:')); if (page) break; } catch { /* startup */ }
    await sleep(200);
  }
  check(page, 'Electron renderer available');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); const call = pending.get(message.id); if (!call) return; pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed'); return result.result.value; };
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate('Boolean(window.oint && document.querySelector("textarea"))')) break; await sleep(100); }
  const session = await evaluate(`(async () => { const settings = await window.oint.settings.read(); await window.oint.settings.write({ ...settings, language: 'zh-CN', services: [{ id: 'fixture', name: 'Fixture', baseUrl: 'http://127.0.0.1:${modelPort}/v1', apiKey: 'local-fixture', wireFormat: 'openai-completions', models: [{id:'fixture'}] }], defaultModel: {serviceId:'fixture',modelId:'fixture'}, thinkingLevel:'off', permissionMode:'full', agentMode:'orchestrate', mcpServers:[] }); return window.oint.sessions.create({title:'Planning validation',cwd:${JSON.stringify(temporary)}}); })()`);
  await evaluate(`window.oint.chat.send(${JSON.stringify(session.id)}, 'Only prepare the plan for review', [], 'planning-probe', {work:{kind:'new',effects:'read-only',requiresReview:true}})`);
  let state = await evaluate(`window.oint.chat.snapshot(${JSON.stringify(session.id)})`);
  check(state.state.workflow.plan?.markdown.includes('exact version'), 'model tools saved native Markdown through real IPC');
  check(state.state.workflow.work.effects === 'read-only' && state.state.workflow.plan.status === 'ready', 'review leaves work read-only');
  await send('Page.reload');
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(`Boolean(document.querySelector('[data-slot="aui_thread-list-item-title"]'))`)) break; await sleep(100); }
  await evaluate(`document.querySelector('[data-slot="aui_thread-list-item-title"]').closest('button').click()`);
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(`Boolean(document.querySelector('button[aria-label="查看计划"]'))`)) break; await sleep(100); }
  check(await evaluate(`Boolean(document.querySelector('button[aria-label="开始计划"]'))`), 'real plan dock restored after renderer reload');
  await evaluate(`document.querySelector('button[aria-label="查看计划"]').click()`);
  await sleep(300);
  check(await evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('Review this exact version')`), 'real app displays native plan content');
  await evaluate(`document.getAnimations().forEach(animation=>animation.finish())`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, packaged ? 'planning-app-packaged.png' : 'planning-app-built.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('[role="dialog"] button[data-slot="dialog-close"]').click()`);
  await sleep(150);
  await evaluate(`document.querySelector('button[aria-label="开始计划"]').click()`);
  for (let attempt = 0; attempt < 100; attempt++) { state = await evaluate(`window.oint.chat.snapshot(${JSON.stringify(session.id)})`); if (state.state.workflow.execution?.status === 'admitted' && !state.state.running) break; await sleep(100); }
  check(state.state.workflow.execution?.status === 'admitted' && executed === 1, 'plan button admits exactly one native execution');
  check(state.state.workflow.execution.planRef.revision === 1 && state.state.workflow.execution.plan.markdown.includes('exact version'), 'execution receipt freezes selected content');
  const request = state.state.workflow.execution;
  const repeat = await evaluate(`window.oint.chat.startPlan(${JSON.stringify(session.id)}, ${JSON.stringify({ requestId: request.requestId, workId: request.workId, workRevision: request.workRevision, ...request.planRef })})`);
  check(repeat.ok && executed === 1, 'retry is idempotent across actual IPC');
  check((await evaluate('window.oint.sessions.list()'))[0].agentMode === null, 'plan execution does not mutate working-style preference');
  console.log(`PASS ${packaged ? 'packaged' : 'built'} application planning round trip`);
} finally {
  ws?.close(); child.kill(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await writeFile(path.join(output, packaged ? 'planning-app-packaged-process.log' : 'planning-app-built-process.log'), appLog);
}
