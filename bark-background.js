const CONFIG_KEY = "bark-notification-config";
const accessReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
// Read access is restricted before credentials are loaded or written. Never expose the config to content scripts.
accessReady.catch(() => {});
let changes = Promise.resolve();
class BarkRequestError extends Error {}

function parseUrl(value) {
  const input = typeof value === "string" ? value.trim().replace(/^(["'])(.*)\1$/u, "$2") : "";
  let url;
  try { url = new URL(input); } catch { throw new Error("请粘贴 Bark JSON 示例中的 HTTPS 链接，不要粘贴整段命令。"); }
  if (input.length > 2048 || /\s/u.test(input) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("请使用不带查询参数、账号或密码的 HTTPS 推送链接。");
  }
  const parts = url.pathname.replace(/\/$/u, "").split("/").slice(1);
  if (!parts.length || parts.some(part => !/^[a-zA-Z0-9_-]+$/u.test(part)) || parts.at(-1) === "push" || (url.hostname === "api.day.app" && parts.length !== 1)) {
    throw new Error("链接应以设备 Key 结尾，例如 https://api.day.app/你的Key；不要附加推送正文。");
  }
  url.pathname = `/${parts.join("/")}`;
  return url.href;
}

async function readConfig() {
  await accessReady;
  await changes;
  return (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || { url: "", enabled: false };
}

function changeConfig(operation) {
  const next = changes.then(async () => { await accessReady; return operation(); });
  changes = next.catch(() => {});
  return next;
}

async function push(url, title, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ title, body, group: "标签定名" }),
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal
    });
    if (!response.ok) throw new BarkRequestError(`服务返回 HTTP ${response.status}，请检查推送地址。`);
    let data;
    try { data = await response.json(); } catch { throw new BarkRequestError("服务返回格式不正确，请检查 Bark 推送地址。"); }
    if (data?.code !== 200) throw new BarkRequestError("Bark 未接受推送，请检查设备 Key 和服务状态。");
    return { sent: true };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时，请检查网络后重试。");
    // Network errors and provider responses may contain credentials. Only return our own fixed messages.
    if (error instanceof BarkRequestError) throw error;
    throw new Error("连接失败，请检查网络和 HTTPS 推送地址。");
  } finally { clearTimeout(timeout); }
}

export async function sendBarkNotification(title, body) {
  const config = await readConfig();
  if (!config.enabled || !config.url) return { sent: false };
  return push(parseUrl(config.url), title, body);
}

export async function handleBarkMessage(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("请从扩展设置操作。");
  if (message.type === "BARK_READ") return { config: await readConfig() };
  if (message.type === "BARK_SAVE") {
    const config = { url: parseUrl(message.url), enabled: Boolean(message.enabled) };
    await changeConfig(() => chrome.storage.local.set({ [CONFIG_KEY]: config }));
    return { config };
  }
  if (message.type === "BARK_CLEAR") {
    await changeConfig(() => chrome.storage.local.remove(CONFIG_KEY));
    return { config: { url: "", enabled: false } };
  }
  if (message.type === "BARK_TEST") return push(parseUrl(message.url), "标签定名 · 测试通知", "Bark 通知配置测试。收到此消息后，即可保存配置并开启状态同步推送。");
  throw new Error("无法识别此操作。");
}
