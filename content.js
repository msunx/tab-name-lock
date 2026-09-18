(() => {
  if (globalThis.__tabNameLock) {
    globalThis.__tabNameLock.sync();
    return;
  }

  let lockedTitle = null;
  let lastAppliedTitle = null;
  let originalTitle = document.title;
  let requestNumber = 0;
  let enabled = false;
  let observedRoot = null;
  let observedHead = null;

  // Observe only document/root/head structure, not the body of a busy application.
  const documentObserver = new MutationObserver(refreshStructure);
  const rootObserver = new MutationObserver(refreshStructure);
  const headObserver = new MutationObserver(enforce);

  function enforce() {
    if (!enabled || lockedTitle === null) return;
    if (!chrome.runtime?.id) {
      unlock();
      return;
    }
    const current = document.title;
    if (current !== lockedTitle) {
      if (current !== lastAppliedTitle) originalTitle = current;
      if (!document.head && document.documentElement && document.contentType === "text/html") {
        document.documentElement.prepend(document.createElement("head"));
      }
      document.title = lockedTitle;
      lastAppliedTitle = lockedTitle;
    }
  }

  function refreshStructure() {
    if (!enabled) return;
    if (document.documentElement !== observedRoot) {
      rootObserver.disconnect();
      observedRoot = document.documentElement;
      if (observedRoot) rootObserver.observe(observedRoot, { childList: true });
    }
    if (document.head !== observedHead) {
      headObserver.disconnect();
      observedHead = document.head;
      if (observedHead) headObserver.observe(observedHead, { childList: true, subtree: true, characterData: true });
    }
    enforce();
  }

  function unlock() {
    const wasLocked = lockedTitle !== null;
    enabled = false;
    documentObserver.disconnect();
    rootObserver.disconnect();
    headObserver.disconnect();
    observedRoot = null;
    observedHead = null;
    // Capture a site title written immediately before reset.
    if (wasLocked && document.title !== lockedTitle) originalTitle = document.title;
    lockedTitle = null;
    lastAppliedTitle = null;
    if (wasLocked) document.title = originalTitle;
  }

  function apply(record) {
    if (!record?.title) {
      unlock();
      return;
    }
    if (lockedTitle === null || document.title !== lockedTitle) originalTitle = document.title;
    lockedTitle = record.title;
    enabled = true;
    documentObserver.observe(document, { childList: true });
    refreshStructure();
  }

  async function sync() {
    const request = ++requestNumber;
    try {
      const response = await chrome.runtime.sendMessage({ type: "READ_OWN_NAME" });
      if (request !== requestNumber) return;
      if (response?.ok) apply(response.record);
    } catch {
      // An extension reload invalidates old content scripts; release the old lock.
      if (!chrome.runtime?.id) unlock();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SYNC_NAME") return;
    sync().then(() => sendResponse({ ok: true, title: lockedTitle }));
    return true;
  });

  // BFCache restores an existing document rather than running document_start again.
  window.addEventListener("pagehide", () => {
    ++requestNumber;
    unlock();
  });
  window.addEventListener("pageshow", () => sync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  globalThis.__tabNameLock = { sync };
  sync();
})();
