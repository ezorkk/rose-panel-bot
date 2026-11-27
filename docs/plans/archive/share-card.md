# 实现方案：名片分享海报与链接预览（v1.8）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> 文中的行号以写方案时的 `main`（`e04fb23`）为准，代码有变动时请按函数名定位。

## 目标

让名片能被分享到 Telegram 之外：

1. **分享海报**：在小程序里一键生成一张名片图片，可以保存或转发。
2. **链接预览**：名片链接发到 Telegram、X、论坛等地方时，显示标题、简介和头像。
3. **来源参数**：记录每个访客是从哪里来的（分享海报、个人小站、频道……），让站长知道哪个渠道带来的访客最多。详见第八节。
4. **本月访客数**：统计每月有多少人打开过名片。站长在面板里随时能看到；要不要公开显示在名片上由站长决定，默认不公开。详见第九节。

海报和链接预览都要带上项目名 **RosePanel**，并且**字号要小**：是一行低调的署名，不能抢名片本身的视觉重点。

## 一、项目署名规范（两处共用）

| 位置 | 写法 | 样式 |
| :--- | :--- | :--- |
| 海报底部 | `Made with RosePanel 🌹` | 居中；画布宽 1080px 时字号 **22px**（约为画布宽度的 2%，大约是正文字号的一半）；颜色用主题的次要文字色，透明度 55%；距离底边 40px |
| 链接预览 | `og:site_name = "RosePanel"` | 各平台会把它显示成标题上方的一行小字，不用另外控制字号 |

- 署名常量放在一处（例如 `web/src/lib/brand.js` 导出 `BRAND_NAME = 'RosePanel'`），海报和服务端注入共用，以后改名只改一处。
- v1 不提供隐藏署名的开关。

## 二、链接预览（服务端，改动小）

`src/worker/index.js` 的 `injectSplashIntoHtml` 已经会在返回首页 HTML 时注入启动画面数据，在同一个位置追加 Open Graph 标签：

```html
<meta property="og:site_name" content="RosePanel" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="{displayName}" />
<meta property="og:description" content="{tagline}" />
<meta property="og:image" content="{头像的绝对地址}" />
<meta name="twitter:card" content="summary" />
<title>{displayName} · RosePanel</title>
```

- **所有插入的值都要做 HTML 转义**：显示名和简介是站长自己填的，不转义就能注入标签。
- `tagline` 截到 160 个字符。
- 头像按名片的头像模式（`avatarMode`，`bot` / `owner` / `custom`）取**名片上实际显示的那张**，不能多暴露信息：
  - `custom`：用 `avatarUrl`，必须是 `https://` 地址。
  - `owner`：用已有的服务端代理 `/api/avatar/owner`，拼成绝对地址。
  - `bot`：使用 Bot 头像的现有接口。没有现成接口时就不输出 `og:image`。
- 现有的 `<title>RosePanel · 个人面板</title>` 改为替换成上面的写法，不要出现两个 `<title>`。

## 三、分享海报（前端）

### 入口

名片页（`web/src/components/TicketTab.jsx`）加一个「📤 分享名片」按钮，**所有人都能看到**。访客替站长转发名片，正是传播的意义所在。

### 生成方式

用浏览器 Canvas 2D 直接绘制，新建 `web/src/lib/sharePoster.js`：

- **不引入 html2canvas 这类截图库**：体积大，在 Telegram 内置浏览器里也不稳定。
- 画布宽 1080px，高度随内容自适应（资料少时约 1120px，最多约 1370px），避免名片资料少时中间出现大块空白。
- 画之前先 `await document.fonts.ready`，避免字体还没加载就画出来。
- 颜色从现有主题变量（`web/src/styles/theme.css`）读取，保证和名片风格一致，浅色、深色都要好看。

### 海报内容（从上到下）

1. 头像（圆形）。
2. 显示名，下面一行是 `handle`。
3. 简介（`tagline`），最多 3 行，超出用省略号。
4. 个人标签（`tags`），最多 6 个，画成小胶囊。
5. 二维码：扫码打开名片。
6. 底部署名：`Made with RosePanel 🌹`（规范见第一节）。

**只使用公开配置里的信息**：私密书签、站点数量、访客数据、在线状态一律不画。在线状态会过时，也不画。

### 二维码

- 链接地址由服务端算好：在公开配置里新增 `shareUrl` 字段。配了 `BOT_USERNAME` 和 `APP_SHORT_NAME` 时，用 `buildMiniAppDirectLink(env)`，即 `https://t.me/<bot>/<app>`；否则用站点首页地址。
- **海报上的二维码要带来源参数 `poster`**，「复制名片链接」带来源参数 `link`。拼接方式见第八节的 `buildSourceLink`。
- 二维码库用体积小的纯 JS 实现（例如 `qrcode-generator`），**并且用动态 `import()` 在点击分享时才加载**，不能增加名片首屏的包体积。引入前在 npm 上确认许可证和最近的维护情况。

### 头像跨域

- 同源的头像（`/api/avatar/owner` 等）可以直接画。
- `custom` 模式的外链头像，用 `crossOrigin = 'anonymous'` 加载。对方不允许跨域时，画布会被污染、无法导出，**这时改画首字母头像**。
- **不要为此新增一个通用的图片代理接口**：任意地址都能代理的接口会被拿去当开放代理用。

### 保存和分享

生成后弹出预览层，提供下面这些操作，按设备能力显示：

1. **系统分享**：`navigator.canShare({ files })` 支持时，用 `navigator.share` 分享 PNG 文件。
2. **保存图片**：
   - 普通浏览器：用 `<a download>` 下载。
   - Telegram 内置浏览器：预览图上提示「长按图片保存」。Telegram WebApp 的 `downloadFile` 等接口，**先查官方文档确认参数和版本要求**再决定要不要用，不要凭猜测调用。
3. **复制名片链接**：复制带来源参数 `link` 的名片链接。

## 四、配置和接口

- `sanitizePublicConfig` 新增 `shareUrl`（只是一个公开链接，不含敏感信息）。
- 海报和链接预览本身不新增设置项，也不新增后端接口。来源参数的改动单独列在第八节。

## 五、文档

- `CHANGELOG.md` 写新条目，`WhatsNewModal.jsx` 加对应说明。
- `README.md` 和 `README_EN.md` 的名片一节加一句「支持生成分享海报和链接预览」，附一张海报示例图。

## 六、测试

`tests/worker.test.js`：

1. 首页 HTML 注入了 `og:site_name="RosePanel"`、`og:title`、`og:description`。
2. 显示名或简介里带 `<`、`"` 时被正确转义，不能注入标签。
3. 三种头像模式下 `og:image` 的取值正确；`custom` 模式下不是 `https` 地址时不输出 `og:image`。
4. 页面里只有一个 `<title>`。
5. `shareUrl`：配了 Bot 用户名和小程序短名时用 `t.me` 直达链接，没配时用站点首页。

前端手动验证：

- 浅色、深色主题各生成一次；简介超长、没有标签、外链头像不允许跨域这几种情况都要看。
- 用手机扫海报上的二维码，能打开名片。
- 署名字号明显小于正文，不抢视觉重点。
- 名片首屏的包体积没有增加（二维码库是按需加载的）。

**验收**：`npm test && npm run build` 全部通过。

## 七、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/index.js` | `injectSplashIntoHtml` 里注入 OG 标签和 `<title>` |
| `src/worker/config.js` | 公开配置新增 `shareUrl` |
| `web/src/lib/brand.js` | 新增，署名常量 |
| `web/src/lib/sharePoster.js` | 新增，Canvas 绘制海报 |
| `web/src/components/TicketTab.jsx` | 分享按钮和预览层 |
| `package.json` | 新增二维码库（按需加载） |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`WhatsNew`、`README`、`README_EN` |

（来源参数的改动范围见第八节末尾。）

## 八、来源参数（访客从哪里来）

### 目标

站长能看到每个访客是**第一次从哪里找到自己的**：分享海报、个人小站、频道、名片链接……并能在面板上看到各渠道带来了多少访客。

- 只记录**第一次来源**，之后从别的渠道再进来也不覆盖。
- 只记录发过消息的访客。只打开名片、不说话的人不会出现在访客列表里，这一点和现在一致。
- 不记录管理员自己。

### 参数格式

- 统一写成 `src_<渠道名>`，渠道名只允许 `/^[a-z0-9_]{1,24}$/`。
- **必须带 `src_` 前缀**，避免和现有参数冲突：`/start panel`（`buildPanelButton` 的回退链接在用）、Mini App 的 `visitor_<uid>`、`settings_*`、`visitors`、`probe`、`sites`。
- 不符合格式的参数一律忽略，不报错，也不影响原来的流程。

内置渠道的显示名称：

| 渠道名 | 显示为 |
| :--- | :--- |
| `poster` | 分享海报 |
| `link` | 名片链接 |
| `site` | 个人小站 |
| `channel` | 频道 |
| 其他 | 原样显示渠道名，例如 `src_nodeseek` 显示为 `nodeseek` |

### 访客可能从两个入口进来

| 入口 | 链接写法 | 服务端怎么拿到参数 |
| :--- | :--- | :--- |
| **直接进 Bot 私聊**（小站和频道上的「联系我」按钮） | `https://t.me/<bot>?start=src_site` | Bot 收到 `/start src_site`，即 `extractCommand` 解析出的 `args` |
| **先打开名片 Mini App**（海报二维码、名片链接） | `https://t.me/<bot>/<app>?startapp=src_poster` | 前端读取 `initDataUnsafe.start_param`；访客点「发私信」时，把它作为 `source` 放进 `POST /api/chat/start` 的请求体 |

没有配置 `BOT_USERNAME` 和 `APP_SHORT_NAME`、只能用站点首页地址时，写成 `https://<域名>/?src=poster`，前端读取 URL 的 `src` 参数。

### 服务端

新增函数（放在 `src/worker/visitors.js`）：

- `normalizeSourceParam(raw)`：输入 `src_site` 或 `site`，返回 `site`；不合法时返回空字符串。
- `rememberPendingSource(env, uid, source)`：如果这个访客还没有来源，就写入 KV `src:{uid}` = `site`，保留 7 天。已经有 `src:{uid}`，或者访客记录里已经有 `source`，就什么都不做（只记第一次）。
- `upsertVisitorProfile`：访客记录还没有 `source` 时，读取 `src:{uid}`；读到了就写进访客记录（`source`、`source_at`），然后删掉 `src:{uid}`。

调用位置：

1. `bot.js` 处理 `/start` 时：访客不是管理员、`parsed.args` 以 `src_` 开头，就调用 `rememberPendingSource`。**放在验证流程之前**，所以需要先验证的访客也能记住来源。`/start` 本身已有频率限制，不会被刷写入。
2. `initiateChatFromMiniApp` 收到 `source` 时，同样调用 `rememberPendingSource`。
3. 访客发出第一条消息，走 `deliverVisitorMessage` → `upsertVisitorProfile` 时，来源就落进访客记录。

### 展示

- **访客卡片**（`buildVisitorCardText`）：有来源时加一行 `• 来源：个人小站`。话题群和 Bot 私聊推送都会显示。
- **面板访客详情**：显示来源和来源时间。
- **面板访客列表顶部**：新增「来源统计」一行，例如「分享海报 12 · 个人小站 8 · 频道 3 · 未知 20」。
  - 统计在读取访客列表时**现场计算**，不另外维护计数器，**不增加 KV 写入**。
  - 需要把 `source` 加进访客摘要（`listVisitors` 和摘要缓存 `cache:visitor_summary` 里的每一项）。
  - 旧访客没有 `source`，归为「未知」。

### 推广链接助手（设置页）

在 设置 → 名片分享 里加一个「推广链接」块，列出现成的链接，每条带复制按钮：

| 用途 | 链接 |
| :--- | :--- |
| 放在个人小站的「联系我」按钮 | `https://t.me/<bot>?start=src_site` |
| 放在频道简介 | `https://t.me/<bot>?start=src_channel` |
| 分享名片 | `https://t.me/<bot>/<app>?startapp=src_link` |

下面加一行说明：「也可以把 `src_` 后面换成任意英文渠道名，例如 `src_nodeseek`，来源统计里就会单独显示。」没有配置 `BOT_USERNAME` 时，这一块显示「需要先配置 BOT_USERNAME」。

### 共用的拼接函数

前后端各写一个 `buildSourceLink(base, source, kind)`：`kind` 为 `bot` 时拼 `?start=src_x`，为 `app` 时拼 `?startapp=src_x`，为 `web` 时拼 `?src=x`。原链接已经带 `?` 时要用 `&` 连接。

### 测试（`tests/worker.test.js`）

1. `normalizeSourceParam`：`src_site` 和 `site` 都返回 `site`；`src_`、大写、带空格或特殊字符、超过 24 个字符都返回空字符串。
2. `/start src_site`：访客还在验证阶段时也写入了 `src:{uid}`；验证通过、发出第一条消息后，访客记录的 `source` 为 `site`，`src:{uid}` 被删除。
3. 只记第一次：先 `/start src_site`，再 `/start src_channel`，最终来源仍是 `site`；已有来源的老访客再带参数进来也不覆盖。
4. `/start panel`、`/start` 不带参数、`/start src_<script>`：都不写入任何来源，原来的欢迎和验证流程不受影响。
5. 管理员 `/start src_site`：不写入来源。
6. `POST /api/chat/start` 带 `source: 'poster'`：效果和 `/start src_poster` 一样；`source` 不合法时被忽略。
7. 访客卡片：有来源时显示「来源：分享海报」；自定义渠道名原样显示，并做 HTML 转义。
8. 来源统计：按渠道正确计数，没有来源的旧访客计入「未知」；读取统计不产生 KV 写入。
9. `buildSourceLink`：三种 `kind` 都拼接正确；原链接已有 `?` 时用 `&`。

前端手动验证：扫海报二维码进入名片，点「发私信」发一条消息，访客卡片上显示「来源：分享海报」。

### 改动范围

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/visitors.js` | `normalizeSourceParam`、`rememberPendingSource`；`upsertVisitorProfile` 写入来源；访客摘要加 `source` |
| `src/worker/bot.js` | `/start` 记录来源；`initiateChatFromMiniApp` 接收 `source`；访客卡片显示来源 |
| `src/worker/api.js` | `/api/chat/start` 读取请求体里的 `source` |
| `web/src/lib/telegram.js` | 读取 `start_param` 和 URL 的 `src` 参数；`buildSourceLink` |
| `web/src/components/TicketTab.jsx` | 「发私信」时带上 `source`；海报二维码和复制链接带来源参数 |
| `web/src/components/VisitorsTab.jsx` | 访客详情显示来源；列表顶部来源统计 |
| `web/src/components/SettingsDrawer.jsx` | 推广链接助手 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `README` 和 `README_EN` 说明来源参数和推广链接的用法 |

## 九、本月访客数

### 目标

统计「本月有多少人打开过名片」：**按人数统计，每人每月只算一次**，不统计打开次数。

- 按打开次数统计，每次打开都要写一次 KV，名片稍微热门就会吃光免费写入额度（每天 1000 次）；而且刷新一下就加一，数字会虚高。
- 按人数统计，每个访客每月只产生约 2 次写入，数字也更真实。

### 谁会被计数

- 只统计**通过 Telegram 打开名片、带有效身份**的访客，即 `authenticateRequest` 返回了 `auth.user`。这样才能按 Telegram UID 去重。
- **不计数**：站长和管理员自己（`auth.isAdmin`）、本地预览（`auth.isPreview`）、在普通浏览器里打开没有 Telegram 身份的访问。
- 一个人这个月打开多少次都只算 1 人。

### 计数逻辑（新增 `src/worker/visitStats.js`）

`recordMonthlyVisit(env, uid, config)`：

1. 按站长时区算出当前月份 `YYYYMM`。时区复用 `config.community.timezoneOffsetHours`（默认 UTC+8），和签到功能一致。
2. 读 `visit:seen:{YYYYMM}:{uid}`。**已经存在就直接返回**：老访客再打开只有 1 次读取，没有写入。
3. 不存在时：
   - 写入 `visit:seen:{YYYYMM}:{uid}` = `'1'`，保留 40 天（`expirationTtl`），保证一直能撑到这个月结束。
   - 读取 `visit:count:{YYYYMM}`（JSON `{ "n": 数字 }`），加 1 写回，保留 400 天。
4. 整个函数用 `try/catch` 包住，任何错误都吞掉。**计数失败绝不能影响名片打开。**

调用位置：`src/worker/api.js` 的 `GET /api/bootstrap`。满足计数条件时，用 `ctx.waitUntil(recordMonthlyVisit(...))` 放到后台执行，**不增加名片打开的等待时间**。`ctx` 为空（比如测试里）时直接 `await`。

**已知误差**：KV 不支持原子加一，同一瞬间两个新访客同时打开时，可能少算 1 人。个人名片的访问量下可以接受，在代码注释里写明。

`getVisitStats(env, config)`：返回 `{ thisMonth, lastMonth }`。每次读取 2 个 KV，不写入。

### 配置

`DEFAULT_CONFIG.profile` 新增：

```js
showVisitCounter: false,   // 是否在名片上公开显示本月访客数，默认不公开
```

- `sanitizePublicConfig`：只有 `showVisitCounter === true` 时，才在公开配置里返回 `visitStats: { thisMonth }`；关闭时完全不返回这个字段。
- 管理员的 bootstrap 结果里**一直包含** `visitStats: { thisMonth, lastMonth }`。

### 展示

- **名片页**（`TicketTab.jsx`，只在公开开关打开时显示）：在名片底部、署名小字上方显示一行 `👀 本月访客 128 人`。样式和署名小字协调，字号略大一点（12px），同样低调。
- **面板访客页**（`VisitorsTab.jsx`，只有站长能看到）：顶部统计区加一项 `本月访客 128 人（上月 96 人）`，和第八节的来源统计放在一起。
- **设置页**（`SettingsDrawer.jsx` 的名片资料分区）：开关「在名片上公开显示本月访客数」，下面一行说明：「只统计通过 Telegram 打开名片的访客，每人每月计一次，不含你自己。」

### 成本

| 情况 | KV 读取 | KV 写入 |
| :--- | :--- | :--- |
| 本月已经来过的访客再打开 | 1 次 | 0 |
| 本月第一次来的访客 | 2 次 | 2 次 |
| 显示统计（bootstrap） | 每次多 1 至 2 次 | 0 |

按每天 1000 次的免费写入额度算，一天要有大约 500 个**新**访客才会成为瓶颈，个人名片基本碰不到。真超出额度时，计数会失败但被吞掉，名片照常打开，只是那天的数字会偏少。在 README 里注明。

### 测试（`tests/worker.test.js`）

1. 同一访客同一个月打开 3 次，计数只加 1；第 2、3 次没有 KV 写入。
2. 两个不同访客各打开一次，计数为 2。
3. 管理员打开、本地预览、没有 Telegram 身份的请求，都不计数。
4. 跨月：按 `timezoneOffsetHours` 计算月份边界。例如 UTC+8 时，UTC 时间 1 月 31 日 16:30 已经算 2 月。新月份从 0 开始计数，`lastMonth` 显示上个月的数字。
5. KV 写入抛错时，bootstrap 仍然正常返回。
6. `showVisitCounter` 为 `false` 时，公开配置里没有 `visitStats`；为 `true` 时只有 `thisMonth`，没有 `lastMonth`。管理员始终能拿到两个数字。
7. `visit:seen:*` 带有 `expirationTtl`，`visit:count:*` 也带有 `expirationTtl`。

### 改动范围

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/visitStats.js` | 新增：`recordMonthlyVisit`、`getVisitStats` |
| `src/worker/api.js` | bootstrap 里后台计数，并返回统计 |
| `src/worker/config.js` | `profile.showVisitCounter` 默认值；公开配置按开关返回 `visitStats` |
| `web/src/components/TicketTab.jsx` | 名片底部的本月访客数 |
| `web/src/components/VisitorsTab.jsx` | 顶部统计加本月和上月访客数 |
| `web/src/components/SettingsDrawer.jsx` | 公开显示开关和说明 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`WhatsNew`、`README`、`README_EN` |
