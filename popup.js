import { isSingleEmoji } from "./naming.js";

const ids = ["form", "name", "save", "reset", "status", "hint", "emojiToggle", "emojiPicker", "emojiGrid", "emojiCustom", "emojiApply", "emojiClear"];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const choices = [
  ["🚀", "火箭"], ["💼", "公文包"], ["🛠️", "工具"], ["🧪", "实验"], ["📊", "图表"], ["📝", "笔记"], ["📚", "书籍"], ["💡", "灵感"],
  ["🔴", "红色圆点"], ["🟠", "橙色圆点"], ["🟡", "黄色圆点"], ["🟢", "绿色圆点"], ["🔵", "蓝色圆点"], ["🟣", "紫色圆点"], ["⭐", "星星"], ["📌", "图钉"],
  ["✅", "完成"], ["⚠️", "注意"], ["🔥", "火焰"], ["🎯", "目标"], ["💬", "聊天"], ["🎨", "设计"], ["☕", "咖啡"], ["🏠", "主页"],
  ["😀", "笑脸"], ["😄", "开心"], ["😁", "大笑"], ["😂", "笑哭"], ["😊", "微笑"], ["😎", "酷"], ["🤓", "书呆子"], ["🥳", "庆祝"],
  ["😍", "喜欢"], ["🤔", "思考"], ["😴", "睡觉"], ["🤯", "震惊"], ["😅", "汗颜"], ["😇", "天使"], ["🤩", "惊喜"], ["🥰", "幸福"],
  ["👍", "赞"], ["👎", "不赞"], ["👏", "鼓掌"], ["🙌", "欢呼"], ["🤝", "握手"], ["💪", "加油"], ["✌️", "胜利"], ["👌", "好的"],
  ["❤️", "红心"], ["💛", "黄心"], ["💚", "绿心"], ["💙", "蓝心"], ["💜", "紫心"], ["🖤", "黑心"], ["🤍", "白心"], ["💖", "闪亮的心"],
  ["💻", "电脑"], ["🖥️", "显示器"], ["⌨️", "键盘"], ["🖱️", "鼠标"], ["📱", "手机"], ["🧩", "拼图"], ["🔧", "扳手"], ["⚙️", "设置"],
  ["🔒", "锁"], ["🔑", "钥匙"], ["🛡️", "盾牌"], ["🗂️", "分类"], ["📁", "文件夹"], ["📂", "打开的文件夹"], ["📎", "附件"], ["🏷️", "标签"],
  ["🐱", "猫"], ["🐶", "狗"], ["🐼", "熊猫"], ["🦊", "狐狸"], ["🌱", "幼苗"], ["🌿", "树叶"], ["🌸", "花"], ["🌈", "彩虹"],
  ["🌍", "地球"], ["🌙", "月亮"], ["☀️", "太阳"], ["🌊", "海浪"], ["🏔️", "山"], ["✈️", "飞机"], ["🚗", "汽车"], ["🚲", "自行车"],
  ["🍎", "苹果"], ["🍋", "柠檬"], ["🍉", "西瓜"], ["🍕", "披萨"], ["🍜", "面条"], ["🍰", "蛋糕"], ["🥤", "饮料"], ["🍺", "啤酒"]
];
let tabId = null;
let currentName = "";
let selectedEmoji = "";
let supported = false;
let busy = false;
const monitorIds = ["monitor", "monitorBadge", "monitorRule", "monitorCurrent", "monitorPick", "monitorPause", "monitorDelete", "monitorTest", "monitorStatus"];
const monitorElements = Object.fromEntries(monitorIds.map(id => [id, document.getElementById(id)]));
let monitorRecord = null;
let monitorSupported = false;
let monitorBusy = false;
let monitorRead = 0;

function status(text, error = false) {
  elements.status.textContent = text;
  elements.status.classList.toggle("error", error);
}

function render() {
  const name = elements.name.value.trim();
  const editable = !busy && tabId !== null && (supported || Boolean(currentName));
  elements.save.disabled = !editable || !name;
  elements.reset.disabled = busy || !currentName;
  elements.name.disabled = !editable;
  elements.emojiToggle.disabled = !editable;
  elements.emojiToggle.textContent = selectedEmoji || "表情";
  elements.emojiToggle.classList.toggle("has-emoji", Boolean(selectedEmoji));
  elements.emojiToggle.title = selectedEmoji ? `更换表情：${selectedEmoji}` : "选择名称前的表情";
  for (const button of elements.emojiGrid.children) {
    button.setAttribute("aria-pressed", String(button.value === selectedEmoji));
    button.disabled = !editable;
  }
  elements.emojiCustom.disabled = !editable;
  elements.emojiApply.disabled = !editable;
  elements.emojiClear.disabled = !editable;
  elements.save.textContent = currentName ? "更新名称" : "保存名称";
}

function togglePicker(open) {
  elements.emojiPicker.hidden = !open;
  elements.emojiToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    elements.emojiCustom.value = selectedEmoji;
    const selected = elements.emojiGrid.querySelector('[aria-pressed="true"]');
    elements.emojiGrid.scrollTop = 0;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
      selected.focus({ preventScroll: true });
    }
  }
}

function chooseEmoji(value) {
  selectedEmoji = value;
  togglePicker(false);
  status("");
  render();
  elements.name.focus();
}

function useCustomEmoji() {
  const value = elements.emojiCustom.value.trim();
  if (!isSingleEmoji(value)) {
    status("请粘贴一个完整的 Emoji，例如 🚀 或 👩🏽‍💻。", true);
    elements.emojiCustom.focus();
    return;
  }
  chooseEmoji(value);
}

for (const [emoji, label] of choices) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "emoji-option";
  button.value = emoji;
  button.textContent = emoji;
  button.title = label;
  button.setAttribute("aria-label", `${emoji} ${label}`);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => chooseEmoji(emoji));
  elements.emojiGrid.append(button);
}

async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!response?.ok) throw new Error(response?.error || "操作未完成，请重新打开弹窗。");
  return response;
}

async function initialise() {
  try {
    // Capture the original tab once. Do not target whichever tab becomes active later.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("未找到当前标签页。");
    tabId = tab.id;
    const result = await request("INSPECT_TAB");
    currentName = result.title;
    selectedEmoji = result.emoji;
    supported = result.supported;
    elements.name.value = result.name;
    await inspectMonitor(true);
    if (!supported) status(currentName ? "名称仍保留；回到普通网页后自动生效。" : "Chrome 不允许扩展修改此页面的标题。", !currentName);
    render();
    if (!elements.name.disabled) {
      elements.name.focus();
      elements.name.select();
    }
  } catch (error) {
    tabId = null;
    status(error.message, true);
    render();
  }
}

function renderMonitor() {
  const labels = { watching: "监听中", waiting: "等待元素", ambiguous: "需重新选择", paused: "已暂停" };
  monitorElements.monitorBadge.textContent = monitorRecord ? labels[monitorRecord.status] || "等待元素" : "未配置";
  monitorElements.monitorRule.hidden = !monitorRecord;
  monitorElements.monitorRule.textContent = monitorRecord ? `${monitorRecord.stateA} → ${monitorRecord.stateB}` : "";
  const descriptions = { paused: "已暂停，继续时从当前状态重新开始。", waiting: "等待当前页面的目标元素，找到后继续监听。", ambiguous: "目标元素无法唯一定位，请重新选择。" };
  monitorElements.monitorCurrent.textContent = monitorRecord ? !monitorSupported ? "当前页面不支持监听，回到普通网页后自动寻找元素。"
    : descriptions[monitorRecord.status] || `当前：${monitorRecord.lastText || "（空文字）"}`
    : monitorSupported ? "选择网页中的状态文字，指定 A → B 后接收提醒。" : "当前页面不支持选择元素，请打开普通网页。";
  monitorElements.monitorPick.textContent = monitorRecord ? "编辑规则" : "选择元素";
  monitorElements.monitorPick.disabled = monitorBusy || !monitorSupported;
  monitorElements.monitorPause.hidden = monitorElements.monitorDelete.hidden = !monitorRecord;
  monitorElements.monitorPause.textContent = monitorRecord?.paused ? "继续" : "暂停";
  monitorElements.monitorPause.disabled = monitorElements.monitorDelete.disabled = monitorBusy || !monitorRecord;
  monitorElements.monitorTest.disabled = monitorBusy || tabId === null;
}

async function inspectMonitor(first = false) {
  const number = ++monitorRead;
  const result = await request("MONITOR_INSPECT");
  if (number !== monitorRead) return;
  monitorRecord = result.record;
  monitorSupported = result.supported;
  if (first && monitorRecord) monitorElements.monitor.open = true;
  if (monitorRecord?.notificationError) {
    monitorElements.monitorStatus.textContent = monitorRecord.notificationError;
    monitorElements.monitorStatus.classList.add("error");
  }
  renderMonitor();
}

async function monitorAction(operation) {
  if (monitorBusy || tabId === null) return;
  monitorBusy = true;
  monitorElements.monitorStatus.textContent = "";
  monitorElements.monitorStatus.classList.remove("error");
  renderMonitor();
  try { await operation(); }
  catch (error) { monitorElements.monitorStatus.textContent = error.message; monitorElements.monitorStatus.classList.add("error"); }
  finally { monitorBusy = false; renderMonitor(); }
}

monitorElements.monitorPick.addEventListener("click", () => monitorAction(async () => {
  await request("MONITOR_START_PICK", { edit: Boolean(monitorRecord) });
  window.close();
}));
monitorElements.monitorPause.addEventListener("click", () => monitorAction(async () => {
  await request("MONITOR_PAUSE", { paused: !monitorRecord.paused });
  await inspectMonitor();
}));
monitorElements.monitorDelete.addEventListener("click", () => monitorAction(async () => {
  await request("MONITOR_DELETE");
  await inspectMonitor();
}));
monitorElements.monitorTest.addEventListener("click", () => monitorAction(async () => {
  await request("MONITOR_TEST");
  monitorElements.monitorStatus.textContent = "测试通知已发送。若未显示，请检查系统的 Chrome 通知与专注模式设置。";
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[`tab-monitor:${tabId}`]) inspectMonitor().catch(() => {});
});

elements.emojiToggle.addEventListener("click", () => togglePicker(elements.emojiPicker.hidden));
elements.emojiClear.addEventListener("click", () => chooseEmoji(""));
elements.emojiApply.addEventListener("click", useCustomEmoji);
elements.emojiCustom.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    useCustomEmoji();
  }
});
elements.emojiPicker.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    togglePicker(false);
    elements.emojiToggle.focus();
  }
});
elements.name.addEventListener("input", () => { status(""); render(); });
elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements.save.disabled) return;
  busy = true;
  togglePicker(false);
  render();
  try {
    const result = await request("SAVE_NAME", { name: elements.name.value, emoji: selectedEmoji });
    currentName = result.title;
    selectedEmoji = result.emoji;
    elements.name.value = result.name;
    status(result.applied ? "已保存，刷新或换网址都保留。" : "名称已保存；普通网页加载完成后生效。");
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    render();
  }
});

elements.reset.addEventListener("click", async () => {
  if (elements.reset.disabled) return;
  busy = true;
  togglePicker(false);
  render();
  try {
    await request("CLEAR_NAME");
    currentName = "";
    selectedEmoji = "";
    elements.name.value = "";
    status("已恢复网页原标题。");
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    render();
  }
});

initialise();
