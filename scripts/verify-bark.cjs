const assert = require('node:assert/strict');
const path = require('node:path');

// Real extension UI and messaging; only the outbound service is replaced, so no personal Bark device is needed.
exports.verifyBark = async ({ popup, page, tabId, artifactPath, check, eventually, request, read, count, set, pick, save, service }) => {
  const url = 'https://push.example.test/test-device-key';
  const config = async () => (await request('BARK_READ')).config;
  const calls = () => service.evaluate(() => globalThis.barkCalls);
  const notices = () => service.evaluate(() => globalThis.monitorNotices.length);
  await service.evaluate(() => {
    globalThis.barkOriginalFetch = globalThis.fetch;
    globalThis.barkCalls = [];
    globalThis.barkMode = 'ok';
    globalThis.fetch = async (url, options) => {
      globalThis.barkCalls.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body), credentials: options.credentials, redirect: options.redirect });
      if (globalThis.barkMode === 'network') throw new Error(`Network failure with secret ${url}`);
      if (globalThis.barkMode === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(`Timeout ${url}`)), { once: true }));
      if (globalThis.barkMode === 'http') return new Response('private response', { status: 503 });
      if (globalThis.barkMode === 'invalid') return new Response('not json', { status: 200 });
      return Response.json({ code: globalThis.barkMode === 'rejected' ? 400 : 200, message: `Do not display ${url}` });
    };
  });
  try {
    await check('Bark：设置默认隐藏，校验链接，保存并遮蔽设备 Key', async () => {
      await page.bringToFront(); await popup.reload();
      assert.equal(await popup.locator('#settingsView').isVisible(), false);
      await popup.locator('#settingsToggle').click();
      await eventually(() => popup.locator('#barkUrl').isEnabled(), true);
      assert.equal(await popup.locator('#homeView').isVisible(), false);
      assert.equal(await popup.locator('#barkUrl').getAttribute('type'), 'password');
      for (const invalid of ['http://push.example.test/key', 'https://api.day.app/push', 'https://api.day.app/key/body', 'https://user:pass@push.example.test/key', 'https://push.example.test/key?url=private']) {
        await popup.locator('#barkUrl').fill(invalid);
        await popup.locator('#barkSave').click();
        await eventually(() => popup.locator('#barkStatus').getAttribute('class'), 'status error');
        assert.equal((await config()).url, '');
        assert.equal((await calls()).length, 0);
      }
      await popup.locator('#barkUrl').fill(`  "${url}"  `);
      await popup.locator('#barkSave').click();
      await eventually(async () => (await config()).url, url);
      assert.deepEqual(await config(), { url, enabled: true });
      await eventually(() => popup.locator('#barkUrl').isEnabled(), true);
      await popup.locator('#barkReveal').click();
      assert.equal(await popup.locator('#barkUrl').getAttribute('type'), 'text');
      await popup.locator('#settingsToggle').click();
      await popup.locator('#settingsToggle').click();
      assert.equal(await popup.locator('#barkUrl').getAttribute('type'), 'password');
      await page.bringToFront(); await popup.reload(); await popup.locator('#settingsToggle').click();
      await eventually(() => popup.locator('#barkUrl').inputValue(), url);
      assert.equal((await request('BARK_READ', { tabId: null })).config.url, url);
      await popup.setViewportSize({ width: 344, height: 580 });
      for (const scheme of ['light', 'dark']) {
        await popup.emulateMedia({ colorScheme: scheme });
        await popup.locator('main').screenshot({ path: path.join(artifactPath, `bark-settings-${scheme}.png`) });
        const bounds = await popup.locator('main').boundingBox();
        assert.ok(bounds.height <= 580 && bounds.width === 344);
      }
      await popup.emulateMedia({ colorScheme: 'light' });
    });

    await check('Bark：测试使用 JSON POST，不保存草稿或传网页地址', async () => {
      const draft = `${url}-draft`;
      await popup.locator('#barkUrl').fill(draft);
      await popup.locator('#barkTest').click();
      await eventually(async () => (await popup.locator('#barkStatus').textContent()).startsWith('Bark 已接收'), true);
      const [sent] = await calls();
      assert.equal(sent.url, draft);
      assert.equal(sent.method, 'POST');
      assert.match(sent.headers['Content-Type'], /application\/json/);
      assert.equal(sent.credentials, 'omit');
      assert.equal(sent.redirect, 'error');
      assert.deepEqual(Object.keys(sent.body).sort(), ['body', 'group', 'title']);
      assert.equal((await config()).url, url);
      await popup.locator('#barkUrl').fill('not-a-link');
      await popup.locator('#barkSave').click();
      await eventually(() => popup.locator('#barkStatus').getAttribute('class'), 'status error');
      assert.equal((await config()).url, url);
      await popup.locator('#barkUrl').fill(url);
      await popup.locator('#settingsToggle').click();
    });

    await check('Bark：内容脚本无法读取配置或调用推送接口', async () => {
      const [result] = await popup.evaluate(async id => chrome.scripting.executeScript({ target: { tabId: id }, func: async () => {
        const message = await chrome.runtime.sendMessage({ type: 'BARK_READ' });
        let denied = false;
        try { await chrome.storage.local.get('bark-notification-config'); } catch { denied = true; }
        return { message, denied };
      } }), tabId);
      assert.equal(result.result.message.ok, false);
      assert.equal(result.result.message.config, undefined);
      assert.equal(result.result.denied, true);
    });

    await check('Bark：每次 A→B 同步两路通知，只发送自定义名称和配置状态', async () => {
      await service.evaluate(() => { globalThis.barkCalls = []; globalThis.monitorNotices = []; });
      await request('SAVE_NAME', { name: '演示任务', emoji: '🚀' });
      await pick(); await save();
      await set('发布完成');
      await eventually(async () => (await calls()).length, 1); await eventually(notices, 1);
      assert.deepEqual((await calls())[0].body, { title: '🚀 演示任务', body: '发布中 → 发布完成', group: '标签定名' });
      await request('CLEAR_NAME');
      await page.evaluate(() => document.title = 'private-site-title');
      await set('发布中'); await set('发布完成');
      await eventually(async () => (await calls()).length, 2); await eventually(notices, 2);
      assert.equal((await calls())[1].body.title, '标签定名');
      await set('发布完成'); assert.equal(await count(), 2);
    });

    await check('Bark：桌面通知被拒绝时仍推送，Bark 失败不影响桌面通知', async () => {
      await service.evaluate(() => {
        globalThis.barkOriginalPermission = chrome.notifications.getPermissionLevel;
        chrome.notifications.getPermissionLevel = async () => 'denied';
      });
      await set('发布中'); await set('发布完成');
      await eventually(async () => (await calls()).length, 3);
      await eventually(async () => (await read()).notificationError.startsWith('桌面通知失败'), true);
      assert.equal(await notices(), 2);
      await service.evaluate(() => { chrome.notifications.getPermissionLevel = globalThis.barkOriginalPermission; globalThis.barkMode = 'rejected'; });
      await set('发布中'); await set('发布完成');
      await eventually(notices, 3);
      await eventually(async () => (await read()).notificationError.startsWith('Bark 推送失败'), true);
      assert.ok(!(await read()).notificationError.includes('test-device-key'));
      await popup.locator('#monitor').evaluate(element => element.open = true);
      await popup.locator('#monitorTest').click();
      await eventually(async () => (await popup.locator('#monitorStatus').textContent()).includes('桌面测试通知已发送'), true);
      assert.ok((await popup.locator('#monitorStatus').textContent()).includes('Bark 推送失败'));
      assert.ok((await read()).notificationError.startsWith('Bark 推送失败'), 'Desktop-only test must not clear a Bark error');
      await service.evaluate(() => globalThis.barkMode = 'ok');
    });

    await check('Bark：网络、HTTP、格式错误及超时有反馈且不泄露 Key', async () => {
      for (const [mode, expected] of [['network', '连接失败'], ['http', 'HTTP 503'], ['invalid', '格式不正确'], ['timeout', '请求超时']]) {
        await service.evaluate(mode => globalThis.barkMode = mode, mode);
        let message;
        try { await request('BARK_TEST', { url }); } catch (error) { message = error.message; }
        assert.ok(message?.includes(expected), `${mode}: ${message}`);
        assert.ok(!message.includes('test-device-key'));
      }
      await service.evaluate(() => globalThis.barkMode = 'ok');
    });

    await check('Bark：停用与清除后仅发送桌面通知', async () => {
      await page.bringToFront(); await popup.reload(); await popup.locator('#settingsToggle').click();
      await eventually(() => popup.locator('#barkEnabled').isEnabled(), true);
      await popup.locator('#barkEnabled').uncheck(); await popup.locator('#barkSave').click();
      await eventually(async () => (await config()).enabled, false);
      const before = (await calls()).length;
      const desktops = await notices();
      await set('发布中'); await set('发布完成'); await eventually(notices, desktops + 1);
      assert.equal((await calls()).length, before);
      assert.equal((await config()).url, url);
      await popup.locator('#barkClear').click();
      await eventually(async () => (await config()).url, '');
      await set('发布中'); await set('发布完成'); await eventually(notices, desktops + 2);
      assert.equal((await calls()).length, before);
      assert.equal((await read()).notificationError, '');
      await popup.locator('#settingsToggle').click();
      assert.equal(await popup.locator('#settingsView').isVisible(), false);
      assert.equal(await popup.locator('#homeView').isVisible(), true);
    });
  } finally {
    await request('BARK_CLEAR');
    await request('MONITOR_DELETE');
    await request('CLEAR_NAME');
    await page.locator('#release-status').evaluate(element => element.textContent = '发布中');
    await service.evaluate(() => {
      globalThis.fetch = globalThis.barkOriginalFetch;
      if (globalThis.barkOriginalPermission) chrome.notifications.getPermissionLevel = globalThis.barkOriginalPermission;
      globalThis.monitorNotices = [];
    });
  }
};
