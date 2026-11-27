# 实现方案：名片底部署名与「想要同款？」引导（v1.8）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文、`docs/plans/share-card.md` 和根目录的 `AGENTS.md`，再动手。
> **在 `share-card.md` 全部完成（含第八、九节）之后再做本方案。** 本方案复用其中的署名常量（`web/src/lib/brand.js`）、来源参数和名片底部布局。
> `docs/plans/branding-sponsor.md` 已暂缓，**不要实现**；本方案的「隐藏署名」开关对所有人免费开放，不需要兑换码。

## 目标

让每张名片都成为 RosePanel 的入口：访客看到别人的名片，点一下「想要同款？」，就能看到简单易懂的部署引导。

```
看到分享海报 → 扫码打开名片 → 点「想要同款？」→ 看引导 → 去部署
```

## 一、名片底部署名

在名片页（`web/src/components/TicketTab.jsx`）内容的最下方加一行：

```
Made with RosePanel 🌹 · 想要同款？
```

- 样式：字号 11px，颜色用主题的次要文字色，透明度 50%，居中。「想要同款？」用主题强调色，可以点击。整行**不能抢名片主体的视觉重点**。
- 点击「Made with RosePanel 🌹」，和点「想要同款？」一样，打开引导弹窗，不直接跳去 GitHub。
- 如果 `share-card.md` 第九节的「本月访客数」开着，访客数放在这一行的**上方**。
- 文字统一从 `web/src/lib/brand.js` 读取，不要写死。

### 谁能看到

| 情况 | 显示署名行吗 |
| :--- | :--- |
| 访客打开名片 | 显示（除非站长关掉了） |
| **站长或管理员打开自己的名片**（`isAdmin`） | **不显示**，免得自己看着烦 |
| 站长在设置里预览名片 | 显示一个半透明的示意，旁边标「访客可见」，让站长知道访客看到的样子 |

## 二、「想要同款？」引导弹窗

新增组件 `web/src/components/GetSameCardModal.jsx`，样式沿用 `WhatsNewModal.jsx` 的弹窗风格。

### 内容（从上到下）

1. **标题**：`🌹 做一张属于你的名片`
2. **一句话介绍**：「在 Telegram 里拥有自己的个人名片、私信助手和节点探针，免费部署在 Cloudflare 上。」
3. **三个亮点**（每个一行，配 `lucide-react` 图标）：
   - 玫瑰瓷风格的个人名片和分享海报
   - 带四层防骚扰的私信助手
   - 支持 Komari、哪吒等探针的节点面板
4. **需要准备**：一个 Telegram 账号、一个免费的 Cloudflare 账号、一个 GitHub 账号。下面加粗一行：**不需要服务器，也不用写代码**。
5. **大概需要**：约 10 分钟，建议在电脑上操作。
6. **按钮**：
   - 主按钮「查看部署教程」：用 `openExternalUrl` 打开 `DEPLOY_GUIDE_URL`。
   - 次按钮「复制教程链接」：复制 `DEPLOY_GUIDE_URL`，toast 提示「已复制，可以在电脑上打开」。手机上看到名片的人多，回到电脑上部署更方便。
   - 右上角关闭按钮。

### 链接常量

在 `web/src/components/WhatsNewModal.jsx` 里和 `REPO_URL` 放在一起：

```js
export const DEPLOY_GUIDE_URL = 'https://github.com/mango0114/rose-panel-bot#<极简部署一节的锚点>';
```

- 锚点指向 README 的「🚀 极简部署（5 分钟免费上线）」一节。标题里带表情和全角括号，GitHub 生成的锚点不好猜，**实现时要在 GitHub 上实际点一下这个标题，复制浏览器地址栏里的锚点**，不要凭猜测写。确认不了时，先直接用 `REPO_URL`。
- 不要在链接后面加跟踪参数。GitHub 仓库的 Insights → Traffic 会自动列出来源网站，站长从那里就能看到有多少人是从别人的名片过来的。

### 文案语言

跟随现有界面，用中文。不需要做多语言。

## 三、站长开关

`DEFAULT_CONFIG.profile` 新增：

```js
showPoweredBy: true,   // 名片底部是否显示「Made with RosePanel · 想要同款？」，默认显示
```

- 设置页「名片资料」分区加一个开关：「在名片底部显示 RosePanel 署名」，下面一行说明：「署名能帮助更多人发现 RosePanel，感谢你的支持 🌹」。
- 关闭后，名片底部的署名行和「想要同款？」一起隐藏。
- **这个开关只管名片底部这一行。** 分享海报底部的 `Made with RosePanel 🌹` 和链接预览的 `og:site_name` 按 `share-card.md` 的规定固定显示，不受影响。
- 公开配置里返回 `showPoweredBy`（布尔值，不含敏感信息）。
- 旧部署升级后 KV 里没有这个字段，取默认值 `true`。

## 四、文档

- `CHANGELOG.md`（v1.8.0 未发布条目）和 `WhatsNewModal.jsx`：「名片底部新增 RosePanel 小字署名和『想要同款？』引导，可在设置里关闭」。
- `README.md` 和 `README_EN.md`：在名片功能介绍里提一句，并说明可以在设置里关闭。

## 五、测试

`tests/worker.test.js`：

1. 默认配置下，公开配置里 `showPoweredBy` 为 `true`。
2. 保存 `showPoweredBy: false` 后，公开配置里为 `false`；非布尔值会被规范成布尔值。
3. 旧配置（KV 里没有这个字段）加载后为 `true`。

前端手动验证：

- 访客打开名片：底部能看到署名行，点击弹出引导；「查看部署教程」能打开正确的 README 位置；「复制教程链接」能复制。
- 站长打开自己的名片：看不到署名行。
- 关闭开关后，访客看不到署名行；分享海报的底部小字仍然在。
- 浅色、深色主题下，署名行都足够低调，引导弹窗的文字清晰。
- 名片首屏的包体积没有明显增加：引导弹窗用 `React.lazy` 按需加载。

**验收**：`npm test && npm run build` 全部通过。

## 六、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `web/src/components/TicketTab.jsx` | 名片底部署名行，按 `isAdmin` 和 `showPoweredBy` 控制显示 |
| `web/src/components/GetSameCardModal.jsx` | 新增，引导弹窗（按需加载） |
| `web/src/components/WhatsNewModal.jsx` | `DEPLOY_GUIDE_URL` 常量和更新说明 |
| `web/src/components/SettingsDrawer.jsx` | 「在名片底部显示 RosePanel 署名」开关 |
| `web/src/lib/brand.js` | 复用署名文字常量 |
| `src/worker/config.js` | `profile.showPoweredBy` 默认值、规范化、公开返回 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`WhatsNew`、`README`、`README_EN` |
