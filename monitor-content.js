(() => {
  if (globalThis.__tabStatusMonitor) { globalThis.__tabStatusMonitor.sync(); return; }
  const normalise = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  let record = null;
  let target = null;
  let sequence = 0;
  let requestNumber = 0;
  let output = Promise.resolve();
  let lastReport = "";
  let observer = null;
  let ui = null;
  let selection = null;
  let suspended = false;
  let syncTimer = null;
  let syncDelay = 250;

  async function request(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type, url: location.href, ...extra });
    if (!response?.ok) throw new Error(response?.error || "操作失败，请重新打开扩展重试。");
    return response;
  }

  function visible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none";
  }
  const textOf = element => visible(element) ? normalise(element.innerText).slice(0, 10000) : "";

  function allowed(element) {
    return element instanceof HTMLElement && element.getRootNode() === document && !element.closest("iframe, canvas, input, textarea, select, [contenteditable], video, audio")
      && !["HTML", "BODY", "SCRIPT", "STYLE"].includes(element.tagName) && !element.shadowRoot && visible(element);
  }

  function locate(locator) {
    if (!locator) return { status: "waiting", element: null };
    try {
      const matches = [...document.querySelectorAll(locator.selector)].filter(element => element !== ui?.host);
      if (matches.length > 1) return { status: "ambiguous", element: null };
      if (!matches.length) return { status: "waiting", element: null };
      if (matches[0].tagName.toLowerCase() !== locator.tag || !allowed(matches[0])) return { status: "ambiguous", element: null };
      return { status: "watching", element: matches[0] };
    } catch { return { status: "ambiguous", element: null }; }
  }

  function locatorFor(element) {
    const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
    const token = value => CSS.escape(value);
    const segment = node => {
      const tag = node.tagName.toLowerCase();
      for (const name of ["id", "data-testid", "data-test", "data-qa", "data-id", "name"]) {
        const value = node.getAttribute(name);
        if (value && value.length <= 120) {
          const candidate = `${tag}[${name}="${token(value)}"]`;
          if (unique(candidate)) return candidate;
        }
      }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [node];
      return siblings.length === 1 ? tag : `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`;
    };
    let path = "";
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      path = `${segment(node)}${path ? ` > ${path}` : ""}`;
      if (unique(path)) return { selector: path, tag: element.tagName.toLowerCase() };
    }
    throw new Error("无法唯一定位这个元素，请选择更小的状态文字区域。");
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    target = null;
    lastReport = "";
  }

  function report(status, values = [], reset = false) {
    if (!record || suspended || location.href !== record.activeUrl) return;
    const signature = JSON.stringify({ status, values, reset });
    if (signature === lastReport) return;
    lastReport = signature;
    const message = { version: record.version, epoch: record.epoch, url: location.href, sequence: ++sequence, status, values, reset };
    output = output.catch(() => {}).then(async () => {
      let delay = 250;
      // Keep the original sequence and text history until acknowledged. An accepted retry is deduplicated by the background.
      while (message.epoch === record?.epoch && !record.paused && location.href === message.url && !suspended) {
        try {
          const response = await request("MONITOR_OBSERVE", message);
          if (response.stale) { lastReport = ""; void sync(); }
          return;
        } catch (error) {
          if (!chrome.runtime?.id) throw error;
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 5000);
        }
      }
    }).catch(() => { lastReport = ""; if (!chrome.runtime?.id) { stop(); closeUI(); } });
  }

  function changed(mutations = [], initial = false) {
    if (!record || record.paused || suspended) return;
    if (location.href !== record.activeUrl) { stop(); void sync(); return; }
    const previous = target;
    const found = locate(record.locator);
    target = found.element;
    if (!target) { report(found.status); return; }
    const value = textOf(target);
    const relevant = mutations.filter(mutation => {
      if (mutation.target === ui?.host || ui?.host?.contains(mutation.target)) return false;
      if (previous?.contains(mutation.target) || target.contains(mutation.target)) return true;
      if (mutation.type === "attributes" && mutation.target.contains(target)) return true;
      return mutation.type === "childList" && [...mutation.removedNodes, ...mutation.addedNodes].some(node => node === previous || node.contains(previous) || node === target || node.contains(target));
    });
    if (!initial && !relevant.length && previous === target) return;
    let values = [value];
    let reset = false;
    // Attribute updates can accompany text changes (for example a status badge changing colour).
    // Re-read the visible text, but only content mutations participate in text-history reconstruction.
    const decorative = node => node.nodeType === Node.COMMENT_NODE || (node instanceof SVGElement && !node.querySelector("foreignObject"));
    const contentChanges = relevant.filter(change => change.type !== "attributes"
      && !(change.type === "childList" && [...change.addedNodes, ...change.removedNodes].every(decorative)));
    if (contentChanges.length > 1) {
      const node = contentChanges[0].target;
      const textChanges = contentChanges.every(change => change.type === "characterData" && change.target === node)
        && target.textContent === node.data && normalise(node.data) === value;
      const replacements = contentChanges.every(change => change.type === "childList" && change.target === target && change.addedNodes.length <= 1 && change.removedNodes.length <= 1
        && [...change.addedNodes, ...change.removedNodes].every(child => child.nodeType === Node.TEXT_NODE));
      if (textChanges) values = [...contentChanges.map(change => normalise(change.oldValue)), value];
      else if (replacements) values = [normalise(contentChanges[0].removedNodes[0]?.textContent), ...contentChanges.map(change => normalise(change.addedNodes[0]?.textContent))];
      else reset = true;
    }
    // Extremely busy/ambiguous batches establish a fresh baseline instead of inferring a transition.
    if (values.length > 1000) { values = [value]; reset = true; }
    report("watching", values, reset);
  }

  function apply(next) {
    const same = record?.version === next?.version && record?.epoch === next?.epoch;
    record = next;
    if (!record || record.paused || record.activeUrl !== location.href || suspended) { stop(); return; }
    if (same && observer) return;
    stop();
    if (!same) output = Promise.resolve();
    sequence = record.sequence || 0;
    observer = new MutationObserver(mutations => changed(mutations));
    observer.observe(document, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true });
    changed([], true);
  }

  async function sync() {
    clearTimeout(syncTimer);
    syncTimer = null;
    if (suspended) return;
    const number = ++requestNumber;
    try {
      const response = await request("MONITOR_READ_OWN");
      if (number === requestNumber && !suspended) { syncDelay = 250; apply(response.record); }
    } catch {
      if (number !== requestNumber || suspended) return;
      if (!chrome.runtime?.id) { stop(); closeUI(); return; }
      // A transient worker/channel failure must not disconnect an otherwise working DOM observer.
      if (record && location.href !== record.activeUrl) stop();
      syncTimer = setTimeout(() => { syncTimer = null; void sync(); }, syncDelay);
      syncDelay = Math.min(syncDelay * 2, 5000);
    }
  }

  function closeUI(cancel = true) {
    if (!ui) return;
    const old = ui;
    ui = null;
    selection = null;
    old.controller.abort();
    old.host.remove();
    if (cancel) request("MONITOR_CANCEL_PICK", { token: old.token }).catch(() => {});
  }

  function node(tag, attributes = {}, text = "") {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    element.textContent = text;
    return element;
  }

  function createUI(token, existing) {
    closeUI();
    const host = node("div", { "data-tab-status-ui": "" });
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = node("style", {}, `
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .shield { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
      .outline { position: fixed; border: 2px solid #7053A4; background: #7053A41A; pointer-events: none; border-radius: 3px; }
      .panel { --paper:#F7F5FA; --surface:#FFFFFF; --ink:#30263F; --muted:#746783; --accent:#7053A4; --line:#9686A7;
        position: fixed; right: 20px; top: 20px; width: min(324px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow: auto;
        padding: 18px; pointer-events: auto; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
        box-shadow: 0 8px 30px #201B2926; font: 13px/1.6 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
      h2 { margin: 0; font-size: 15px; font-weight: 600; } p { margin: 8px 0; }
      .caption { color: var(--muted); font-size: 11px; }
      .current { padding: 8px 10px; margin: 10px 0; background: var(--surface); border-radius: 5px; max-height: 76px; overflow: auto; overflow-wrap: anywhere; }
      label { display: block; margin: 8px 0 5px; font-size: 12px; }
      input { width: 100%; padding: 9px 10px; min-width: 0; border: 1px solid var(--line); border-radius: 6px; font: inherit; background: var(--surface); color: var(--ink); }
      button { min-height: 36px; padding: 7px 12px; background: var(--accent); color: #fff; border: 1px solid var(--accent); border-radius: 6px;
        font: 550 12px -apple-system, 'PingFang SC', sans-serif; cursor: pointer; }
      button.secondary { background: transparent; color: var(--muted); border-color: var(--line); }
      input:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .actions { display: flex; gap: 8px; margin-top: 14px; } .actions button:last-child { flex: 1; }
      .top { display: flex; justify-content: space-between; align-items: center; } .top button { background: transparent; border: 0; color: var(--muted); min-height: 28px; padding: 3px 5px; }
      .error { color: #B1374C; font-size: 12px; } .error:empty { display: none; } button:disabled { opacity: .5; cursor: default; }
      @media (prefers-color-scheme: dark) { .panel { --paper:#201B29; --surface:#2A2435; --ink:#F2EDF8; --muted:#B7ABC8; --accent:#C5A5F0; --line:#7E708D; }
        button { color:#2E1747; } .error { color:#FF9FB0; } .outline { border-color:#C5A5F0; background:#C5A5F026; } }
    `);
    const shield = node("div", { class: "shield" });
    const outline = node("div", { class: "outline", hidden: "" });
    const panel = node("section", { class: "panel", role: "dialog", "aria-label": "配置状态监听" });
    const top = node("div", { class: "top" });
    const heading = node("h2", {}, "选择状态元素");
    const cancel = node("button", { type: "button", "aria-label": "取消配置" }, "取消");
    top.append(heading, cancel);
    const hint = node("p", { class: "caption" }, "移动鼠标定位状态文字，点击选中。Esc 取消。");
    const form = node("form", { hidden: "" });
    const current = node("p", { class: "current", "aria-label": "元素当前文字" });
    const a = node("input", { id: "stateA", maxlength: "200", autocomplete: "off", placeholder: "例如：发布中" });
    const b = node("input", { id: "stateB", maxlength: "200", autocomplete: "off", placeholder: "例如：发布完成" });
    const actions = node("div", { class: "actions" });
    const reselect = node("button", { type: "button", class: "secondary" }, "重新选择");
    const save = node("button", { type: "submit" }, "开始监听");
    actions.append(reselect, save);
    form.append(current, node("label", { for: "stateA" }, "从状态 A"), a, node("label", { for: "stateB" }, "变为状态 B"), b,
      node("p", { class: "caption" }, "文字完全一致时匹配，每次 A → B 提醒一次。规则跟随当前标签页，换网址后自动寻找所选元素。"), actions);
    const error = node("p", { class: "error", role: "status", "aria-live": "polite" });
    panel.append(top, hint, form, error);
    shadow.append(style, shield, outline, panel);
    const controller = new AbortController();
    ui = { host, shadow, token, controller, picking: true, panel, outline };
    (document.documentElement || document).append(host);
    const on = (element, name, callback, options = {}) => element.addEventListener(name, callback, { ...options, signal: controller.signal });
    const showError = message => { error.textContent = message; };
    const draw = element => {
      if (!element) { outline.hidden = true; return; }
      const rect = element.getBoundingClientRect();
      outline.hidden = false;
      Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const hit = event => {
      host.style.setProperty("display", "none", "important");
      const element = document.elementFromPoint(event.clientX, event.clientY);
      host.style.setProperty("display", "block", "important");
      return element;
    };
    const choose = element => {
      if (!allowed(element)) { showError("请选择主页面里的状态文字。嵌入页面、组件内部和输入框暂不支持。"); return; }
      try {
        const locator = locatorFor(element);
        selection = { element, locator, url: location.href };
        ui.picking = false;
        shield.hidden = true;
        form.hidden = false;
        heading.textContent = "状态监听";
        hint.textContent = "只在下面两个状态依次出现时提醒。";
        current.textContent = textOf(element) || "（当前文字为空）";
        if (!existing) a.value = textOf(element).slice(0, 200);
        showError("");
        draw(element);
        b.focus();
      } catch (exception) { showError(exception.message); }
    };
    on(shield, "pointermove", event => { const element = hit(event); draw(allowed(element) ? element : null); });
    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) on(shield, eventName, event => { event.preventDefault(); event.stopImmediatePropagation(); });
    on(shield, "click", event => { event.preventDefault(); event.stopImmediatePropagation(); choose(hit(event)); });
    on(cancel, "click", () => closeUI());
    on(window, "keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeUI(); } }, { capture: true });
    on(window, "scroll", () => draw(selection?.element), { capture: true, passive: true });
    on(window, "resize", () => draw(selection?.element), { passive: true });
    on(reselect, "click", () => {
      ui.picking = true; selection = null; shield.hidden = false; form.hidden = true; outline.hidden = true;
      heading.textContent = "选择状态元素"; hint.textContent = "移动鼠标定位状态文字，点击选中。Esc 取消。"; showError("");
    });
    on(form, "submit", async event => {
      event.preventDefault();
      if (!selection || save.disabled) return;
      const stateA = normalise(a.value);
      const stateB = normalise(b.value);
      if (!stateA || !stateB || stateA === stateB) { showError("请填写两个不同的非空状态。"); return; }
      const found = locate(selection.locator);
      if (selection.url !== location.href || found.element !== selection.element) { showError("页面或元素已变化，请重新选择。"); return; }
      save.disabled = true;
      const activeUI = ui;
      try {
        const response = await request("MONITOR_SAVE", { token, stateA, stateB, locator: selection.locator, text: textOf(selection.element) });
        if (ui === activeUI) closeUI(false);
        ++requestNumber;
        apply(response.record);
      } catch (exception) { showError(exception.message); }
      finally { save.disabled = false; }
    });
    if (existing) {
      a.value = existing.stateA; b.value = existing.stateB; save.textContent = "保存规则";
      const found = locate(existing.locator);
      if (found.element) choose(found.element);
      else showError("原元素暂时找不到，请重新选择。取消可保留原规则。");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MONITOR_SYNC") {
      if (selection && selection.url !== location.href) closeUI();
      sync().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message?.type === "MONITOR_BEGIN_PICK") {
      try { createUI(message.token, message.record); sendResponse({ ok: true }); }
      catch (error) { closeUI(); sendResponse({ ok: false, error: error.message }); }
    }
  });
  window.addEventListener("pagehide", () => { suspended = true; ++requestNumber; clearTimeout(syncTimer); syncTimer = null; stop(); closeUI(); });
  window.addEventListener("pageshow", () => { suspended = false; void sync(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void sync(); });
  globalThis.__tabStatusMonitor = { sync };
  void sync();
})();
