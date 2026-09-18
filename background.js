import { createNameRecord, nameParts } from "./naming.js";

const PREFIX = "tab-name:";
const queues = new Map();
const syncing = new Map();

const keyFor = (tabId) => `${PREFIX}${tabId}`;

function isSupported(url = "") {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname !== "chromewebstore.google.com"
      && !(parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"));
  } catch {
    return false;
  }
}

// Serialise writes for each tab, never through one shared URL or current-window slot.
function serialise(tabId, operation) {
  const previous = queues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(tabId, current);
  current.finally(() => {
    if (queues.get(tabId) === current) queues.delete(tabId);
  }).catch(() => {});
  return current;
}

async function readName(tabId) {
  await (queues.get(tabId) || Promise.resolve()).catch(() => {});
  const key = keyFor(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

async function badge(tabId, named) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: named ? "定" : "" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#7053A4" })
  ]).catch(() => {});
}

// The content script asks for the latest state itself. Never push a possibly stale title.
async function contact(tabId, allowInjection = true) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "SYNC_NAME" }, { frameId: 0 });
  } catch {
    if (!allowInjection) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.discarded || !isSupported(tab.url)) return null;
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"], injectImmediately: true });
      return await chrome.tabs.sendMessage(tabId, { type: "SYNC_NAME" }, { frameId: 0 });
    } catch {
      // Navigation, browser-protected pages and a just-closed tab are expected here.
      return null;
    }
  }
}

async function reconcile(tabId) {
  if (syncing.has(tabId)) return syncing.get(tabId);
  const operation = (async () => {
    const record = await readName(tabId);
    if (!record) return;
    await contact(tabId);
    await badge(tabId, true);
  })();
  syncing.set(tabId, operation);
  try {
    await operation;
  } finally {
    if (syncing.get(tabId) === operation) syncing.delete(tabId);
  }
}

async function inspectTab(tabId) {
  const [tab, record] = await Promise.all([chrome.tabs.get(tabId), readName(tabId)]);
  let supported = isSupported(tab.url);
  if (supported && !tab.discarded) supported = Boolean((await contact(tabId))?.ok);
  return { tabId, title: record?.title || "", ...nameParts(record), pageTitle: tab.title || "", url: tab.url || "", supported, discarded: Boolean(tab.discarded) };
}

function fromPopup(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
}

async function handleMessage(message, sender) {
  if (message?.type === "READ_OWN_NAME") {
    if (!sender.tab || sender.frameId !== 0) throw new Error("无法识别当前标签页。");
    return { record: await readName(sender.tab.id) };
  }
  if (!fromPopup(sender)) throw new Error("请从扩展弹窗操作。");
  const tabId = message.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("标签页已失效，请重新打开弹窗。");
  if (message.type === "INSPECT_TAB") return inspectTab(tabId);
  if (!["SAVE_NAME", "CLEAR_NAME"].includes(message.type)) throw new Error("无法识别此操作。");

  const nextRecord = message.type === "SAVE_NAME" ? createNameRecord(message) : null;
  await serialise(tabId, async () => {
    await chrome.tabs.get(tabId);
    if (message.type === "CLEAR_NAME") {
      await chrome.storage.session.remove(keyFor(tabId));
    } else {
      await chrome.storage.session.set({ [keyFor(tabId)]: nextRecord });
    }
  });
  const applied = await contact(tabId);
  const record = await readName(tabId);
  await badge(tabId, Boolean(record));
  return { title: record?.title || "", ...nameParts(record), applied: Boolean(applied?.ok) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then((value) => sendResponse({ ok: true, ...value }), (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialise(tabId, () => chrome.storage.session.remove(keyFor(tabId))).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url || changeInfo.title !== undefined || changeInfo.discarded === false) reconcile(tabId).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => reconcile(tabId).catch(() => {}));
chrome.tabs.onAttached.addListener((tabId) => reconcile(tabId).catch(() => {}));

// Chrome can replace a tab internally (for example, prerender activation).
// This is different from duplication or closing/reopening: it is the same visible tab.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  (async () => {
    const record = await serialise(removedTabId, async () => {
      const key = keyFor(removedTabId);
      const old = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      return old;
    });
    if (!record) return;
    await serialise(addedTabId, async () => {
      await chrome.tabs.get(addedTabId);
      const key = keyFor(addedTabId);
      if (!(await chrome.storage.session.get(key))[key]) await chrome.storage.session.set({ [key]: record });
    });
    await reconcile(addedTabId);
  })().catch(() => {});
});
