import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, _electron } from 'playwright';
import { createRequire } from 'node:module';
import { createIsolatedE2EHome } from './e2e-env.mjs';
import { startIsolatedVisualRuntime } from './codia-qa-runtime.mjs';

const root = process.cwd();
const desktop = process.argv.includes('--desktop');
const out = path.join(root, 'artifacts', desktop ? 'quick-action-review-desktop' : 'quick-action-review');
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [], screenshots: [], measurements: [], navigation: [] };
const runtime = await startIsolatedVisualRuntime(root, { responseFactory: async ({ body }) => {
  const last = JSON.stringify(body.messages?.filter(m => m.role === 'user').at(-1)?.content || '');
  if (last.includes('Workflow description:')) return { reply: last.includes('INVALID_TEMPLATE') ? 'invalid template' : JSON.stringify({
    title: '周报模板', nodes: [{ id: 'collect', title: '收集进展', prompt: '收集本周进展', agentId: '' }, { id: 'summarize', title: '生成周报', prompt: '汇总并复核周报', agentId: '' }], edges: [{ from: 'collect', to: 'summarize' }],
  }) };
  if (last.includes('你是受邀的独立审阅助手')) {
    if (last.includes('CANCEL_REVIEW')) await new Promise(resolve => setTimeout(resolve, 3000));
    if (last.includes('FAIL_REVIEW')) return { reply: '' };
    return { reply: 'MOCK_REVIEW_FINDINGS：建议增加边界检查。' };
  }
  if (last.includes('以下是辅助助手提供的参考意见')) return { reply: 'MOCK_AUTHOR_ANSWER：已结合独立审阅意见完成。' };
  if (last.includes('请整理用户提供的想法')) return { reply: 'MOCK_IDEAS_PLAN：整理目标与下一步。' };
  if (last.includes('请结合当前工作空间协作完成编程任务')) return { reply: 'MOCK_CODE_PLAN：已读取编程协作任务。' };
  return { reply: 'MOCK_LOCAL_REPLY' };
} });
let browser;
let electron;
let desktopLogs = '';
let page;
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
try {
  let context;
  if (desktop) {
    const desktopHome = createIsolatedE2EHome({ mockBaseUrl: runtime.mock.baseUrl });
    fs.copyFileSync(path.join(runtime.home, 'agents/gsap/config.yaml'), path.join(desktopHome, 'agents/gsap/config.yaml'));
    const env = { ...process.env, GSAP_HOME: desktopHome, GSAP_DEV_HOME: desktopHome, GSAP_E2E: '1', GSAP_PORT: '0', GSAP_LAUNCH_NODE: process.execPath, GSAP_DESKTOP_SERVER_MODE: 'source', VITE_DEV_URL: runtime.baseUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.', '--dev'], cwd: root, env, timeout: 60000 });
    for (const stream of [electron.process().stdout, electron.process().stderr]) stream?.on('data', data => { desktopLogs += String(data); });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      page = electron.windows().find(window => window.url().includes('/index.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!page) throw new Error('Electron main window did not open');
    context = page.context();
    await page.setViewportSize({ width: 1440, height: 900 });
    report.desktopProfile = desktopHome;
  } else {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  }
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/sessions/switch')) report.navigation.push({ at: Date.now(), body: request.postData() });
  });
  if (!desktop) await page.goto(`${runtime.baseUrl}/index.html`);
  await page.waitForFunction(() => document.querySelector('.pwa-login-card input') || document.querySelector('[aria-label="Codia 小豆蔻"]'));
  if (await page.locator('.pwa-login-card input').count()) {
    await page.locator('.pwa-login-card input').fill(runtime.token);
    await page.locator('.pwa-login-card button[type="submit"]').click();
  }
  await page.locator('[aria-label="Codia 小豆蔻"]').waitFor();
  await page.evaluate(async () => {
    const { useStore } = await import('/react/stores/index.ts');
    window.__reviewNavigation = [];
    useStore.subscribe((state, previous) => {
      if (state.currentSessionPath !== previous.currentSessionPath) window.__reviewNavigation.push({ at: Date.now(), path: state.currentSessionPath, pending: state.pendingNewSession, stack: new Error().stack });
    });
  });
  await page.evaluate(async () => {
    const { gsapFetch } = await import('/react/hooks/use-gsap-fetch.ts');
    const { loadAgents } = await import('/react/stores/agent-actions.ts');
    const response = await gsapFetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'review-helper', name: '审阅伙伴', yuan: 'gsap' }) });
    if (!response.ok) throw new Error(await response.text());
    await loadAgents();
  });
  const editor = () => page.locator('.input-area:not(.hidden) .tiptap').first();
  const send = () => page.locator('.input-area:not(.hidden) button[class*="send-btn"]').click();
  const fresh = async () => {
    await page.evaluate(async () => {
      const { switchTab } = await import('/react/components/channels/tab-router.ts');
      const { createNewSession } = await import('/react/stores/session-actions.ts');
      const { useStore } = await import('/react/stores/index.ts');
      switchTab('chat'); useStore.setState({ selectedAgentId: 'gsap' }); await createNewSession();
    });
    await page.locator('[aria-label="Codia 小豆蔻"]').waitFor();
  };
  const screenshot = async name => { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file); };
  const choose = async label => { await page.getByRole('button', { name: new RegExp(label) }).first().click(); };
  for (const [id, label] of [['ideas', '整理我的想法'], ['code', '开始编程协作'], ['workflow', '搭建一个工作流'], ['agents', '问问我的 Agent']]) {
    await fresh(); await choose(label);
    await editor().locator(`[data-quick-action="${id}"]`).waitFor();
    assert.ok((await editor().innerText()).length < 40, 'quick action must not expand into prose');
    if (id === 'agents') {
      const menu = page.getByRole('dialog', { name: '引用内容' });
      await menu.waitFor();
      assert.equal(await menu.getByRole('tab', { name: '助手', exact: true }).getAttribute('aria-selected'), 'true');
      await menu.getByRole('option', { name: /审阅伙伴/ }).click();
      assert.equal(await page.evaluate(async () => ((s) => s.selectedAgentId || s.currentAgentId)((await import('/react/stores/index.ts')).useStore.getState())), 'gsap');
    }
    await editor().click(); await page.keyboard.press('End');
    await page.keyboard.insertText(`SMOKE_${id}：${id === 'workflow' ? '收集进展后生成周报' : '请完成当前任务'}`);
    await screenshot(`${id}-badge`);
    await send();
    if (id === 'workflow') {
      const preview = page.locator('[data-workflow-template-preview="true"]');
      await preview.waitFor({ timeout: 45000 });
      await screenshot('workflow-preview');
      await page.getByRole('button', { name: '确认应用', exact: true }).click();
      await page.getByRole('dialog', { name: '生成工作流模板' }).waitFor({ state: 'hidden' });
      assert.ok(await page.getByText('收集进展', { exact: true }).count());
    } else {
      const marker = id === 'ideas' ? 'MOCK_IDEAS_PLAN' : id === 'code' ? 'MOCK_CODE_PLAN' : 'MOCK_AUTHOR_ANSWER';
      await page.getByText(new RegExp(marker)).first().waitFor({ timeout: 60000 });
      if (id === 'agents') await page.getByText('审阅伙伴 · 协作完成', { exact: true }).waitFor();
      const history = await page.evaluate(async () => {
        const { useStore } = await import('/react/stores/index.ts');
        const { gsapFetch } = await import('/react/hooks/use-gsap-fetch.ts');
        const path = useStore.getState().currentSessionPath;
        return (await gsapFetch(`/api/sessions/messages?path=${encodeURIComponent(path)}`)).json();
      });
      const users = history.messages.filter(m => m.role === 'user');
      assert.equal(users.length, 1, 'one user bubble for a review round');
      assert.equal(users[0].quickAction, id);
      assert.ok(!users[0].content.includes('以下是辅助助手') && !users[0].content.includes('请整理用户提供的想法'));
      if (id === 'agents') {
        assert.equal(users[0].agentReview.status, 'completed');
        const reviewerId = users[0].agentReview.reviewerSessionId;
        assert.ok(reviewerId);
        await page.getByRole('button', { name: '打开审阅对话' }).click();
        await page.getByRole('button', { name: '返回原对话' }).waitFor();
        await page.getByRole('button', { name: '返回原对话' }).click();
        await page.getByText('审阅伙伴 · 协作完成', { exact: true }).waitFor();
      }
      await screenshot(`${id}-result`);
    }
    check(`${id}: compact badge → real dispatch → result/history`);
  }
  for (const [task, status] of [['FAIL_REVIEW', '审阅失败'], ['CANCEL_REVIEW', '已取消']]) {
    await fresh(); await choose('问问我的 Agent');
    await page.getByRole('dialog', { name: '引用内容' }).getByRole('option', { name: /审阅伙伴/ }).click();
    await editor().click(); await page.keyboard.press('End'); await page.keyboard.insertText(task);
    await send();
    if (task === 'CANCEL_REVIEW') {
      await page.getByText('审阅伙伴 · 正在独立审阅', { exact: true }).waitFor();
      await page.locator('.input-area:not(.hidden) button[class*="send-btn"]').filter({ hasText: '停止' }).click();
    }
    await page.getByText(`审阅伙伴 · ${status}`, { exact: true }).waitFor({ timeout: 45000 });
    assert.equal(await page.locator('[data-message-id]:visible').filter({ hasText: 'MOCK_AUTHOR_ANSWER' }).count(), 0);
    await page.evaluate(async () => {
      const { useStore } = await import('/react/stores/index.ts');
      const { loadMessages } = await import('/react/stores/session-actions.ts');
      await loadMessages(useStore.getState().currentSessionPath);
    });
    await page.getByText(`审阅伙伴 · ${status}`, { exact: true }).waitFor();
    await screenshot(task.toLowerCase()); check(`${task}: terminal state without late author call`);
  }
  await fresh(); await choose('搭建一个工作流');
  await editor().click(); await page.keyboard.press('End'); await page.keyboard.insertText('INVALID_TEMPLATE'); await send();
  const generator = page.getByRole('dialog', { name: '生成工作流模板' });
  await generator.getByRole('alert').waitFor({ timeout: 45000 });
  await generator.getByRole('button', { name: '关闭模板生成器' }).click();
  assert.ok(await page.getByText('收集进展', { exact: true }).count());
  check('invalid generated template preserves existing canvas');
  await fresh(); await choose('整理我的想法');
  await editor().click(); await page.keyboard.press('End'); await page.keyboard.insertText('保留我的输入'); await choose('开始编程协作');
  assert.ok((await editor().innerText()).includes('保留我的输入'));
  assert.equal(await editor().locator('[data-quick-action]').count(), 1);
  check('switching task badge preserves user text');
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1152, height: 720, deviceScaleFactor: 1.25 }]) {
    await page.setViewportSize(size); await fresh(); await choose('整理我的想法');
    if (size.deviceScaleFactor) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, mobile: false });
    }
    const rect = await editor().boundingBox();
    const button = await page.locator('.input-area:not(.hidden) button[class*="send-btn"]').boundingBox();
    assert.ok(rect && button && rect.y >= 0 && button.y + button.height <= size.height);
    report.measurements.push({ size, editor: rect, send: button }); await screenshot(`layout-${size.width}`);
  }
  check('three viewport layouts keep badges/editor/send visible');
  assert.deepEqual(report.errors, []);
  assert.ok(runtime.mock.requests.every(r => r.model.startsWith('e2e-')));
} catch (error) {
  report.failure = error.stack;
    if (page) { report.stateNavigation = await page.evaluate(() => window.__reviewNavigation).catch(() => []); await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(out, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  report.mockRequests = runtime.mock.requests.length;
  report.mockModels = [...new Set(runtime.mock.requests.map(request => request.model))];
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'runtime.log'), runtime.logs());
  if (desktop) fs.writeFileSync(path.join(out, 'desktop.log'), desktopLogs);
  fs.writeFileSync(path.join(out, 'mock-requests.json'), JSON.stringify(runtime.mock.requests, null, 2));
  await electron?.close(); await browser?.close(); await runtime.close();
}

