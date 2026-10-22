const ids = ["settingsToggle", "homeView", "settingsView", "barkForm", "barkUrl", "barkEnabled", "barkSave", "barkTest", "barkClear", "barkReveal", "barkStatus",
  "barkUpdateHelp", "barkOpenExtensions"];
const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
let config = null;
let busy = false;

function status(message, error = false) {
  elements.barkStatus.textContent = message;
  elements.barkStatus.classList.toggle("error", error);
}

function render() {
  const disabled = busy || config === null;
  elements.barkUrl.disabled = elements.barkEnabled.disabled = elements.barkReveal.disabled = disabled;
  elements.barkSave.disabled = elements.barkTest.disabled = disabled || !elements.barkUrl.value.trim();
  elements.barkClear.disabled = disabled || !config?.url;
  elements.barkOpenExtensions.disabled = busy;
}

async function request(type, extra = {}) {
  elements.barkUpdateHelp.hidden = true;
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  // An unpacked extension can load new popup files while its worker still runs the old message router.
  if (!response?.ok && ["标签页已失效，请重新打开弹窗。", "无法识别此操作。"].includes(response?.error)) {
    elements.barkUpdateHelp.hidden = false;
    throw new Error("扩展后台尚未更新，请在扩展管理页重新加载「标签定名」，再打开设置。");
  }
  if (!response?.ok) throw new Error(response?.error || "操作未完成，请重新打开设置重试。");
  return response;
}

function hideLink() {
  elements.barkUrl.type = "password";
  elements.barkReveal.textContent = "显示";
  elements.barkReveal.setAttribute("aria-pressed", "false");
  elements.barkReveal.setAttribute("aria-label", "显示推送链接");
}

function fill(next) {
  config = next;
  elements.barkUrl.value = config.url;
  elements.barkEnabled.checked = config.url ? config.enabled : true;
  hideLink();
}

async function action(operation) {
  if (busy) return;
  busy = true;
  status("");
  render();
  try { await operation(); }
  catch (error) { status(error.message, true); }
  finally { busy = false; render(); }
}

function toggle(open) {
  elements.homeView.hidden = open;
  elements.settingsView.hidden = !open;
  elements.settingsToggle.textContent = open ? "返回" : "设置";
  elements.settingsToggle.setAttribute("aria-expanded", String(open));
  hideLink();
  window.scrollTo(0, 0);
  if (!open) { elements.settingsToggle.focus(); return; }
  if (config !== null) { elements.barkUrl.focus(); return; }
  void action(async () => {
    fill((await request("BARK_READ")).config);
    status(config.url ? config.enabled ? "已开启 Bark 同步推送。" : "Bark 同步已停用，配置仍保留。" : "未配置，仅发送桌面通知。");
  }).then(() => { if (!elements.settingsView.hidden) elements.barkUrl.focus(); });
}

elements.settingsToggle.addEventListener("click", () => toggle(elements.settingsView.hidden));
elements.settingsView.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); toggle(false); }
});
elements.barkUrl.addEventListener("input", () => { status(""); render(); });
elements.barkEnabled.addEventListener("change", () => status("点击保存配置后生效。"));
elements.barkReveal.addEventListener("click", () => {
  if (elements.barkUrl.type === "text") hideLink();
  else {
    elements.barkUrl.type = "text";
    elements.barkReveal.textContent = "隐藏";
    elements.barkReveal.setAttribute("aria-pressed", "true");
    elements.barkReveal.setAttribute("aria-label", "隐藏推送链接");
  }
});
elements.barkForm.addEventListener("submit", event => {
  event.preventDefault();
  if (elements.barkSave.disabled) return;
  void action(async () => {
    fill((await request("BARK_SAVE", { url: elements.barkUrl.value, enabled: elements.barkEnabled.checked })).config);
    status(config.enabled ? "已保存，状态变化会同步推送到 Bark。" : "已停用 Bark 同步，配置仍保留。");
  });
});
elements.barkTest.addEventListener("click", () => {
  if (elements.barkTest.disabled) return;
  void action(async () => {
    status("正在发送测试推送…");
    await request("BARK_TEST", { url: elements.barkUrl.value });
    status("Bark 已接收测试推送，请查看手机或手表。配置修改后记得保存。");
  });
});
elements.barkClear.addEventListener("click", () => {
  if (elements.barkClear.disabled) return;
  void action(async () => { fill((await request("BARK_CLEAR")).config); status("已清除 Bark 配置，仅发送桌面通知。"); });
});
elements.barkOpenExtensions.addEventListener("click", () => {
  void action(async () => {
    await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    window.close();
  });
});
