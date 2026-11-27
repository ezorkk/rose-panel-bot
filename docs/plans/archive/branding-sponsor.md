# 实现方案：署名开关与赞助兑换码（暂缓）

> **状态：暂缓，不在 v1.8 范围内。** 现阶段以增加用户为主，暂不做付费去署名。
> 交给实现者时请**跳过本文件**。等用户量起来、决定恢复时，再把它排进某个版本。
> 分享海报（`share-card.md`）的固定小字署名不受影响，照常实现。

> 给实现者（AI 编码助手或人类开发者）：请先通读本文、`docs/plans/share-card.md` 和根目录的 `AGENTS.md`，再动手。
> 本方案和分享海报（`share-card.md`）共用署名常量，建议在分享海报之后实现。
> **绝对不要生成、提交或在输出里打印任何私钥。** 仓库里只能出现公钥和签发脚本。

## 目标

1. 所有**访客能看到**的项目署名，由同一个「署名」设置统一控制，有三档：**默认显示 / 隐藏 / 自定义文字**。
2. 「隐藏」和「自定义」需要**赞助兑换码**才能解锁。站长在爱发电看到赞助订单后，在自己电脑上生成兑换码，私信发给赞助者。
3. 兑换码在每个部署里**离线验证**：不联网，不依赖任何中心服务。

### 定位

项目是 MIT 协议，会改代码的人可以直接删掉署名。兑换码是**给赞助者的回礼**，不是防破解措施。实现时不要做混淆、联网校验、自毁这类「反破解」逻辑。

## 一、署名控制的位置

| 位置 | 默认显示 | 隐藏 | 自定义 |
| :--- | :--- | :--- | :--- |
| 分享海报底部 | `Made with RosePanel 🌹`（规格见 `share-card.md`） | 不画 | 画自定义文字，字号和颜色同默认 |
| 链接预览 `og:site_name` | `RosePanel` | 不输出这个标签 | 自定义文字 |
| 首页 `<title>` 后缀 | `{显示名} · RosePanel` | `{显示名}` | `{显示名} · {自定义文字}` |
| 人机验证页标题（`src/worker/turnstile.js`） | `人机安全验证 · RosePanel` | `人机安全验证` | `人机安全验证 · {自定义文字}` |
| **新增**：名片页底部一行小字（`TicketTab.jsx`） | `Made with RosePanel 🌹`，点击用 `openExternalUrl` 打开项目 GitHub | 不显示 | 显示自定义文字，**不带链接** |

- 名片页底部小字的样式：字号 11px，颜色用主题的次要文字色，透明度 50%，居中，放在名片内容最下方。**不能抢名片主体的视觉重点。**
- 没填显示名时的默认名字 `RosePanel`、设置页的版本号和点 Star 提示条**不归这个设置管**：后两项只有站长能看到，Star 提示条本来就能关闭。
- 所有署名文字统一从 `web/src/lib/brand.js`（前端）和服务端的同名常量读取，不要到处写死。

## 二、兑换码格式

```
RP1.<payload>.<signature>
```

- `payload`：下面这个 JSON 的 base64url 编码（不带补位 `=`）。

  ```json
  { "v": 1, "bot": "my_panel_bot", "f": ["brand"], "iat": 1795000000, "id": "a1b2c3d4" }
  ```

  | 字段 | 含义 |
  | :--- | :--- |
  | `v` | 格式版本，目前是 1 |
  | `bot` | 赞助者的 Bot 用户名：小写，不带 `@` |
  | `f` | 解锁的功能，v1 只有 `brand`（署名控制） |
  | `iat` | 签发时间（Unix 秒） |
  | `id` | 8 位随机十六进制，方便站长对账 |

- `signature`：用 **Ed25519** 对 ASCII 字符串 `RP1.<payload>` 签名，再做 base64url 编码。
- 兑换码**不设过期时间**：赞助是一次性的，回礼长期有效。
- 用户名比较时不区分大小写，并去掉开头的 `@`。

## 三、服务端（新增 `src/worker/sponsor.js`）

### 公钥列表

```js
// 站长的兑换码签名公钥（raw 32 字节，base64url）。可以有多个：
// 换新密钥时把新公钥加在后面，旧公钥保留，已经发出的兑换码继续有效。
export const SPONSOR_PUBLIC_KEYS = [
  // 'xxxxxxxx',  ← 由站长运行 scripts/issue-sponsor-code.mjs init 后填入
];
```

- **实现者不要自己生成密钥填进来。** 这里先留空数组，由站长生成后填入。
- 列表为空时，所有兑换码都验证失败，设置页显示「暂未开放兑换」。
- **不要提供用环境变量覆盖公钥的方式**：那样不改代码、只在后台加一个变量就能自签兑换码。

### `verifySponsorCode(code, botUsername, publicKeys = SPONSOR_PUBLIC_KEYS)`

1. 按格式拆分。格式错误、`v !== 1`、`f` 里没有 `brand`、`bot` 不是合法用户名（`/^[a-z0-9_]{5,32}$/`），都返回 `{ ok: false, reason }`。
2. 用 `crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])` 导入公钥，逐个尝试验签。**实现时先确认 Cloudflare Workers 和 Vitest 运行环境都支持 `Ed25519` 这个算法名**；不支持的话，在方案范围内选一个可行写法，并在 PR 说明里写明。
3. 验签通过后，比较 `bot` 和当前部署的 Bot 用户名（`resolveBotUsername`）。不一致时返回 `{ ok: false, reason: 'bot_mismatch' }`。
4. 返回 `{ ok: true, bot, id, iat }`。

### 配置

`DEFAULT_CONFIG` 新增：

```js
branding: {
  mode: 'default',     // 'default' | 'hidden' | 'custom'
  customText: '',      // 最多 30 个字符
  sponsorCode: '',     // 兑换码原文
  sponsor: null,       // 验证通过后写入 { bot, id, verifiedAt }
},
```

- **服务端强制校验**：保存配置时，如果没有有效的 `sponsor`，或者 `sponsor.bot` 和当前 Bot 用户名不一致，`mode` 一律强制改回 `'default'`。改请求也绕不过去。
- `customText`：去掉控制字符和换行，截到 30 个字符。输出到 HTML 的地方一律转义；海报用 Canvas 绘制，本身不会被注入。
- `sponsorCode` 和 `sponsor` 只通过 `sanitizeAdminConfig` 给管理员。
- **公开配置只暴露算好的结果**：`branding: { show: true|false, text: '...' }`。前端只按这个结果渲染，不在前端判断兑换码。
- 计算公开结果时，**同步比较**已存的 `sponsor.bot` 和当前 Bot 用户名，不用每次都重新验签。站长换了 Bot 用户名，署名就自动恢复成默认。

### 接口

- `POST /api/admin/sponsor/redeem`，请求体 `{ code }`，仅管理员可用：
  - 验证通过：保存 `sponsorCode` 和 `sponsor`，返回最新的管理员配置。
  - 验证失败：返回能看懂的中文错误：「兑换码格式不正确」「兑换码无效」「这个兑换码绑定的是 @xxx，和当前 Bot 不一致」「暂未开放兑换」。
  - 每分钟最多 5 次（复用 `checkRateLimit`）。
- `POST /api/admin/sponsor/remove`：清除兑换码，`mode` 恢复为 `'default'`。

### 服务端注入点

- `src/worker/index.js` 的 `injectSplashIntoHtml`：按署名结果生成 `og:site_name` 和 `<title>`。分享海报方案也改这个函数，两边合在一起写。
- `src/worker/turnstile.js` 的 `renderTurnstileVerifyPage`：标题后缀由调用方传入，这个函数不要自己去读配置。

## 四、签发脚本（新增 `scripts/issue-sponsor-code.mjs`）

只给站长在自己电脑上用的 Node 脚本，**不参与构建和部署**。

```bash
# 第一次使用：生成签名密钥对
node scripts/issue-sponsor-code.mjs init

# 每有一位赞助者：生成兑换码
node scripts/issue-sponsor-code.mjs issue <对方的Bot用户名> --note "爱发电订单号或备注"
```

### `init`

- 用 `node:crypto` 生成 Ed25519 密钥对。
- 私钥存到 `~/.rosepanel/sponsor-ed25519.pem`，权限 `600`。路径可以用环境变量 `ROSEPANEL_SPONSOR_KEY` 改。
- **私钥文件已经存在时拒绝覆盖**，提示「已有密钥；如确定要生成新密钥，请先手动移走旧文件」。
- 在终端输出：
  1. 公钥（base64url），提示「把这一行加进 `src/worker/sponsor.js` 的 `SPONSOR_PUBLIC_KEYS`」。
  2. **备份提醒**：「请立刻把私钥文件备份到安全的地方，例如密码管理器或加密 U 盘。私钥丢失后无法再签发新兑换码（已发出的仍然有效），私钥泄露则任何人都能签发兑换码。」

### `issue`

- 读取私钥，校验用户名格式，生成并打印兑换码。
- 在 `~/.rosepanel/issued.csv` 追加一行：时间、Bot 用户名、`id`、备注，方便站长对账。**这个文件只存在本机。**
- 找不到私钥时，提示先运行 `init`。

### `.gitignore`

追加 `*.pem` 和 `.rosepanel/`，防止把私钥误放进项目目录后被提交。

## 五、私钥丢失或泄露怎么办

**这一节要原样写进 README 的「维护者指南」部分，方便站长查阅。**

| 情况 | 影响 | 处理 |
| :--- | :--- | :--- |
| **私钥丢了**（换电脑、误删） | 已经发出的兑换码**全部继续有效**；只是没法用旧私钥签发新码 | 重新 `init` 生成新密钥对，把新公钥**加在** `SPONSOR_PUBLIC_KEYS` 后面（旧公钥保留），发一个新版本。之后用新私钥签发 |
| **私钥泄露**（被别人拿到） | 别人能自己签发兑换码 | 生成新密钥对；从列表里**删掉旧公钥**，换成新公钥；发新版本。旧兑换码会失效，需要用新私钥给已有赞助者补发：`issued.csv` 里有完整名单 |
| **`issued.csv` 丢了** | 只是对账记录丢了，不影响任何功能 | 可以从爱发电后台的订单记录补回来 |

所以**备份私钥一次就够了**。真丢了，最坏的结果也只是重新生成一对密钥、发一个新版本。

## 六、前端

### 设置页：「名片分享」分区里新增「署名」块（`SettingsDrawer.jsx`）

1. 当前状态，例如「默认显示 RosePanel 署名」或「已解锁 · 绑定 @my_panel_bot」。
2. 兑换码输入框加「兑换」按钮，结果用 toast 提示。已兑换时显示「移除兑换码」。
3. 三个选项「默认显示 / 隐藏 / 自定义文字」。**没有有效兑换码时，后两项禁用**，旁边一行：「赞助作者即可解锁 🧧」，点击打开赞助页面。
4. 选择「自定义文字」时出现输入框，实时显示剩余字数（最多 30 字）。
5. 赞助页面地址放在常量 `SPONSOR_URL` 里（和 `REPO_URL` 放在一起）。**站长会提供自己的爱发电主页链接**；提供之前先指向 README 的「赞助与支持」锚点。

### 渲染

- 名片页底部小字、分享海报底部，都只读公开配置里的 `branding.show` 和 `branding.text`。

## 七、文档

- `CHANGELOG.md`（v1.8.0 未发布条目）、`WhatsNewModal.jsx`：「名片底部新增小字署名；赞助后可隐藏或自定义」。
- `README.md` 和 `README_EN.md`：
  - 赞助一节加上「赞助后可获得署名兑换码」，以及**留言里填写自己的 Bot 用户名**的说明。
  - 新增「维护者指南」，写明签发脚本的用法和第五节的私钥处理表。

## 八、测试（`tests/worker.test.js`）

测试里用 `crypto.subtle.generateKey` 临时生成测试密钥对，把公钥通过参数传给 `verifySponsorCode`。接口层的测试用 `vi.mock` 或测试专用的注入方式替换公钥列表，**不要加环境变量覆盖**。

1. 正确的兑换码：验证通过；用户名大小写不同、带 `@` 也能通过。
2. 篡改 `payload` 的任意一个字符：验签失败。
3. 用另一对密钥签发的兑换码：失败。
4. `bot` 和当前 Bot 用户名不一致：返回 `bot_mismatch`。
5. 格式错误、`v` 不对、`f` 里没有 `brand`：都失败。
6. 公钥列表为空：所有兑换码都失败，提示「暂未开放兑换」。
7. 公钥列表有多个：用其中任意一个签发的码都能通过（保证换密钥后旧码继续有效）。
8. 没有有效兑换码时，`PUT /api/admin/config` 提交 `mode: 'hidden'`，保存结果被强制改回 `'default'`。
9. 兑换后换了 Bot 用户名：公开配置里 `branding.show` 自动变回 `true`。
10. `customText` 带 `<script>`、换行、超长：截断并在 HTML 输出里转义。
11. 三种模式下，首页的 `og:site_name`、`<title>` 和人机验证页标题都正确；页面里只有一个 `<title>`。
12. 公开配置里没有 `sponsorCode` 和 `sponsor`；`redeem` 接口非管理员调用返回 403，并且有频率限制。
13. 签发脚本：对 `init` 和 `issue` 的核心函数（生成密钥、签发兑换码）做单元测试，测试里用临时目录，不碰 `~/.rosepanel`。签发出的码要能通过 `verifySponsorCode`。

**验收**：`npm test && npm run build` 全部通过。

## 九、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/sponsor.js` | 新增：公钥列表（先留空）、`verifySponsorCode` |
| `src/worker/config.js` | `branding` 默认值和校验；公开配置只给算好的结果；管理员配置包含兑换码 |
| `src/worker/api.js` | `redeem` 和 `remove` 接口；保存配置时强制校验署名模式 |
| `src/worker/index.js` | `og:site_name` 和 `<title>` 按署名结果输出 |
| `src/worker/turnstile.js` | 标题后缀由调用方传入 |
| `scripts/issue-sponsor-code.mjs` | 新增签发脚本 |
| `.gitignore` | 追加 `*.pem`、`.rosepanel/` |
| `web/src/lib/brand.js` | 署名常量（和分享海报共用） |
| `web/src/components/TicketTab.jsx` | 名片页底部小字 |
| `web/src/components/SettingsDrawer.jsx` | 「署名」设置块 |
| `web/src/components/WhatsNewModal.jsx` | `SPONSOR_URL` 常量和更新说明 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`README`、`README_EN` |
