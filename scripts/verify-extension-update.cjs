const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const source = path.resolve(__dirname, '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-name-lock-update-'));
  const output = process.env.QA_OUTPUT || path.join(source, 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    if (entry === 'icons' || /\.(js|css|html|json)$/.test(entry)) fs.cpSync(path.join(source, entry), path.join(fixture, entry), { recursive: true });
  }
  const backgroundPath = path.join(fixture, 'background.js');
  const currentBackground = fs.readFileSync(backgroundPath, 'utf8');
  const legacyBackground = currentBackground.replace(/^  if \(message\?\.type\?\.startsWith\("BARK_"\)\) return handleBarkMessage\(message, sender\);\n/m, '');
  assert.notEqual(legacyBackground, currentBackground, 'Fixture must reproduce the pre-Bark message router');
  fs.writeFileSync(backgroundPath, legacyBackground);
  let context;
  try {
    context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 344, height: 580 },
      args: [`--load-extension=${fixture}`, `--disable-extensions-except=${fixture}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    assert.equal((await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BARK_READ' }))).ok, false);
    // Updating files does not replace the already-running extension worker.
    fs.writeFileSync(backgroundPath, currentBackground);
    await popup.reload();
    const legacyReply = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BARK_READ' }));
    assert.deepEqual(legacyReply, { ok: false, error: '标签页已失效，请重新打开弹窗。' });
    await popup.locator('#settingsToggle').click();
    await popup.waitForFunction(() => document.getElementById('barkStatus').textContent.length > 0);
    assert.match(await popup.locator('#barkStatus').textContent(), /扩展后台尚未更新.*重新加载/);
    assert.equal(await popup.locator('#barkUrl').isDisabled(), true);
    assert.equal(await popup.locator('#barkUpdateHelp').isVisible(), true);
    assert.match(await popup.locator('#barkUpdateHelp').textContent(), /清除本次会话的名称和监听规则/);
    console.log('PASS 复现新版界面搭配旧版后台，并显示正确的重新加载提示');
    for (const scheme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.locator('main').screenshot({ path: path.join(output, `bark-update-${scheme}.png`) });
    }

    const saved = { url: 'https://push.example.test/update-check', enabled: false };
    await worker.evaluate(async config => {
      await chrome.storage.local.set({ 'bark-notification-config': config });
      await chrome.storage.session.set({ 'update-verification-marker': true });
    }, saved);
    const managementOpened = context.waitForEvent('page');
    await popup.locator('#barkOpenExtensions').click();
    const management = await managementOpened;
    await management.waitForURL(`chrome://extensions/?id=${extensionId}`);
    assert.equal((await worker.evaluate(() => chrome.storage.session.get('update-verification-marker')))['update-verification-marker'], true);
    console.log('PASS 打开对应扩展管理页，保持当前会话，未自动重新加载');

    // A clean Chrome profile needs developer mode for unpacked extensions to remain enabled after a reload.
    const developerMode = management.getByRole('button', { name: /^(开发者模式|Developer mode)$/ });
    if (await developerMode.getAttribute('aria-pressed') !== 'true') await developerMode.click();
    assert.equal(await developerMode.getAttribute('aria-pressed'), 'true');
    await worker.evaluate(() => chrome.runtime.reload()).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
    const refreshed = await context.newPage();
    const deadline = Date.now() + 7000;
    for (;;) {
      try { await refreshed.goto(`chrome-extension://${extensionId}/popup.html`); break; }
      catch (error) {
        if (!error.message.includes('ERR_BLOCKED_BY_CLIENT') || Date.now() >= deadline) {
          console.error(await management.locator('body').ariaSnapshot());
          throw error;
        }
        // Chrome briefly unregisters the extension origin during a real reload.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await refreshed.waitForFunction(async () => {
      try { return (await chrome.runtime.sendMessage({ type: 'BARK_READ' })).ok; } catch { return false; }
    });
    await refreshed.locator('#settingsToggle').click();
    await refreshed.waitForFunction(() => !document.getElementById('barkUrl').disabled);
    assert.equal(await refreshed.locator('#barkUpdateHelp').isVisible(), false);
    assert.equal(await refreshed.locator('#barkUrl').inputValue(), saved.url);
    assert.deepEqual(await refreshed.evaluate(() => chrome.runtime.sendMessage({ type: 'BARK_READ', tabId: -1 })), { ok: true, config: saved });
    assert.deepEqual(await refreshed.evaluate(() => chrome.storage.session.get('update-verification-marker')), {});
    await refreshed.locator('#barkSave').click();
    await refreshed.waitForFunction(() => document.getElementById('barkStatus').textContent.includes('已停用 Bark 同步'));
    await refreshed.locator('#barkClear').click();
    await refreshed.waitForFunction(() => document.getElementById('barkStatus').textContent.includes('已清除 Bark 配置'));
    assert.equal(await refreshed.locator('#barkUrl').inputValue(), '');
    console.log('PASS 重新加载后设置恢复，Bark 配置保留，读写配置不依赖有效标签页');
  } finally {
    await context?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
