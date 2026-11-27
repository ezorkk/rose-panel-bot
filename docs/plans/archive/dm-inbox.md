# 实现方案：Bot 私聊直推（v1.7 候选）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> 文中的行号以写方案时的 `main`（`e04fb23`）为准，代码有变动时请按函数名定位。

## 目标

**没绑通知群时，私信功能从「关闭」变成「降级可用」**：只要配好 `ADMIN_IDS`，就能收发访客私信，人机验证照常生效。绑定通知群后自动回到现在的话题模式。

- **不新增任何配置开关。**
- **话题模式（`topic`）的行为和 KV 数据结构保持不变。**

### 现状（为什么要做）

- `src/worker/bot.js` `handleMessage` 私聊分支（约 2101 行）：没绑群（`supergroupId`）时，访客消息只会收到欢迎卡片，**不会转发给站长**。
- 约 2041、2193 行：要不要做人机验证取决于 `Boolean(supergroupId)`。不绑群，四层防骚扰也一起关掉了。
- `ensureVisitorTopic`（约 506 行）：没绑群时直接报错。
- 面板回复接口 `sendAdminDirectVisitorReply`（约 2370 行）本来就是 Bot 直接私信访客，不依赖话题群。

## 一、通知方式怎么判定

新增 `resolveInboxMode(env)`，返回 `'topic' | 'dm' | 'off'`：

| 条件 | 模式 | 行为 |
| :--- | :--- | :--- |
| `resolveSupergroupId(env)` 有值 | `topic` | 现状不变 |
| 没绑群，且 `parseAdminIds(env)` 不为空 | `dm` | 推送给 `ADMIN_IDS` 里的**第一个** UID（以下称「主人」） |
| 两者都没有 | `off` | 现状不变：只回欢迎卡片 |

模式不存储，每次请求实时算，所以 `/bind` 或 `/unbind` 之后马上切换，不需要迁移数据。另提供 `getOwnerChatId(env)` 返回主人的 UID。

## 二、后端改动

### 1. 新增 `src/worker/inbox.js`

#### `deliverVisitorMessage(env, origin, msg)`：统一的投递入口

- `processVisitorMessage` 和关键词规则分支原来直接调用 `forwardMessageToTopic`，**改为调用这个函数**。
- 把 `upsertVisitorProfile` 和 `recordVisitorExchange(sender: 'visitor')` 从 `forwardMessageToTopic` 里**移到这里**，两种模式都执行，保证面板上的记录、相册和链接始终完整。注意不要在 `topic` 模式下重复写入。
- `topic` 模式：调用原有的 `forwardMessageToTopic`，转发逻辑不变。
- `dm` 模式：调用 `pushToOwner`。
- 返回值要能让调用方知道投递到了哪里，供关键词提示使用。

#### `pushToOwner(env, origin, msg)`

1. **访客卡片按需发送，不是每条都发**：读取 KV `dm:last_header`（`{ uid, at }`）。只有在「换了一个访客」或「距上一张卡片超过 10 分钟」时，才先发一张卡片：
   - 文本：`👤 名字 (@用户名) · UID`，外加一行消息预览。
   - 按钮：`buildPanelButton(env, origin, '💬 在面板聊天', { isGroup: false, query: 'tab=visitors&uid=<uid>' })`。前端 `getLaunchTarget`（`web/src/lib/telegram.js`）已经支持 `tab` 和 `uid` 参数，**前端不用改**。
   - 发完更新 `dm:last_header`。
2. 访客的原消息用 `copyMessage` 原样复制给主人。语音、贴纸、文件都能原生显示，不需要逐个处理消息类型。
3. 写入「主人私聊里的消息编号 → 访客 UID」的对应关系：KV 键 `dmmap:{ownerMsgId}`，值为访客 UID，`expirationTtl` 为 7 天。卡片和复制出来的消息**都要写**。
4. **推送失败**（主人没先 `/start` 过 Bot，返回 403 等）：捕获错误，写入 `dm:owner_unreachable = '1'`，不抛出。消息照样已存进记录（第 1 节第三条），**面板是最终依据，消息不会丢**。推送成功时删除这个标记。

### 2. 主人在私聊里回复

在 `bot.js` 私聊分支里插入新逻辑，位置要放在 `/set`、`/add`、`await_badge`、`await_verify_quiz` 等录入状态处理**之后**、访客流程**之前**。只在 `isAdmin && mode === 'dm'` 时生效：

- **引用了某条消息**（`msg.reply_to_message`）：读取 `dmmap:{reply_to_message.message_id}`。
  - 查到了，且是普通消息：`copyMessage` 发给访客，并按 `sender: 'admin'` 调用 `recordVisitorExchange`，`pmMessageId` 填访客那边收到的消息编号。主人自己发出的这条消息也写入 `dmmap`，之后引用自己的回复也能接着回。发送失败时回复一条错误提示（写法参照话题模式）。
  - 查到了，且是命令 `/del`、`/recall`、`/ban`、`/unban`、`/trust`、`/reset`、`/close`、`/open`、`/info`：交给共享函数 `runVisitorCommand()`（见下一条）。
- **抽出共享函数**：把 `handleAdminSupergroupMessage` 里的命令处理（`actionMap`、`/del`、`/info`）抽成 `runVisitorCommand(env, origin, targetUid, cmd, ctx)`。其中 `ctx` 负责「把回执发到哪里」：话题模式发回原话题，私聊模式发回主人私聊。两种模式共用这一个函数，**不要复制一份**。
  - 私聊模式下 `/del`：`recallAdminVisitorMessage` 现在按话题消息编号匹配要撤回的消息。可以在 `pmMessageIds` 的条目里新增 `dmMsgId` 字段并加一个匹配分支，也可以先查 `dmmap` 再用 `explicitPmMessageId` 撤回，二选一。**找不到时必须报错，不能退回去撤回「最近一条」**。
  - `/info`：`dm` 模式下发一张不带话题编号的访客卡片。
- **没引用，或 `dmmap` 查不到**：只提示一次「请引用回复某条推送，消息才会发给访客」（KV `hint:dm_reply:{ownerId}`，24 小时内不重复提示）。**绝不猜测发给最近的访客。**
- `dm` 模式下，主人给 Bot 发的普通消息**不再当成访客消息转发**。`topic` 模式保持现状。

### 3. 验证不再依赖绑群

把下面几处的 `Boolean(supergroupId)` / `!supergroupId` 换成 `mode !== 'off'` / `mode === 'off'`：

| 位置（约） | 内容 |
| :--- | :--- |
| `bot.js:2041` | `/start` 时的 `mustVerifyNow` |
| `bot.js:2081` | 欢迎卡片的 `canChatNow` |
| `bot.js:2101` | 没绑群时的拦截条件 |
| `bot.js:2193` | `initiateChatFromMiniApp` 的 `mustVerify` |

再全文搜一遍 `supergroupId`，确认没有别的「没绑群就跳过」的判断被漏掉。**漏一处，没绑群的访客就会跳过验证，垃圾消息直接进主人私聊。**

`flushPendingMessages` 会调用 `processVisitorMessage`，所以验证通过后补发的暂存消息会自动走新的投递入口，只需确认一下。

### 4. 零碎处理

- **关键词自动回复后的提示**：`topic` 模式下保持现状，往话题里发提示。`dm` 模式下发一条静默消息（`disable_notification: true`），提示「已触发关键词自动回复（xxx）」。
- **面板里回复**（`sendAdminDirectVisitorReply`）：`dm` 模式下**不再同步一份到私聊**，因为站长本来就在面板里。现有的「已绑群才同步到话题」判断已经满足这一点，只需确认。
- **撤回**：没有话题消息编号（`topicMsgId`）时，现有逻辑会跳过同步删除，不用改。

## 三、前端改动（很小）

- `src/worker/config.js` 的 `sanitizeAdminConfig` 多返回 `inboxMode` 和 `ownerUnreachable` 两个字段（**只给管理员看**），在调用的地方传入。
- `web/src/components/SettingsDrawer.jsx` 访客分区顶部加一行只读状态：
  - `topic`：「当前通知方式：话题群」
  - `dm`：「当前通知方式：Bot 私聊推送（绑定话题群后自动切换）」
  - `ownerUnreachable` 为真时，加一条黄色提示：「请先私聊 Bot 发送 /start，否则收不到推送（消息仍可在面板查看）」
- 文档：
  - `CHANGELOG.md` 写新条目，`WhatsNewModal.jsx` 加对应说明。
  - `README.md` 和 `README_EN.md` 注明 `/bind` 变为可选。
  - `AGENTS.md` 模块 4 的「需要的配置」一栏改为「`ADMIN_IDS`（Bot 私聊推送），或 `/bind` 话题群（推荐给高频用户）」。

## 四、刻意不在 v1 做的

- 推送给多个管理员：多人之间回复状态不同步。
- 双通道模式和手动切换开关。
- 访客连发多条时合并成一张卡片：v1 用「按需发卡片 + 原样复制」已经够用。

## 五、成本和风险

- **KV 写入**：`dm` 模式下每条访客消息多 1 次写入（`dmmap`），发卡片时再多 1 至 2 次。Cloudflare 免费额度是每天 1000 次写入，个人用基本够用，README 里注明即可。
- **兼容性**：`topic` 模式只是多绕了一层投递入口，**不改动现有的 KV 数据结构**，已部署的用户升级没有感知。
- **待核实**：没有话题编号时，`getVisitorDetail` 和面板访客卡片（`VisitorsTab`）能否正常显示，有没有依赖话题编号的「打开话题」链接。

## 六、测试（`tests/worker.test.js`）

新增用例覆盖：

1. `resolveInboxMode` 三种模式的判定。
2. `dm` 模式：访客首条消息先发卡片再复制原消息，并写入 `dmmap`；同一访客 10 分钟内再发不重复发卡片；换一个访客会重新发卡片。
3. 主人引用推送回复：送达访客，并按 `sender: 'admin'` 记录。
4. 主人没引用，或引用了查不到的消息：只提示，**不调用**任何给访客发消息的接口；24 小时内只提示一次。
5. 主人引用推送发 `/ban`、`/del`：分别生效；`/del` 找不到对应消息时报错。
6. 没绑群但配了 `ADMIN_IDS`：没验证的陌生人仍会触发人机验证。
7. 推送返回 403：写入 `dm:owner_unreachable`，消息仍存进记录。
8. **回归测试**：`topic` 模式下转发、话题内回复、`/del`、关键词提示的行为和现在一致。

**验收**：`npm test && npm run build` 全部通过。

## 七、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/inbox.js` | 新增，约 150 行 |
| `src/worker/bot.js` | 换成新的投递入口；新增主人私聊回复处理；抽出 `runVisitorCommand`；4 处验证条件 |
| `src/worker/visitors.js` | 可能要改：`/del` 按 `dmMsgId` 匹配 |
| `src/worker/config.js` | `sanitizeAdminConfig` 多返回 2 个字段 |
| `web/src/components/SettingsDrawer.jsx` | 一行状态 + 一条提示 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`WhatsNew`、`README`、`README_EN`、`AGENTS.md` |
