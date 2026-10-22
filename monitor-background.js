import { sendBarkNotification } from "./bark-background.js";

const PREFIX = "tab-monitor:";
const PICK = "monitor-pick:";
const NOTICE = "monitor-notice:";
const queues = new Map();
const keyFor = (tabId) => `${PREFIX}${tabId}`;
const normalise = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

function serialise(tabId, operation) {
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

async function read(key) { return (await chrome.storage.session.get(key))[key] || null; }
async function write(tabId, record) { await chrome.storage.session.set({ [keyFor(tabId)]: record }); }

function supported(url) {
  try {
    const value = new URL(url);
    return ["http:", "https:"].includes(value.protocol) && value.hostname !== "chromewebstore.google.com"
      && !(value.hostname === "chrome.google.com" && value.pathname.startsWith("/webstore"));
  } catch { return false; }
}

async function currentFrame(tabId) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (!frame || frame.documentLifecycle !== "active") throw new Error("页面正在切换，请稍后重试。");
  return frame;
}

function align(record, frame) {
  if (record.documentId !== frame.documentId || record.activeUrl !== frame.url) {
    // The rule belongs to the tab; a new URL only resets its observed text, never disables the rule.
    if (record.activeUrl !== frame.url) record.lastText = null;
    record.documentId = frame.documentId;
    record.activeUrl = frame.url;
    record.epoch = crypto.randomUUID();
    record.sequence = 0;
    record.status = record.paused ? "paused" : "waiting";
  }
  return record;
}

async function contact(tabId, message, inject = false) {
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
  catch (error) {
    if (!inject) throw error;
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded || !supported(tab.url)) throw new Error("当前页面不能选择元素，请打开普通网页后重试。");
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["monitor-content.js"] });
    return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  }
}

async function sync(tabId) {
  await contact(tabId, { type: "MONITOR_SYNC" }).catch(() => {});
}

async function createNotice(tabId, record, test = false) {
  const tab = await chrome.tabs.get(tabId);
  const name = await read(`tab-name:${tabId}`);
  const id = `tab-status-${crypto.randomUUID()}`;
  if (await chrome.notifications.getPermissionLevel() !== "granted") throw new Error("通知未获允许，请在 Chrome 和系统通知设置中开启通知。");
  await chrome.storage.session.set({ [`${NOTICE}${id}`]: { tabId, pageUrl: record?.pageUrl || tab.url } });
  try {
    await chrome.notifications.create(id, {
      type: "basic", iconUrl: "icons/128.png", title: (name?.title || tab.title || "标签定名").slice(0, 120),
      message: test ? "这是一条测试通知。点击可返回当前标签页。" : `${record.stateA} → ${record.stateB}`, priority: 0
    });
    return id;
  } catch (error) {
    await chrome.storage.session.remove(`${NOTICE}${id}`);
    throw error;
  }
}

async function deliverNotifications(tabId, record) {
  const bark = async () => {
    const name = await read(`tab-name:${tabId}`);
    // Only explicit user labels and configured states leave the browser, never the site's title or URL.
    return sendBarkNotification((name?.title || "标签定名").slice(0, 120), `${record.stateA} → ${record.stateB}`);
  };
  const results = await Promise.allSettled([createNotice(tabId, record), bark()]);
  return results.map((result, index) => result.status === "rejected" ? `${index ? "Bark 推送" : "桌面通知"}失败：${result.reason.message}` : "").filter(Boolean).join("；");
}

async function validateContent(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !sender.documentId) throw new Error("无法识别当前页面。");
  const frame = await currentFrame(sender.tab.id);
  // Chrome can keep sender.url at the content script's initial URL after a same-document SPA navigation.
  // documentId identifies the live document; SAVE/OBSERVE separately validate the URL captured by the script.
  if (sender.documentId !== frame.documentId) throw new Error("页面已切换，请重新配置。");
  return frame;
}

async function handleContent(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("无法识别当前标签页。");
  return serialise(tabId, async () => {
    const frame = await validateContent(sender);
    let record = await read(keyFor(tabId));
    if (record) {
      const previous = JSON.stringify(record);
      align(record, frame);
      if (JSON.stringify(record) !== previous) await write(tabId, record);
    }
    if (message.type === "MONITOR_READ_OWN") return { record };
    if (message.type === "MONITOR_CANCEL_PICK") {
      const draft = await read(`${PICK}${tabId}`);
      if (draft?.token === message.token) await chrome.storage.session.remove(`${PICK}${tabId}`);
      return {};
    }
    if (message.type === "MONITOR_SAVE") {
      const draft = await read(`${PICK}${tabId}`);
      if (!draft || draft.token !== message.token || draft.documentId !== frame.documentId || draft.url !== frame.url || message.url !== frame.url
        || draft.baseVersion !== (record?.version || null)) throw new Error("配置已过期，请重新选择元素。");
      const stateA = normalise(message.stateA);
      const stateB = normalise(message.stateB);
      if (!stateA || !stateB || stateA === stateB) throw new Error("请填写两个不同的非空状态。");
      if (stateA.length > 200 || stateB.length > 200) throw new Error("每个状态最多 200 个字符。");
      const locator = message.locator;
      if (!locator || typeof locator.selector !== "string" || !locator.selector || locator.selector.length > 2048
        || typeof locator.tag !== "string" || !/^[a-z][a-z0-9-]*$/i.test(locator.tag)) throw new Error("无法保存这个元素，请重新选择。");
      record = { version: crypto.randomUUID(), epoch: crypto.randomUUID(), pageUrl: frame.url, activeUrl: frame.url, documentId: frame.documentId,
        locator: { selector: locator.selector, tag: locator.tag }, stateA, stateB, paused: false, lastText: normalise(message.text).slice(0, 10000),
        sequence: 0, status: "watching", triggerCount: 0, notificationError: "", lastTriggeredAt: null };
      await write(tabId, record);
      await chrome.storage.session.remove(`${PICK}${tabId}`);
      return { record };
    }
    if (message.type !== "MONITOR_OBSERVE") throw new Error("无法识别此操作。");
    if (!record || message.version !== record.version || message.epoch !== record.epoch || record.paused || message.url !== frame.url) return { stale: true };
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= record.sequence) return { ignored: true };
    record.sequence = message.sequence;
    if (message.status === "waiting" || message.status === "ambiguous") {
      record.status = message.status;
      if (message.status === "ambiguous") record.lastText = null;
      await write(tabId, record);
      return {};
    }
    if (!Array.isArray(message.values) || message.values.length > 1000 || message.values.some(value => typeof value !== "string")) throw new Error("观察数据无效。");
    record.status = "watching";
    if (message.reset) record.lastText = null;
    for (const value of message.values) {
      const text = normalise(value).slice(0, 10000);
      const trigger = record.lastText === record.stateA && text === record.stateB;
      record.lastText = text;
      if (!trigger) continue;
      // Persist the consumed transition before the external side effect, so retries cannot notify twice.
      record.triggerCount++;
      record.lastTriggeredAt = Date.now();
      record.notificationError = "";
      await write(tabId, record);
      record.notificationError = await deliverNotifications(tabId, record);
    }
    await write(tabId, record);
    return {};
  });
}

export async function handleMonitorMessage(message, sender) {
  if (["MONITOR_READ_OWN", "MONITOR_SAVE", "MONITOR_OBSERVE", "MONITOR_CANCEL_PICK"].includes(message.type)) return handleContent(message, sender);
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("请从扩展弹窗操作。");
  const tabId = message.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("标签页已失效。");
  const result = await serialise(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    let record = await read(keyFor(tabId));
    if (message.type === "MONITOR_INSPECT") {
      if (record) {
        const previous = JSON.stringify(record);
        try { align(record, await currentFrame(tabId)); } catch { /* Keep the rule while the tab loads. */ }
        if (JSON.stringify(record) !== previous) await write(tabId, record);
      }
      return { record, supported: supported(tab.url) && !tab.discarded };
    }
    if (message.type === "MONITOR_DELETE") {
      await chrome.storage.session.remove([keyFor(tabId), `${PICK}${tabId}`]);
      return { record: null };
    }
    if (message.type === "MONITOR_PAUSE") {
      if (!record) throw new Error("当前没有监听规则。");
      record.paused = Boolean(message.paused);
      record.epoch = crypto.randomUUID();
      record.sequence = 0;
      record.lastText = null;
      record.status = record.paused ? "paused" : "waiting";
      await write(tabId, record);
      await chrome.storage.session.remove(`${PICK}${tabId}`);
      return { record };
    }
    if (message.type === "MONITOR_TEST") {
      await createNotice(tabId, record, true);
      if (record?.notificationError) {
        record.notificationError = record.notificationError.split("；").filter(error => error.startsWith("Bark 推送失败：")).join("；");
        await write(tabId, record);
      }
      return {};
    }
    if (message.type === "MONITOR_START_PICK") {
      if (!supported(tab.url) || tab.discarded) throw new Error("请打开普通网页后选择元素。");
      if (message.edit && !record) throw new Error("当前没有监听规则。");
      const frame = await currentFrame(tabId);
      const draft = { token: crypto.randomUUID(), documentId: frame.documentId, url: frame.url, baseVersion: record?.version || null };
      await chrome.storage.session.set({ [`${PICK}${tabId}`]: draft });
      return { draft, record: message.edit ? record : null };
    }
    throw new Error("无法识别此操作。");
  });
  if (message.type === "MONITOR_START_PICK") {
    const response = await contact(tabId, { type: "MONITOR_BEGIN_PICK", token: result.draft.token, record: result.record }, true);
    if (!response?.ok) throw new Error(response?.error || "无法启动元素选择。");
    return {};
  }
  if (["MONITOR_PAUSE", "MONITOR_DELETE"].includes(message.type)) await sync(tabId);
  return result;
}

async function navigated(details) {
  if (details.frameId !== 0) return;
  await serialise(details.tabId, async () => {
    // Queued navigation events can describe an older route. Read the current frame before changing the rule.
    const frame = await currentFrame(details.tabId);
    const record = await read(keyFor(details.tabId));
    if (record) {
      align(record, frame);
      await write(details.tabId, record);
    }
    const draft = await read(`${PICK}${details.tabId}`);
    if (draft && (draft.documentId !== frame.documentId || draft.url !== frame.url)) await chrome.storage.session.remove(`${PICK}${details.tabId}`);
  });
  await sync(details.tabId);
}

for (const event of [chrome.webNavigation.onCommitted, chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
  event.addListener(details => navigated(details).catch(() => {}));
}

chrome.tabs.onRemoved.addListener(tabId => {
  serialise(tabId, async () => {
    const store = await chrome.storage.session.get(null);
    const notices = Object.keys(store).filter(key => key.startsWith(NOTICE) && store[key].tabId === tabId);
    await chrome.storage.session.remove([keyFor(tabId), `${PICK}${tabId}`, ...notices]);
    await Promise.all(notices.map(key => chrome.notifications.clear(key.slice(NOTICE.length)).catch(() => {})));
  }).catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  (async () => {
    const record = await serialise(removedTabId, async () => {
      const old = await read(keyFor(removedTabId));
      await chrome.storage.session.remove([keyFor(removedTabId), `${PICK}${removedTabId}`]);
      return old;
    });
    if (!record) return;
    await serialise(addedTabId, async () => {
      const frame = await currentFrame(addedTabId);
      if (!await read(keyFor(addedTabId))) await write(addedTabId, align(record, frame));
      const store = await chrome.storage.session.get(null);
      for (const [key, value] of Object.entries(store)) if (key.startsWith(NOTICE) && value.tabId === removedTabId) {
        await chrome.storage.session.set({ [key]: { ...value, tabId: addedTabId } });
      }
    });
    await sync(addedTabId);
  })().catch(() => {});
});

export async function activateNotice(id) {
  const notice = await read(`${NOTICE}${id}`);
  if (!notice) return;
  try {
    const tab = await chrome.tabs.update(notice.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } finally {
    await chrome.notifications.clear(id);
    await chrome.storage.session.remove(`${NOTICE}${id}`);
  }
}
chrome.notifications.onClicked.addListener(id => { activateNotice(id).catch(() => {}); });
chrome.notifications.onClosed.addListener(id => { chrome.storage.session.remove(`${NOTICE}${id}`).catch(() => {}); });
