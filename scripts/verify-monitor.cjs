const assert = require('node:assert/strict');
const path = require('node:path');

// Browser integration scenarios. CDP reaches the closed extension-owned shadow root only in the test driver.
exports.verifyMonitor = async ({ context, popup, base, extensionId, artifactPath, check, eventually, nativeVisibility = false }) => {
  const page = await context.newPage();
  const fixture = `${base}/monitor-fixture`;
  await page.goto(fixture);
  const tabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, fixture);
  await popup.evaluate(async id => { const own = await chrome.tabs.getCurrent(); await chrome.tabs.move(id, { windowId: own.windowId, index: -1 }); }, tabId);
  const request = (type, extra = {}) => popup.evaluate(async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'No response');
    return result;
  }, { type, tabId, ...extra });
  const read = () => popup.evaluate(async id => (await chrome.storage.session.get(`tab-monitor:${id}`))[`tab-monitor:${id}`] || null, tabId);
  const count = async () => (await read()).triggerCount;
  const settled = async text => eventually(async () => (await read())?.lastText, text);
  const set = async text => { await page.locator('#release-status').evaluate((element, value) => { element.textContent = value; }, text); await settled(text.replace(/\s+/gu, ' ').trim()); };
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  async function editor(selector, functionDeclaration, args = []) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const search = node => {
      if (node.attributes?.includes('data-tab-status-ui')) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = search(child); if (found) return found; }
      return null;
    };
    const host = search(root);
    assert.ok(host?.shadowRoots?.length, 'Selection overlay must exist');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: host.shadowRoots[0].nodeId, selector });
    assert.ok(nodeId, `Editor control ${selector} exists`);
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    try {
      const response = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
  }
  const fill = (selector, value) => editor(selector, 'function(value) { this.value = value; this.dispatchEvent(new Event("input", {bubbles:true})); }', [value]);
  const click = selector => editor(selector, 'function() { this.click(); }');
  const pick = async (edit = false) => {
    await page.bringToFront();
    await request('MONITOR_START_PICK', { edit });
    if (!edit) {
      const bounds = await page.locator('#release-status').boundingBox();
      await page.mouse.move(bounds.x + 10, bounds.y + 8);
      await page.mouse.click(bounds.x + 10, bounds.y + 8);
    }
  };
  const save = async (stateA = '发布中', stateB = '发布完成') => {
    await fill('#stateA', stateA);
    await fill('#stateB', stateB);
    await click('button[type=submit]');
    await eventually(() => page.locator('[data-tab-status-ui]').count(), 0);
    await eventually(async () => (await read())?.status, 'watching');
  };

  const mockNotifications = async () => {
    const service = context.serviceWorkers().find(worker => worker.url().includes(extensionId));
    await service.evaluate(() => {
      globalThis.monitorNotices = [];
      chrome.notifications.create = async (id, options) => { globalThis.monitorNotices.push({ id, options }); return id; };
    });
    return service;
  };
  let service = await mockNotifications();

  await check('监听：按标签页跟随新发布单、跨应用/域名与离开返回', async () => {
    const origin = 'https://ops.qima-inc.com/';
    const release = (id, app = 'demo', bu = '1') => `${origin}#/applications/${app}/deploy/${id}/publish?buId=${bu}`;
    // Serve a local fixture at the OPS origin; this browser has no user credentials and never calls the real site.
    await page.route(`${origin}**`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<meta charset="utf-8"><title>Local OPS fixture</title><div style="padding:70px 30px" id="release"><span id="release-status">发布中</span></div>' }));
    await page.goto(release(101));
    await pick(); await save('发布中', '发布成功');
    const version = (await read()).version;
    await set('发布成功'); await eventually(count, 1);
    await page.evaluate(url => history.pushState({}, '', url), release(102));
    await eventually(async () => (await read()).activeUrl, release(102));
    await eventually(async () => (await read()).status, 'watching');
    await settled('发布成功'); assert.equal(await count(), 1);
    await popup.bringToFront();
    if (nativeVisibility) await eventually(() => page.evaluate(() => document.visibilityState), 'hidden');
    await set('发布中'); await set('发布成功'); await eventually(count, 2);
    let expected = 2;
    for (const url of [`${origin}#/applications/demo`, release(103, 'other-app'), release(103, 'demo', '2'), `${origin}#/applications/demo/deploy/103/detail?buId=1`]) {
      await page.evaluate(url => history.pushState({}, '', url), url);
      await eventually(async () => (await read()).activeUrl, url);
      await eventually(async () => (await read()).status, 'watching');
      await settled('发布成功'); assert.equal(await count(), expected);
      await set('发布中'); await set('发布成功'); await eventually(count, ++expected);
    }
    await page.goto(fixture); await settled('发布中');
    await set('发布成功'); await eventually(count, ++expected);
    await page.goto(`${base}/beta`); await eventually(async () => (await read()).status, 'waiting');
    assert.equal((await read()).lastText, null);
    await page.goto(release(104)); await settled('发布中');
    await set('发布成功'); await eventually(count, ++expected);
    assert.equal((await read()).version, version);
    await request('MONITOR_PAUSE', { paused: true });
    await page.evaluate(url => history.pushState({}, '', url), release(105));
    await eventually(async () => (await read()).activeUrl, release(105));
    assert.equal((await read()).status, 'paused');
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    await request('MONITOR_PAUSE', { paused: false }); await settled('发布中');
    await set('发布成功'); await eventually(count, ++expected);
    await page.bringToFront(); await popup.reload();
    await eventually(() => popup.locator('#monitorBadge').textContent(), '监听中');
    assert.equal(await popup.locator('#monitorPick').isEnabled(), true);
    assert.match(await popup.locator('#monitorScope').textContent(), /跟随当前标签页/);
    await popup.bringToFront(); await popup.setViewportSize({ width: 344, height: 580 });
    await popup.locator('main').screenshot({ path: path.join(artifactPath, 'monitor-tab-scope.png') });
    await pick(true); await save('发布中', '发布成功');
    assert.equal((await read()).pageUrl, release(105));
    await request('MONITOR_DELETE');
    await page.goto(fixture);
    await page.unroute(`${origin}**`);
    service = await mockNotifications();
  });

  await check('监听：SPA 跳转后无需刷新即可配置，后台标签页仍触发通知', async () => {
    const url = `${fixture}#/applications/demo/deploy/42/publish?buId=1`;
    await page.evaluate(url => history.pushState({}, '', url), url);
    await pick();
    await fill('#stateB', '发布完成');
    await click('button[type=submit]');
    await eventually(async () => {
      if (!await page.locator('[data-tab-status-ui]').count()) return 'saved';
      return await editor('.error', 'function() { return this.textContent; }') || 'saving';
    }, 'saved');
    await settled('发布中');
    await popup.bringToFront();
    assert.equal(await popup.evaluate(async id => (await chrome.tabs.get(id)).active, tabId), false);
    if (nativeVisibility) await eventually(() => page.evaluate(() => document.visibilityState), 'hidden');
    await set('发布完成');
    assert.equal(await count(), 1);
    assert.equal((await service.evaluate(() => globalThis.monitorNotices)).length, 1);
    await page.bringToFront();
    await set('发布中'); await set('发布完成');
    assert.equal(await count(), 2);
    await pick(true);
    await page.evaluate(() => history.replaceState({ render: 'updated' }, '', location.href));
    await request('MONITOR_INSPECT');
    await save();
    await request('MONITOR_DELETE');
    await page.evaluate(url => history.replaceState({}, '', url), fixture);
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    service = await mockNotifications();
  });

  await check('监听：连续发布时状态文字与图标同时重绘仍提醒', async () => {
    await pick(); await save();
    await set('发布完成'); await eventually(count, 1);
    for (let round = 0; round < 2; round++) {
      await set('发布中');
      await page.locator('#release-status').evaluate(element => {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('aria-hidden', 'true'); element.prepend(icon);
      });
      await page.locator('#release-status').evaluate(element => {
        element.querySelector('svg').remove();
        element.lastChild.data = '发布完成';
      });
      await settled('发布完成'); await eventually(count, round + 2);
    }
    await request('MONITOR_DELETE');
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    service = await mockNotifications();
  });

  await check('监听：临时断连与响应丢失会重试，后台连续转换不丢失或重复', async () => {
    await pick(); await save(); await settled('发布中');
    await popup.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let attempts = 0;
      chrome.runtime.sendMessage = async (message, ...args) => {
        if (message.type !== 'MONITOR_OBSERVE') return send(message, ...args);
        if (++attempts === 1) throw new Error('验收用临时断连');
        await send(message, ...args);
        chrome.runtime.sendMessage = send;
        throw new Error('验收用响应丢失');
      };
    } }), tabId);
    await popup.bringToFront();
    for (const value of ['发布完成', '发布中', '发布完成']) await page.locator('#release-status').evaluate((element, value) => { element.textContent = value; }, value);
    await eventually(count, 2);
    await eventually(async () => (await service.evaluate(() => globalThis.monitorNotices)).length, 2);
    await page.bringToFront();
    await request('MONITOR_DELETE');
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    service = await mockNotifications();
  });

  await check('监听：切回标签页同步临时失败后仍继续监听', async () => {
    await pick(); await save(); await settled('发布中');
    await popup.bringToFront();
    await popup.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message, ...args) => {
        if (message.type !== 'MONITOR_READ_OWN') return send(message, ...args);
        chrome.runtime.sendMessage = send;
        throw new Error('验收用同步失败');
      };
    } }), tabId);
    await page.bringToFront();
    // Standard Playwright emulates focus; the native CDP run exercises the real visibilitychange event.
    if (!nativeVisibility) await popup.evaluate(id => chrome.tabs.sendMessage(id, { type: 'MONITOR_SYNC' }), tabId);
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布完成'; });
    await eventually(count, 1);
    await request('MONITOR_DELETE');
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    service = await mockNotifications();
  });

  await check('监听：选择拦截点击、Esc 取消、状态校验与重新选择', async () => {
    await page.evaluate(() => { window.siteClicks = 0; document.getElementById('release-status').addEventListener('click', () => window.siteClicks++); });
    await request('MONITOR_START_PICK');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-tab-status-ui]').count(), 0);
    assert.equal(await read(), null);
    await pick();
    assert.equal(await page.evaluate(() => window.siteClicks), 0);
    assert.equal(await editor('#stateA', 'function() { return this.value; }'), '发布中');
    await fill('#stateB', ' 发布中 ');
    await click('button[type=submit]');
    assert.equal(await read(), null);
    assert.match(await editor('.error', 'function() { return this.textContent; }'), /两个不同/);
    await click('.actions button[type=button]');
    const bounds = await page.locator('#release-status').boundingBox();
    await page.mouse.click(bounds.x + 10, bounds.y + 8);
    await fill('#stateB', '发布完成');
    await page.screenshot({ path: path.join(artifactPath, 'monitor-editor-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(artifactPath, 'monitor-editor-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await save();
    assert.equal((await read()).locator.selector, 'span[id="release-status"]');
  });

  await check('监听：严格 A → B、其他状态与重复状态均不误报', async () => {
    await set('发布完成'); assert.equal(await count(), 1);
    await set('发布完成'); assert.equal(await count(), 1);
    await set('失败'); await set('发布完成'); assert.equal(await count(), 1);
    await set('发布中'); await set('失败'); await set('发布完成'); assert.equal(await count(), 1);
    await set('发布中'); await set(''); await set('发布完成'); assert.equal(await count(), 1);
    await set(' \n发布中  '); await set('发布完成'); assert.equal(await count(), 2);
    const notices = await service.evaluate(() => globalThis.monitorNotices);
    assert.equal(notices.length, 2);
    assert.equal(notices[0].options.message, '发布中 → 发布完成');
  });

  await check('监听：同批次文字与节点替换保留中间状态', async () => {
    await set('发布中');
    await page.locator('#release-status').evaluate(element => { element.firstChild.data = '失败'; element.firstChild.data = '发布完成'; });
    await settled('发布完成'); assert.equal(await count(), 2);
    await set('发布中');
    await page.locator('#release-status').evaluate(element => { element.textContent = '失败'; element.textContent = '发布完成'; });
    await settled('发布完成'); assert.equal(await count(), 2);
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; element.textContent = '发布完成'; });
    await settled('发布完成'); await eventually(count, 3);
  });

  await check('监听：丢失、重建、定位歧义与取消编辑', async () => {
    await set('发布中');
    await page.locator('#release-status').evaluate(element => element.remove());
    await eventually(async () => (await read()).status, 'waiting');
    await page.locator('#release').evaluate(parent => { const span = document.createElement('span'); span.id = 'release-status'; span.textContent = '发布完成'; parent.append(span); });
    await settled('发布完成'); assert.equal(await count(), 4);
    await page.locator('#release-status').evaluate(element => element.after(element.cloneNode(true)));
    await eventually(async () => (await read()).status, 'ambiguous');
    await page.locator('#release-status').last().evaluate(element => element.remove());
    await settled('发布完成'); assert.equal(await count(), 4);
    const old = (await read()).version;
    await pick(true); await fill('#stateB', '新状态'); await page.keyboard.press('Escape');
    assert.equal((await read()).version, old);
    await set('发布中');
    await page.locator('#release-status').evaluate(element => { const replacement = element.cloneNode(); replacement.textContent = '发布完成'; element.replaceWith(replacement); });
    await settled('发布完成'); assert.equal(await count(), 5);
  });

  await check('监听：样式变化不干扰文本转换与同批次中间状态', async () => {
    const before = await count();
    await set('发布中');
    await page.locator('#release-status').evaluate(element => { element.className = 'status-success'; element.firstChild.data = '发布完成'; });
    await settled('发布完成');
    await eventually(count, before + 1);
    await set('发布中');
    await page.locator('#release-status').evaluate(element => {
      element.style.color = 'green'; element.parentElement.className = 'status-container'; element.textContent = '发布完成';
    });
    await settled('发布完成');
    await eventually(count, before + 2);
    await set('发布中');
    await page.locator('#release-status').evaluate(element => {
      element.className = 'status-other'; element.firstChild.data = '失败'; element.style.color = 'purple'; element.firstChild.data = '发布完成'; element.className = 'status-success';
    });
    await settled('发布完成');
    assert.equal(await count(), before + 2);
    await set('发布中');
    await page.locator('#release-status').evaluate(element => {
      element.textContent = '失败'; element.className = 'status-other'; element.textContent = '发布完成'; element.style.color = 'green';
    });
    await settled('发布完成');
    assert.equal(await count(), before + 2);
    await page.locator('#release-status').evaluate(element => {
      element.className = 'status-active'; element.textContent = '发布中'; element.style.color = 'blue'; element.textContent = '发布完成';
    });
    await settled('发布完成');
    await eventually(count, before + 3);
    const sequence = (await read()).sequence;
    await page.locator('#release-status').evaluate(element => {
      element.className = 'status-done'; element.style.color = 'purple'; element.parentElement.style.borderColor = 'purple';
    });
    await eventually(async () => (await read()).sequence > sequence, true);
    assert.equal(await count(), before + 3);
  });

  await check('监听：修改规则重建基线、首次 B 不通知、旧消息被拒绝', async () => {
    const old = await read();
    await pick(true); await save();
    assert.equal(await count(), 0);
    // Use the real isolated content-script context to send an outdated rule version.
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', event => worlds.push(event.context));
    await cdp.send('Runtime.enable');
    const world = worlds.find(item => item.name === extensionId || item.origin === `chrome-extension://${extensionId}`);
    assert.ok(world, 'Isolated extension context exists');
    const payload = { type: 'MONITOR_OBSERVE', url: page.url(), version: old.version, epoch: old.epoch, sequence: 9999, values: ['发布中', '发布完成'] };
    const response = await cdp.send('Runtime.evaluate', { contextId: world.id, expression: `chrome.runtime.sendMessage(${JSON.stringify(payload)})`, awaitPromise: true, returnByValue: true });
    assert.equal(response.result.value.stale, true);
    assert.equal(await count(), 0);
    const current = await read();
    const wrongRoute = { ...payload, version: current.version, epoch: current.epoch, url: `${page.url()}#outdated-route` };
    const rejected = await cdp.send('Runtime.evaluate', { contextId: world.id, expression: `chrome.runtime.sendMessage(${JSON.stringify(wrongRoute)})`, awaitPromise: true, returnByValue: true });
    assert.equal(rejected.result.value.stale, true);
    assert.equal(await count(), 0);
    await request('MONITOR_PAUSE', { paused: true });
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    await request('MONITOR_PAUSE', { paused: false }); await settled('发布中');
    await set('发布完成'); assert.equal(await count(), 1);
  });

  await check('监听：刷新延续，换网址/查询参数/hash 自动继续并重建基线', async () => {
    await set('发布中');
    await page.route(fixture, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><title>Reload</title><span id="release-status">发布完成</span>' }));
    await page.reload(); await settled('发布完成'); assert.equal(await count(), 2);
    await page.unroute(fixture);
    for (const suffix of ['?task=another', '#another']) {
      await set('发布中');
      await page.evaluate(url => { history.pushState({}, '', url); document.querySelector('#release-status').textContent = '发布完成'; }, `${fixture}${suffix}`);
      await eventually(async () => (await read()).activeUrl, `${fixture}${suffix}`);
      await eventually(async () => (await read()).status, 'watching');
      await settled('发布完成'); assert.equal(await count(), 2);
      await page.evaluate(url => history.pushState({}, '', url), fixture);
      await eventually(async () => (await read()).activeUrl, fixture);
      await settled('发布完成'); assert.equal(await count(), 2);
    }
    await page.goto(`${base}/beta`); await eventually(async () => (await read()).status, 'waiting');
    await page.goto(fixture); await settled('发布中');
  });

  await check('监听：后台唤醒延续状态，通知错误可见且不重复重试', async () => {
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await request('MONITOR_INSPECT');
    service = await mockNotifications();
    await set('发布完成'); assert.equal(await count(), 3);
    await service.evaluate(() => { chrome.notifications.create = async () => { throw new Error('验收用通知故障'); }; });
    await set('发布中'); await set('发布完成');
    await eventually(async () => /验收用通知故障/.test((await read()).notificationError), true);
    assert.equal(await count(), 4);
    await set('发布完成'); assert.equal(await count(), 4);
    service = await mockNotifications();
    await request('MONITOR_TEST');
    assert.equal((await read()).notificationError, '');
    assert.equal((await service.evaluate(() => globalThis.monitorNotices)).length, 1);
  });

  await check('监听：通知点击处理定位原标签页并聚焦窗口', async () => {
    await popup.bringToFront();
    const noticeId = await service.evaluate(() => globalThis.monitorNotices[0].id);
    const notificationDriver = await context.newPage();
    await notificationDriver.goto(`chrome-extension://${extensionId}/popup.html`);
    await notificationDriver.evaluate(async id => { const { activateNotice } = await import('./monitor-background.js'); await activateNotice(id); }, noticeId);
    await notificationDriver.close();
    const focus = await popup.evaluate(async id => { const tab = await chrome.tabs.get(id); const window = await chrome.windows.get(tab.windowId); return { active: tab.active, focused: window.focused }; }, tabId);
    assert.deepEqual(focus, { active: true, focused: true });
    assert.equal(await popup.evaluate(async id => (await chrome.storage.session.get(`monitor-notice:${id}`))[`monitor-notice:${id}`] || null, noticeId), null);
  });

  await check('监听：同网址隔离、复制不继承、跨窗口移动与关闭清理', async () => {
    const second = await context.newPage(); await second.goto(fixture);
    const duplicate = await popup.evaluate(async id => chrome.tabs.duplicate(id), tabId);
    assert.equal(await popup.evaluate(async id => (await chrome.storage.session.get(`tab-monitor:${id}`))[`tab-monitor:${id}`] || null, duplicate.id), null);
    await second.locator('#release-status').evaluate(element => { element.textContent = '发布完成'; });
    assert.equal(await count(), 4);
    await popup.evaluate(async id => chrome.tabs.remove(id), duplicate.id);
    await second.close();
    const otherWindow = await popup.evaluate(async () => chrome.windows.create({ url: 'about:blank' }));
    await popup.evaluate(async ({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), { id: tabId, windowId: otherWindow.id });
    await set('发布中'); await set('发布完成'); assert.equal(await count(), 5);
    // Inspect the actual popup with the rule configured, including its theme and error/status layout.
    await popup.evaluate(async id => { const own = await chrome.tabs.getCurrent(); await chrome.tabs.move(id, { windowId: own.windowId, index: -1 }); }, tabId);
    await page.bringToFront(); await popup.reload();
    await eventually(() => popup.locator('#monitorRule').textContent(), '发布中 → 发布完成');
    await popup.bringToFront();
    await popup.setViewportSize({ width: 344, height: 580 });
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.locator('main').screenshot({ path: path.join(artifactPath, 'monitor-popup-light.png') });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.locator('main').screenshot({ path: path.join(artifactPath, 'monitor-popup-dark.png') });
    await popup.emulateMedia({ colorScheme: 'light' });
    await request('MONITOR_DELETE');
    assert.equal(await read(), null);
    await page.locator('#release-status').evaluate(element => { element.textContent = '发布中'; });
    await pick(); await save();
    await popup.evaluate(async ({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), { id: tabId, windowId: otherWindow.id });
    await popup.evaluate(async id => chrome.windows.remove(id), otherWindow.id);
    await eventually(read, null);
    const leftovers = await popup.evaluate(async id => Object.entries(await chrome.storage.session.get(null)).filter(([key, value]) => key.startsWith('monitor-notice:') && value.tabId === id), tabId);
    assert.equal(leftovers.length, 0);
  });

  await check('监听：为浏览器重启验收保留实际配置的规则', async () => {
    const last = await context.newPage(); await last.goto(`${fixture}?restart`);
    const id = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${fixture}?restart`);
    await request('MONITOR_START_PICK', { tabId: id });
    const draft = await popup.evaluate(async id => (await chrome.storage.session.get(`monitor-pick:${id}`))[`monitor-pick:${id}`], id);
    const saved = await popup.evaluate(async ({ id, token }) => chrome.scripting.executeScript({ target: { tabId: id }, func: async token => {
      return chrome.runtime.sendMessage({ type: 'MONITOR_SAVE', url: location.href, token, stateA: '发布中', stateB: '发布完成', text: '发布中', locator: { selector: '#release-status', tag: 'span' } });
    }, args: [token] }), { id, token: draft.token });
    assert.equal(saved[0].result.ok, true);
    assert.ok(await popup.evaluate(async id => (await chrome.storage.session.get(`tab-monitor:${id}`))[`tab-monitor:${id}`], id));
  });
};
