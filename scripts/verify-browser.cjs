const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { verifyMonitor } = require('./verify-monitor.cjs');

const extensionPath = path.resolve(__dirname, '..');
const artifactPath = process.env.QA_OUTPUT || path.join(extensionPath, 'artifacts');
fs.mkdirSync(artifactPath, { recursive: true });
const results = [];
const errors = [];
const server = http.createServer((request, response) => {
  const title = request.url.startsWith('/beta') ? '网页 B' : '网页 A';
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url.startsWith('/monitor-fixture')) {
    const value = new URL(request.url, 'http://localhost').searchParams.get('initial') === 'B' ? '发布完成' : '发布中';
    response.end(`<!doctype html><meta charset="utf-8"><title>发布状态演示</title><style>body{font:16px sans-serif;padding:70px 30px} #release{padding:14px;width:240px;border:1px solid #ccc}</style>
      <h1>演示发布任务</h1><div id="release"><span id="release-status">${value}</span></div><p id="other">其他内容</p>`);
    return;
  }
  if (request.url.startsWith('/csp')) response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'");
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>标签定名 · 浏览器验收页面</p><a href="/beta">下一个页面</a></body></html>`;
  if (request.url === '/slow') {
    response.write('<!doctype html><html><head><meta charset="utf-8">');
    setTimeout(() => response.end('<title>延迟网页标题</title></head><body>延迟加载</body></html>'), 350);
  } else {
    response.end(body);
  }
});

async function eventually(operation, expected, timeout = 7000) {
  const start = Date.now();
  let actual;
  let lastError;
  do {
    try {
      actual = await operation();
      if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 60));
  } while (Date.now() - start < timeout);
  assert.deepEqual(actual, expected, lastError);
}

async function check(name, operation) {
  const start = Date.now();
  try {
    await operation();
    results.push({ name, result: 'PASS', milliseconds: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, result: 'FAIL', error: error.message });
    console.error(`FAIL ${name}: ${error.stack}`);
    throw error;
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const otherOrigin = `http://localhost:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-name-lock-qa-'));
  let context;
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run']
  });
  try {
    context = await launch();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const extensionId = new URL(worker.url()).host;
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(`${base}/alpha`);
    await second.goto(`${base}/alpha`);
    const getTabId = async (page) => {
      const session = await context.newCDPSession(page);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.detach();
      return worker.evaluate(targetId => chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.id === Number(targetId))?.id), targetInfo.targetId).then(async id => {
        if (id) return id;
        await page.bringToFront();
        return worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
      });
    };
    const firstId = await getTabId(first);
    const secondId = await getTabId(second);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await first.bringToFront();
    await popup.reload();
    await popup.locator('#name').waitFor({ state: 'visible' });
    await eventually(() => popup.locator('#name').isEnabled(), true);
    // Use a persistent extension page for control APIs, so worker suspension does not invalidate the test driver.
    worker = { evaluate: (...args) => popup.evaluate(...args) };
    const send = (type, tabId, title) => popup.evaluate(async message => {
      const response = await chrome.runtime.sendMessage(message);
      if (!response.ok) throw new Error(response.error);
      return response;
    }, { type, tabId, title });
    const name = (tabId, title) => send('SAVE_NAME', tabId, title);
    const title = (page) => page.title();
    const chromeTitle = tabId => worker.evaluate(async id => (await chrome.tabs.get(id)).title, tabId);

    const reopenPopup = async () => {
      await first.bringToFront();
      await popup.reload();
      await eventually(() => popup.locator('#name').isEnabled(), true);
    };
    await check('选择 Emoji 前缀并保存到原生标签标题', async () => {
      await popup.locator('#name').fill('生产环境 · 订单');
      await popup.locator('#emojiToggle').click();
      await popup.getByRole('button', { name: '🚀 火箭', exact: true }).click();
      assert.equal(await popup.locator('#emojiToggle').textContent(), '🚀');
      assert.equal(await popup.locator('#name').inputValue(), '生产环境 · 订单');
      assert.equal(await popup.locator('#preview, #site, .tab-preview').count(), 0);
      await popup.locator('#save').click();
      await eventually(() => chromeTitle(firstId), '🚀 生产环境 · 订单');
      assert.equal(await title(second), '网页 A');
      await reopenPopup();
      assert.equal(await popup.locator('#name').inputValue(), '生产环境 · 订单');
      assert.equal(await popup.locator('#emojiToggle').textContent(), '🚀');
      await popup.setViewportSize({ width: 344, height: 580 });
      await popup.locator('#emojiToggle').click();
      await popup.locator('main').screenshot({ path: path.join(artifactPath, 'emoji-picker-light.png') });
      await popup.emulateMedia({ colorScheme: 'dark' });
      await popup.locator('main').screenshot({ path: path.join(artifactPath, 'emoji-picker-dark.png') });
      await popup.emulateMedia({ colorScheme: 'light' });
      await popup.locator('#emojiToggle').click();
    });

    await check('简化弹窗及全部 96 个 Emoji 完整可达', async () => {
      assert.equal(await popup.locator('header p, footer, .tab-preview').count(), 0);
      const collapsedHeight = await popup.locator('main').evaluate(element => element.getBoundingClientRect().height);
      assert.ok(collapsedHeight < 285, `Collapsed popup is ${collapsedHeight}px tall`);
      await popup.locator('#emojiToggle').click();
      assert.equal(await popup.locator('.emoji-option').count(), 96);
      const layout = await popup.evaluate(() => {
        const main = document.querySelector('main').getBoundingClientRect();
        const grid = document.getElementById('emojiGrid');
        const bounds = grid.getBoundingClientRect();
        const buttons = [...grid.children].map(button => button.getBoundingClientRect());
        return { height: main.height, horizontalOverflow: grid.scrollWidth > grid.clientWidth, scrollable: grid.scrollHeight > grid.clientHeight,
          smallestWidth: Math.min(...buttons.map(button => button.width)), smallestHeight: Math.min(...buttons.map(button => button.height)),
          allFit: buttons.every(button => button.left >= bounds.left && button.right <= bounds.right) };
      });
      assert.ok(layout.height <= 580, JSON.stringify(layout));
      assert.ok(!layout.horizontalOverflow && layout.scrollable && layout.allFit, JSON.stringify(layout));
      assert.ok(layout.smallestWidth >= 38 && layout.smallestHeight >= 40, JSON.stringify(layout));
      const last = popup.getByRole('button', { name: '🍺 啤酒', exact: true });
      await last.scrollIntoViewIfNeeded();
      const visible = await last.evaluate(button => {
        const item = button.getBoundingClientRect();
        const viewport = button.parentElement.getBoundingClientRect();
        return item.top >= viewport.top && item.bottom <= viewport.bottom;
      });
      assert.ok(visible, 'Last emoji must fit entirely inside its scroll area');
      await popup.locator('main').screenshot({ path: path.join(artifactPath, 'emoji-picker-bottom.png') });
      await last.click();
      await popup.locator('#save').click();
      await eventually(() => title(first), '🍺 生产环境 · 订单');
      await reopenPopup();
      await popup.locator('#emojiToggle').click();
      assert.equal(await popup.getByRole('button', { name: '🍺 啤酒', exact: true }).getAttribute('aria-pressed'), 'true');
      await popup.getByRole('button', { name: '🚀 火箭', exact: true }).click();
      await popup.locator('#save').click();
      await eventually(() => title(first), '🚀 生产环境 · 订单');
    });

    await check('替换前缀不重复，刷新与换网址保留 Emoji', async () => {
      await popup.locator('#emojiToggle').click();
      await popup.getByRole('button', { name: '🟢 绿色圆点', exact: true }).click();
      await popup.locator('#save').click();
      await eventually(() => title(first), '🟢 生产环境 · 订单');
      await first.reload();
      await eventually(() => title(first), '🟢 生产环境 · 订单');
      await first.goto(`${otherOrigin}/beta`);
      await eventually(() => title(first), '🟢 生产环境 · 订单');
    });

    await check('自定义组合 Emoji、肤色、国旗与键帽完整保存', async () => {
      for (const emoji of ['👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣']) {
        await popup.locator('#emojiToggle').click();
        await popup.locator('#emojiCustom').fill(emoji);
        await popup.locator('#emojiCustom').press('Enter');
        await popup.locator('#save').click();
        await eventually(() => title(first), `${emoji} 生产环境 · 订单`);
        await reopenPopup();
        assert.equal(await popup.locator('#emojiToggle').textContent(), emoji);
        assert.equal(await popup.locator('#name').inputValue(), '生产环境 · 订单');
      }
    });

    await check('无效输入不会覆盖现有 Emoji 或标签名称', async () => {
      for (const input of ['abc', '🚀🔥', '']) {
        await popup.locator('#emojiToggle').click();
        await popup.locator('#emojiCustom').fill(input);
        await popup.locator('#emojiApply').click();
        assert.match(await popup.locator('#status').textContent(), /一个完整的 Emoji/);
        assert.equal(await popup.locator('#emojiToggle').textContent(), '1️⃣');
        assert.equal(await title(first), '1️⃣ 生产环境 · 订单');
        await popup.locator('#emojiCustom').press('Escape');
      }
    });

    await check('移除前缀保留文字，恢复原标题同时清除 Emoji', async () => {
      await popup.locator('#emojiToggle').click();
      await popup.locator('#emojiClear').click();
      assert.equal(await popup.locator('#name').inputValue(), '生产环境 · 订单');
      await popup.locator('#save').click();
      await eventually(() => title(first), '生产环境 · 订单');
      await popup.locator('#emojiToggle').click();
      await popup.getByRole('button', { name: '🚀 火箭', exact: true }).click();
      await popup.locator('#save').click();
      await eventually(() => title(first), '🚀 生产环境 · 订单');
      await popup.locator('#reset').click();
      await eventually(() => title(first), '网页 B');
      await eventually(() => popup.locator('#emojiToggle').textContent(), '表情');
    });

    await check('旧版前缀名称重新编辑时不会重复添加表情', async () => {
      await worker.evaluate(id => chrome.storage.session.set({ [`tab-name:${id}`]: { title: '🚀 旧版名称' } }), firstId);
      await reopenPopup();
      assert.equal(await popup.locator('#name').inputValue(), '旧版名称');
      assert.equal(await popup.locator('#emojiToggle').textContent(), '🚀');
      await popup.locator('#save').click();
      await eventually(() => title(first), '🚀 旧版名称');
      await popup.locator('#reset').click();
      await eventually(() => title(first), '网页 B');
      await eventually(() => popup.locator('#emojiToggle').textContent(), '表情');
    });

    await check('真实弹窗保存中文名称与 Emoji', async () => {
      await popup.locator('#name').fill('生产环境 · 订单 🟢');
      await popup.locator('#save').click();
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await eventually(() => chromeTitle(firstId), '生产环境 · 订单 🟢');
      await popup.locator('#status').filter({ hasText: '已保存' }).waitFor();
      await popup.setViewportSize({ width: 344, height: 580 });
      await popup.locator('main').screenshot({ path: path.join(artifactPath, 'popup-light.png') });
      await popup.emulateMedia({ colorScheme: 'dark' });
      await popup.locator('main').screenshot({ path: path.join(artifactPath, 'popup-dark.png') });
    });

    await check('同网址两个标签页互不影响', async () => {
      assert.equal(await title(second), '网页 A');
      await name(secondId, '测试环境');
      await eventually(() => title(second), '测试环境');
      assert.equal(await title(first), '生产环境 · 订单 🟢');
    });

    await check('刷新与跨域换网址保持定名', async () => {
      await first.reload();
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await first.goto(`${otherOrigin}/beta`);
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      assert.equal(await title(second), '测试环境');
    });

    await check('网页反复改标题、SPA 路由、替换 title/head', async () => {
      await first.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          document.title = `通知 (${i})`;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        history.pushState({}, '', '/spa-route');
        document.querySelector('title').textContent = 'SPA 标题';
      });
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await first.evaluate(() => {
        document.head.innerHTML = '<title>被整体替换的标题</title>';
      });
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await first.evaluate(() => document.head.remove());
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await first.evaluate(() => {
        const head = document.createElement('head');
        head.innerHTML = '<title>新 head</title>';
        document.head.replaceWith(head);
      });
      await eventually(() => title(first), '生产环境 · 订单 🟢');
    });

    await check('慢加载与严格 CSP 网页', async () => {
      await first.goto(`${base}/slow`);
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await first.goto(`${base}/csp`);
      await eventually(() => title(first), '生产环境 · 订单 🟢');
    });

    await check('前进后退恢复缓存仍保留名称', async () => {
      await first.goto(`${base}/alpha?history=1`);
      await first.goto(`${base}/beta?history=2`);
      await first.goBack();
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await first.goForward();
      await eventually(() => title(first), '生产环境 · 订单 🟢');
    });

    await check('扩展后台停止后重新唤醒，名称仍在', async () => {
      const cdp = await context.newCDPSession(popup);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach();
      await first.reload();
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await name(secondId, '后台唤醒后');
      await eventually(() => title(second), '后台唤醒后');
      await name(secondId, '测试环境');
    });

    await check('在后台修改名称、恢复最新网页原标题', async () => {
      await first.evaluate(() => { document.title = '最新业务标题'; });
      await eventually(() => title(first), '生产环境 · 订单 🟢');
      await name(firstId, '新的名称');
      await eventually(() => title(first), '新的名称');
      await send('CLEAR_NAME', firstId);
      await eventually(() => title(first), '最新业务标题');
      await first.evaluate(() => { document.title = '恢复后可正常改标题'; });
      assert.equal(await title(first), '恢复后可正常改标题');
      await name(firstId, '窗口 A 独立名称');
    });

    let secondWindow;
    await check('跨浏览器窗口同网址隔离与拖动标签页', async () => {
      secondWindow = await worker.evaluate(url => chrome.windows.create({ url, type: 'normal' }), `${base}/alpha`);
      const tabId = secondWindow.tabs[0].id;
      await name(tabId, '窗口 B 独立名称');
      await eventually(() => chromeTitle(tabId), '窗口 B 独立名称');
      await worker.evaluate(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), { tabId: firstId, windowId: secondWindow.id });
      await eventually(() => chromeTitle(firstId), '窗口 A 独立名称');
      await eventually(() => chromeTitle(tabId), '窗口 B 独立名称');
      assert.equal(await title(second), '测试环境');
    });

    await check('复制标签页不继承名称', async () => {
      const duplicated = await worker.evaluate(id => chrome.tabs.duplicate(id), firstId);
      await eventually(() => chromeTitle(duplicated.id), '网页 B');
      const record = await worker.evaluate(async id => (await chrome.storage.session.get(`tab-name:${id}`))[`tab-name:${id}`] || null, duplicated.id);
      assert.equal(record, null);
      await worker.evaluate(id => chrome.tabs.remove(id), duplicated.id);
    });

    await check('Chrome 受保护页保留记录，返回普通网页自动恢复', async () => {
      await worker.evaluate(id => chrome.tabs.update(id, { url: 'chrome://version/' }), firstId);
      await eventually(async () => (await send('INSPECT_TAB', firstId)).supported, false);
      assert.equal((await send('INSPECT_TAB', firstId)).title, '窗口 A 独立名称');
      await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: firstId, url: `${base}/alpha` });
      await eventually(() => chromeTitle(firstId), '窗口 A 独立名称');
    });

    if (process.env.RUN_DISCARD_CHECK === '1') await check('休眠/丢弃标签页恢复后保留名称', async () => {
      const active = await worker.evaluate(id => chrome.tabs.create({ windowId: id, url: 'about:blank', active: true }), secondWindow.id);
      await worker.evaluate(id => chrome.tabs.discard(id), firstId);
      await eventually(async () => (await worker.evaluate(id => chrome.tabs.get(id), firstId)).discarded, true);
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), firstId);
      await eventually(() => chromeTitle(firstId), '窗口 A 独立名称');
      await worker.evaluate(id => chrome.tabs.remove(id), active.id);
    });
    else results.push({ name: '休眠/丢弃标签页恢复后保留名称', result: 'SKIP', reason: 'Chromium 151 macOS 无头模式强制丢弃跨窗口标签页会崩溃，已用最小空扩展复现；可设置 RUN_DISCARD_CHECK=1 单独启用。' });

    await check('快速连续保存、清除，以最后操作为准', async () => {
      await Promise.all(Array.from({ length: 12 }, (_, index) => name(secondId, `连续命名 ${index}`)));
      await name(secondId, '最后的名称');
      await eventually(() => title(second), '最后的名称');
      await send('CLEAR_NAME', secondId);
      await eventually(() => title(second), '网页 A');
      await name(secondId, '待关闭的名称');
    });

    await check('关闭后记录清除，同网址新标签页不继承', async () => {
      await second.close();
      await eventually(() => worker.evaluate(async id => (await chrome.storage.session.get(`tab-name:${id}`))[`tab-name:${id}`] || null, secondId), null);
      const reopened = await context.newPage();
      await reopened.goto(`${base}/alpha`);
      assert.equal(await title(reopened), '网页 A');
    });

    await check('整个窗口关闭后清理其中所有名称', async () => {
      const ids = (await worker.evaluate(id => chrome.tabs.query({ windowId: id }), secondWindow.id)).map(tab => tab.id);
      await worker.evaluate(id => chrome.windows.remove(id), secondWindow.id);
      await eventually(() => worker.evaluate(async ids => {
        const store = await chrome.storage.session.get(null);
        return ids.some(id => Boolean(store[`tab-name:${id}`]));
      }, ids), false);
    });

    await verifyMonitor({ context, popup, base, extensionId, artifactPath, check, eventually });

    await check('浏览器重启清除标签规则，但保留本机 Bark 配置', async () => {
      const remaining = await context.newPage();
      await remaining.goto(`${base}/alpha?restart`);
      const id = await getTabId(remaining);
      await name(id, '不应留到下次');
      const barkConfig = { url: 'https://push.example.test/restart-key', enabled: false };
      assert.equal((await popup.evaluate(config => chrome.runtime.sendMessage({ type: 'BARK_SAVE', ...config }), barkConfig)).ok, true);
      await context.close();
      context = await launch();
      const nextWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      assert.deepEqual(await nextWorker.evaluate(() => chrome.storage.session.get(null)), {});
      assert.deepEqual(await nextWorker.evaluate(async () => (await chrome.storage.local.get('bark-notification-config'))['bark-notification-config']), barkConfig);
      const page = await context.newPage();
      await page.goto(`${base}/alpha?restart`);
      assert.equal(await title(page), '网页 A');
    });
    console.log(JSON.stringify({ passed: results.filter(item => item.result === 'PASS').length, skipped: results.filter(item => item.result === 'SKIP').length, errors }));
  } finally {
    fs.writeFileSync(path.join(artifactPath, 'browser-verification.json'), JSON.stringify({ date: new Date().toISOString(), results, errors }, null, 2));
    if (context) await context.close().catch(() => {});
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
