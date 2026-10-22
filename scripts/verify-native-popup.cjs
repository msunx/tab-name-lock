const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const extension = path.resolve(__dirname, '..');
  const output = process.env.QA_OUTPUT || path.join(extension, 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => res.end('<!doctype html><title>Popup check</title>Browser popup check'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.bringToFront();
    const cdp = await context.newCDPSession(page);
    await worker.evaluate(() => chrome.action.openPopup());
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find(item => item.url.endsWith('/popup.html'));
    if (!target) throw new Error('This headless environment does not expose a native action popup target.');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    let id = 0;
    const pending = new Map();
    cdp.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Native popup command timed out: ${method}`)); }, 6000);
      pending.set(requestId, { resolve, reject, timer });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method, params }) }).catch(reject);
    });
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    await evaluate(`new Promise((resolve, reject) => {
      let attempts = 0;
      const poll = () => {
        if (document.getElementById('name') && !document.getElementById('name').disabled) return resolve();
        if (++attempts > 120) return reject(new Error('Name input did not become ready'));
        setTimeout(poll, 30);
      };
      poll();
    })`);
    await evaluate(`document.getElementById('name').value = '生产环境 · 订单'; document.getElementById('name').dispatchEvent(new Event('input'))`);
    const screenshot = async name => {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64'));
    };
    await screenshot('native-popup-compact.png');
    await evaluate(`document.getElementById('settingsToggle').click(); new Promise((resolve, reject) => {
      let attempts = 0;
      const poll = () => {
        if (!document.getElementById('barkUrl').disabled) return resolve();
        if (++attempts > 120) return reject(new Error('Bark settings did not become ready'));
        setTimeout(poll, 30);
      };
      poll();
    })`);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const settingsMetrics = await evaluate(`({ width: innerWidth, height: innerHeight, homeHidden: document.getElementById('homeView').hidden,
      masked: document.getElementById('barkUrl').type === 'password', saveBottom: document.getElementById('barkSave').getBoundingClientRect().bottom,
      noteBottom: document.querySelector('#settingsView p:last-child').getBoundingClientRect().bottom })`);
    assert.equal(settingsMetrics.width, 344);
    assert.equal(settingsMetrics.homeHidden, true);
    assert.equal(settingsMetrics.masked, true);
    assert.ok(settingsMetrics.saveBottom <= settingsMetrics.height && settingsMetrics.noteBottom <= settingsMetrics.height, JSON.stringify(settingsMetrics));
    await screenshot('native-popup-bark-light.png');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await screenshot('native-popup-bark-dark.png');
    await evaluate(`document.getElementById('settingsToggle').click()`);
    assert.equal(await evaluate(`document.getElementById('settingsView').hidden && document.getElementById('name').value === '生产环境 · 订单'`), true);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await evaluate(`document.getElementById('emojiToggle').click(); new Promise(resolve => setTimeout(resolve, 150))`);
    const metrics = await evaluate(`({ width: innerWidth, height: innerHeight, options: document.querySelectorAll('.emoji-option').length,
      saveBottom: document.getElementById('save').getBoundingClientRect().bottom, mainHeight: document.querySelector('main').getBoundingClientRect().height })`);
    assert.equal(metrics.options, 96);
    assert.ok(metrics.saveBottom <= metrics.height, JSON.stringify(metrics));
    await screenshot('native-popup-emojis.png');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await screenshot('native-popup-emojis-dark.png');
    await evaluate(`document.getElementById('emojiGrid').lastElementChild.scrollIntoView({block:'nearest'}); document.getElementById('emojiGrid').lastElementChild.click();
      document.getElementById('save').click();`);
    await page.waitForFunction(() => document.title === '🍺 生产环境 · 订单');
    const result = { result: 'PASS', genuineChromeActionPopup: true, metrics, settingsMetrics, lastEmojiSaved: await page.title() };
    fs.writeFileSync(path.join(output, 'native-popup-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
