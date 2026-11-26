# 实现方案：名片分享海报与链接预览（v1.8）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> 文中的行号以写方案时的 `main`（`e04fb23`）为准，代码有变动时请按函数名定位。

## 目标

让名片能被分享到 Telegram 之外：

1. **分享海报**：在小程序里一键生成一张名片图片，可以保存或转发。
2. **链接预览**：名片链接发到 Telegram、X、论坛等地方时，显示标题、简介和头像。

两处都要带上项目名 **RosePanel**，并且**字号要小**：是一行低调的署名，不能抢名片本身的视觉重点。

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
- 画布尺寸 1080 × 1350（4:5，适合手机相册和社交平台）。
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
3. **复制名片链接**：复制 `shareUrl`。

## 四、配置和接口

- `sanitizePublicConfig` 新增 `shareUrl`（只是一个公开链接，不含敏感信息）。
- 不新增设置项，也不新增后端接口。

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
