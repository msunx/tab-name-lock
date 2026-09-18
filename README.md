<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="标签定名：名称绑定单个 Chrome 标签页，刷新和跳转保留，关闭即清除">
</p>

<p align="center">
  <strong>给当前标签页一个不会被网页改掉的名字。</strong><br>
  名称按标签页隔离，不按网址共享；支持 Emoji、纵向标签页和深色模式。
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#它解决了什么">工作方式</a> ·
  <a href="#权限与隐私">权限与隐私</a> ·
  <a href="#浏览器限制">浏览器限制</a>
</p>

## 实际效果

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/popup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme/popup-light.png">
    <img src="./assets/readme/popup-light.png" width="344" alt="标签定名扩展弹窗，包含 Emoji 选择、名称输入和保存操作">
  </picture>
</p>

## 它解决了什么

很多后台、文档和控制台拥有相同或不断变化的页面标题。标签定名把自定义名称绑定到 Chrome 的 `tab.id`：同一个网址打开多次也能分别命名，刷新、前进后退或跨域跳转不会串名。

```text
当前标签页 → 保存「🚀 生产环境」→ 刷新 / 跳转后继续显示
关闭标签页 → 删除本次名称
```

- **按标签页隔离**：不使用 URL、域名、窗口位置或原标题作为关联键。
- **名称保持稳定**：网页脚本、通知数量和 SPA 路由更新标题时，扩展会恢复自定义名称。
- **关闭即清除**：关闭标签页或整个窗口后，不再保留对应名称。
- **Emoji 前缀**：内置 96 个常用表情，也支持粘贴组合 Emoji。
- **界面适配**：支持 Chrome 横向、纵向标签页，以及浅色、深色模式。

## 安装

当前版本通过 Chrome 开发者模式加载：

```bash
git clone git@github.com:msunx/tab-name-lock.git
```

1. 打开 `chrome://extensions`。
2. 开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择克隆得到的 `tab-name-lock` 目录。
4. 将「标签定名」固定到工具栏，打开普通网页后即可使用。

macOS 默认快捷键为 <kbd>Option</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>。可在 `chrome://extensions/shortcuts` 中修改。

更新代码后，在扩展管理页点击「重新加载」，并刷新已打开的网页。重新加载扩展会开始新的命名会话。

## 使用

1. 打开需要辨认的标签页，点击扩展图标。
2. 输入名称；需要时从左侧选择 Emoji。
3. 点击「保存名称」。之后在当前标签页中刷新或换网址，名称仍会保留。
4. 点击「恢复原标题」可提前清除；直接关闭标签页也会自动清除。

## 行为边界

| 操作 | 结果 |
| --- | --- |
| 刷新、前进后退、换网址或域名 | 保留当前标签页的名称 |
| 同一网址打开多个标签页 | 分别命名，互不影响 |
| 标签页移动到另一个 Chrome 窗口 | 名称跟随标签页移动 |
| 复制标签页或重新打开相同网址 | 新标签页不继承名称 |
| 关闭标签页或包含它的窗口 | 删除名称 |
| 完全退出并重启 Chrome | 开始新的命名会话 |

## 权限与隐私

扩展没有账号、服务器、分析统计或远程代码。名称只保存在浏览器内存中的 `chrome.storage.session`，不会同步到其他设备，浏览器重启后会清空。

| 权限 | 用途 |
| --- | --- |
| `storage` | 在当前浏览器会话中保存标签页名称 |
| `tabs` | 识别标签页 ID，响应跳转、移动和关闭事件 |
| `scripting` | 为已经打开的网页补充标题保持脚本 |
| `http://*/*`、`https://*/*` | 换网址后继续维持当前标签页名称 |

## 浏览器限制

- Chrome 不允许普通扩展修改 `chrome://` 页面、新标签页、扩展商店、其他扩展页面及部分内置查看器的标题。回到普通 HTTP/HTTPS 网页后，已保存名称会继续生效。
- Chrome 没有直接设置原生标签标题的扩展 API，本项目通过网页的 `document.title` 实现。导航开始到内容脚本运行之间，可能短暂显示网址或网页原标题。
- 当前版本不处理 `file://` 本地文件。
- 若把网站访问权限改成「点击时允许」，跨网站跳转后的自动保持会受到限制。

## 开发与验证

扩展使用 Manifest V3 和原生 JavaScript，运行本身不需要构建步骤。浏览器验收使用 Playwright：

```bash
npm install
npx playwright install chromium
npm run verify:browser
npm run verify:popup
```

`verify:browser` 覆盖同网址隔离、刷新与跨域跳转、动态标题、跨窗口移动、关闭清理和浏览器重启；`verify:popup` 会打开真实工具栏弹窗，检查高度、Emoji 滚动区域和保存操作。

项目结构：

```text
├── manifest.json       # 扩展清单与权限
├── background.js       # 标签页生命周期与会话数据
├── content.js          # 页面标题保持
├── naming.js           # 名称与 Emoji 处理
├── popup.*             # 工具栏弹窗
├── icons/              # 扩展图标
└── scripts/            # 浏览器验收脚本
```
