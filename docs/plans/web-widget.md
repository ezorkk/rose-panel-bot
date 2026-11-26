# 实现方案：网页留言挂件（v1.9）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> 本方案建立在 v1.7 的 `src/worker/inbox.js`（`resolveInboxMode`、`deliverVisitorMessage`、`pushToOwner`、`dmmap`）之上，请在 v1.7 合并之后实现。

## 目标

站长在自己的个人小站上加一行代码，右下角就会出现一个「给我留言」气泡。访客**不需要 Telegram**，直接在网页上发消息，站长在 Telegram（通知群话题或 Bot 私聊）里收到并回复，访客在网页上看到回复。

- **整个模块默认关闭**；没有配置 Turnstile（`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET`）时**无法开启**。
- 站长这一端的体验不变：网页访客和 Telegram 访客出现在同一个访客列表里，回复、撤回、拉黑的操作方式完全一样。
- **v1 只支持文字**，不支持访客上传图片或文件。站长发给网页访客的图片可以显示。
- **不用 Durable Objects**：访客打开挂件期间定时拉取新回复（准实时，延迟几秒到一分钟）。

### 嵌入方式

```html
<script src="https://<你的面板域名>/widget.js" defer></script>
```

## 一、整体结构

```
个人小站页面
  └─ widget.js（几 KB，原生 JS）：画一个悬浮气泡，点开后加载 iframe
       └─ iframe：https://<面板域名>/widget（独立的小页面）
            ├─ POST /api/widget/session   ← Turnstile 验证，换取会话令牌
            ├─ POST /api/widget/message   → deliverVisitorMessage（channel: 'web'）
            └─ GET  /api/widget/messages  ← 定时拉取站长回复
```

**用 iframe 的原因**：

1. 挂件页面和 API 同源，**不需要开放跨域（CORS）**。
2. 挂件样式和宿主网页互相隔离，不会被对方的 CSS 影响。
3. 能用 `Content-Security-Policy: frame-ancestors` 限制**只有站长指定的域名能嵌入**。

## 二、访客身份和 `channel` 字段

### 访客 ID

- 网页访客的 ID 格式为 `w` + 16 位小写十六进制，例如 `w3f9a0c1b2d4e5f67`。服务端用 `crypto.getRandomValues` 生成。
- `src/worker/visitors.js` 导出共享的校验函数：

  ```js
  export const VISITOR_ID_RE = /^(?:\d+|w[0-9a-f]{16})$/;
  export const isWebVisitorId = (id) => /^w[0-9a-f]{16}$/.test(String(id));
  ```

- 现在代码里大约有 23 处写死了 `/^\d+$/` 或路由里的 `(\d+)`，**逐个过一遍**，分成两类处理：

| 类型 | 处理 | 位置（示例） |
| :--- | :--- | :--- |
| 访客数据读写（KV 记录、聊天历史、面板接口路由） | 换成 `VISITOR_ID_RE` | `visitors.js` 的 `recordVisitorExchange`、`getVisitorHistory`、`clearVisitorHistory`、`applyVisitorAction`、`recallAdminVisitorMessage`、访客索引；`api.js` 的 `/api/admin/visitors/:id/*` 各路由；`inbox.js` 的 `saveDmMessageMap`、`lookupDmMessageMap` |
| 必须调用 Telegram 的地方（头像代理、CAS 黑名单、`tg://user` 链接、给访客发消息、撤回访客那边的消息） | **保持只接受纯数字**，网页访客走单独分支 | `telegram.js` 的 `handleAvatarProxy`、`antispam.js` 的 CAS 检查、`api.js` 的 `/api/avatar/:id`、`bot.js` 和 `inbox.js` 里生成 `tg://user` 链接的地方 |

### `channel` 字段

- 访客记录 `user:{id}` 新增 `channel: 'tg' | 'web'`。**旧记录没有这个字段，一律按 `'tg'` 处理**，不需要迁移数据。
- 网页访客记录额外保存：`nickname`（选填，最多 32 字）、`contact`（选填的邮箱或 Telegram 用户名，最多 64 字）、`sourcePage`（第一次发消息时所在的页面地址，只保留域名和路径）。

## 三、后端改动

### 1. 新增 `src/worker/widget.js`

#### `POST /api/widget/session`：创建会话

- 请求体：`{ turnstileToken, nickname?, contact? }`。
- 用 `src/worker/turnstile.js` 现有的 `verifyTurnstileToken(secret, token, remoteIp)` 验证，`remoteIp` 取请求头 `CF-Connecting-IP`。
- 校验通过后生成访客 ID，签发会话令牌：`{ vid, exp }` 用 HMAC-SHA256 签名，密钥从 `WEBHOOK_SECRET` 派生（例如 `HMAC(WEBHOOK_SECRET, 'widget-session')`），有效期 30 天。复用 `src/worker/auth.js` 里现有的 HMAC 工具函数。
- 已经持有有效令牌的访客重新打开挂件时，**不需要再验证**，直接用原来的令牌。
- **这一步不创建访客记录**，访客发出第一条消息时才创建。这样只打开不说话的访客不会塞满访客列表。

#### `POST /api/widget/message`：发消息

- 请求头带令牌（`Authorization: Bearer <token>`），请求体 `{ text }`。
- 依次检查（任何一步不通过都直接拒绝，返回友好的错误提示）：
  1. 模块已开启，令牌签名和有效期正确。
  2. 访客没有被拉黑（`banned:{vid}`），会话没有被关闭（`closed`）。
  3. 文字长度 1 至 1000 字。
  4. 频率限制（复用 `checkRateLimit`）：**每个访客每分钟 6 条**，**每个 IP 每分钟 10 条、每天 100 条**。
  5. **全站每天的网页消息总量上限**（默认 300 条，可在设置里调整），用来保护 KV 免费额度。到上限后提示「今日留言已满，请明天再来或通过 Telegram 联系」。
  6. 屏蔽词和风险检测：复用 `antispam.js` 的屏蔽词规则；命中直接丢弃，并调用 `recordBlockedSpam`。
- 通过后，构造一个**和 Telegram 消息形状相同的对象**交给 `deliverVisitorMessage`：

  ```js
  {
    channel: 'web',
    from: { id: vid, first_name: nickname || `网页访客 #${vid.slice(-4)}` },
    text,
    message_id: null,   // 网页消息在 Telegram 里没有对应的消息编号
    chat: null,
  }
  ```

#### `GET /api/widget/messages?since=<ISO 时间>`：拉取回复

- 读取 `history:{vid}`（**v1.7 已有的聊天记录，最多 60 条**），返回 `since` 之后的消息。
- 只返回挂件需要的字段：发送方、文字、时间、图片的**签名地址**（复用 `signMediaToken`）。被站长撤回的消息不会出现在列表里。
- 每次请求只读 1 次 KV，**不写入**。

#### `GET /widget`

- 返回挂件页面，并加上响应头 `Content-Security-Policy: frame-ancestors <允许嵌入的域名列表>`。
- 需要把 `/widget` 加进 `wrangler.toml` 的 `run_worker_first`，否则静态资源会直接返回、不经过 Worker 加响应头。

### 2. 修改 `src/worker/inbox.js`

现在的 `deliverVisitorMessage` 和 `pushToOwner` 都用 `copyMessage` 从访客的 Telegram 聊天复制原消息。**网页消息在 Telegram 里不存在**，所以 `channel === 'web'` 时要走单独分支：

- **推给主人**（`dm` 模式）：用 `sendMessage` 发文字，卡片写成 `🌐 网页访客 · 昵称 · 联系方式 · 来自 example.com/about`。卡片和消息都照常写入 `dmmap`，所以主人引用回复的流程不变。卡片上不生成 `tg://user` 链接。
- **转发到话题**（`topic` 模式）：用 `ensureVisitorTopic` 创建话题，话题名前面加 `🌐`；消息用 `sendMessage` 发进话题，不用 `copyMessage`。
- 写聊天记录时 `pmMessageId` 为 `null`，记录里加 `channel: 'web'`。

### 3. 站长回复网页访客

站长回复的入口有三个，都要按 `channel` 分支。网页访客的回复**不调用任何 Telegram 发送接口**，只写进聊天记录，等挂件来拉取：

| 入口 | 位置 | 网页访客的处理 |
| :--- | :--- | :--- |
| 话题里回复 | `bot.js` 的 `handleAdminSupergroupMessage` | 不用 `copyMessage` 发给访客。只接受文字和图片，取图片最大尺寸的 `file_id`；其他类型（语音、贴纸、文件）回一条提示「网页访客暂时只能接收文字和图片」 |
| 主人私聊引用回复 | v1.7 新增的私聊回复处理 | 同上 |
| 面板里回复 | `bot.js` 的 `sendAdminDirectVisitorReply` | 不调用 `sendMessage` / `sendPhoto` 发给访客。图片需要一个 `file_id` 才能存进记录：先把图片发进通知群话题（`topic` 模式）或主人私聊（`dm` 模式），再从返回结果里取 `file_id` |

- 写入的聊天记录用一个服务端生成的 ID 作为 `pmMessageId`（例如 `Date.now()`），这样撤回功能能按这个 ID 找到要删的那条。
- **撤回**（`recallAdminVisitorMessage`）：网页访客跳过 `deleteMessage`，直接从聊天记录里删掉，挂件下次拉取时就看不到了。
- **关闭或重开会话、拉黑**：`applyVisitorAction` 本身只改 KV，可以直接用。原来「通知访客」那一步是发 Telegram 消息，网页访客改成写一条系统消息进聊天记录。

## 四、挂件前端

### `widget.js`（加载器，放在 `web/public/widget.js`）

- 原生 JS，不依赖任何库，压缩后控制在 5 KB 以内。
- 在宿主页面右下角画一个悬浮气泡，**点击后才创建 iframe**，避免拖慢宿主页面加载。
- 支持在 `<script>` 标签上用 `data-position="left"`、`data-color="#C84E79"` 做简单定制。

### 挂件页面（`web/widget.html` + `web/src/widget/`）

- 在 Vite 里作为第二个入口单独打包，**不能把面板的 React 包带进来**。可以用原生 JS 或很轻的写法，目标是首屏加载在 30 KB 以内。
- **第一屏**：问候语、昵称和联系方式两个选填输入框、Turnstile 验证框、开始聊天按钮。下面一行隐私提示：「消息会发送给站长的 Telegram，请勿发送敏感信息」。
- **聊天界面**：消息气泡加输入框，风格沿用玫瑰瓷主题。
- **会话令牌**存在 iframe 的 `localStorage` 里，读写都用 `try/catch` 包起来。注意浏览器会按宿主网站隔离 iframe 的存储，Safari 也可能在 7 天没有访问后清掉；令牌丢了就重新验证，聊天记录不会丢，但访客会变成一个新访客。
- **拉取节奏**：挂件打开并且页面可见时，每 15 秒拉取一次；连续 10 分钟没有新消息后，降到每 60 秒一次；页面切到后台（`visibilitychange`）就暂停。
- 页面上写明：「站长回复可能有几十秒延迟」。

## 五、配置

`src/worker/config.js` 新增：

```js
widget: {
  enabled: false,              // 默认关闭；没有 Turnstile 时强制为 false
  allowedOrigins: [],          // 允许嵌入的网站，例如 ["https://blog.example.com"]
  title: '给我留言',
  greeting: '你好呀 🌸 有什么想说的，直接留言吧，我会在 Telegram 里收到。',
  askContact: true,            // 是否显示「联系方式（选填）」输入框
  dailyCap: 300,               // 全站每天网页消息总量上限，50–2000
},
```

- `allowedOrigins` 每一项都要校验成 `https://域名`（可带端口）的形式，**不接受通配符 `*`**。列表为空时，挂件页面拒绝被任何网站嵌入。
- 公开配置只暴露挂件页面需要的字段：`enabled`、`title`、`greeting`、`askContact`、Turnstile 站点密钥。`dailyCap` 和 `allowedOrigins` 只给管理员。
- **提醒站长**：在 Cloudflare 后台的 Turnstile 设置里，要把自己的小站域名加进允许的主机名列表，否则验证框不会显示。

## 六、面板和设置

- **设置 → 新分区「🌐 网页挂件」**：
  - 总开关。没有 Turnstile 时禁用，并提示需要配置哪两个变量。
  - 允许嵌入的域名列表、标题、问候语、联系方式开关、每日上限。
  - **一键复制嵌入代码**。
- **访客列表（`VisitorsTab.jsx`）**：
  - 网页访客显示 `🌐` 角标，头像用首字母，昵称旁显示联系方式和来源页面。
  - 隐藏只对 Telegram 访客有意义的操作，例如打开 Telegram 资料页。
  - 面板聊天里只能给网页访客发文字和图片。

## 七、刻意不在 v1 做的

- 访客上传图片和文件。
- 实时推送（Durable Objects + WebSocket）。
- 访客离线时用邮件通知回复。
- 多语言挂件。

## 八、成本

| 项目 | 估算 |
| :--- | :--- |
| 每条网页消息 | KV 写入约 3 至 5 次：访客记录、聊天记录、频率限制计数、`dmmap`、卡片状态。所以有每日总量上限兜底 |
| 拉取回复 | 每次只读 1 次 KV。一个访客开着挂件 10 分钟大约读 40 次。免费额度是每天 10 万次读取，个人小站很难用完 |
| 回复延迟 | KV 是最终一致的：站长回复写入后，访客所在地区最多约 60 秒才能读到 |

## 九、测试（`tests/worker.test.js`）

1. 模块关闭，或没有配置 Turnstile：三个 `/api/widget/*` 接口都拒绝请求。
2. 会话：Turnstile 验证失败时不签发令牌；令牌被篡改或过期时拒绝；只创建会话不会生成访客记录。
3. 发消息：长度限制、每个访客和每个 IP 的频率限制、全站每日上限、屏蔽词、拉黑、关闭会话，都按预期拒绝。
4. 投递：`dm` 模式下用 `sendMessage` 推给主人（**不调用 `copyMessage`**），卡片带 `🌐` 且没有 `tg://user` 链接，并写入 `dmmap`；`topic` 模式下创建带 `🌐` 的话题。
5. 回复：话题里、私聊引用、面板三个入口回复网页访客时，**都不调用任何 Telegram 发给访客的接口**，消息写进聊天记录；语音、贴纸等不支持的类型会收到提示。
6. 拉取：只返回 `since` 之后的消息；图片是签名地址；撤回的消息不再出现；拉取不写 KV。
7. `/widget` 页面带正确的 `frame-ancestors` 响应头；`allowedOrigins` 为空时拒绝所有嵌入。
8. ID 校验：`w` 开头的 ID 能通过访客数据接口，但头像代理和 CAS 检查拒绝它。
9. **回归测试**：Telegram 访客在 `topic` 和 `dm` 两种模式下的行为不变；没有 `channel` 字段的旧访客记录按 `'tg'` 处理。

**验收**：`npm test && npm run build` 全部通过；用一个本地 HTML 页面嵌入挂件，完整走一遍「验证 → 留言 → 站长在 Telegram 回复 → 网页看到回复 → 站长撤回」。

## 十、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/widget.js` | 新增，三个接口和挂件页面的响应头 |
| `src/worker/inbox.js` | 网页消息的投递分支 |
| `src/worker/bot.js` | 三个回复入口按 `channel` 分支；网页访客的话题创建 |
| `src/worker/visitors.js` | `VISITOR_ID_RE`、`isWebVisitorId`；撤回和通知按 `channel` 分支 |
| `src/worker/api.js` | 访客路由放宽 ID 校验；接入 `/api/widget/*` |
| `src/worker/config.js` | `widget` 默认值和校验，区分公开字段和管理员字段 |
| `src/worker/index.js` | `/widget` 路由 |
| `wrangler.toml` | `run_worker_first` 加 `/widget` |
| `web/public/widget.js` | 新增，加载器 |
| `web/widget.html`、`web/src/widget/` | 新增，挂件页面（单独打包） |
| `vite.config.js` | 第二个打包入口 |
| `web/src/components/SettingsDrawer.jsx` | 「网页挂件」设置分区 |
| `web/src/components/VisitorsTab.jsx` | 网页访客角标和信息 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`WhatsNew`、`README`、`README_EN`，`AGENTS.md` 新增模块 8 |
