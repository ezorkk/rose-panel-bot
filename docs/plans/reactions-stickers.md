# 实现方案：表情回应双向同步与面板贴纸显示（v1.9）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> **前提：PR #7（`perf/panel-reply-speed`，面板提速）合并之后，从 `main` 新建分支实现。** 本方案改动的 `bot.js`、`visitors.js`、`inbox.js`、`VisitorsTab.jsx` 和 PR #7 重叠，提前开工会冲突。
> 行号以写方案时的代码为准，代码有变动时请按函数名定位。

## 目标

1. **访客 → 站长**：访客在私聊里长按某条消息、点了 👍，站长这边**对应的那条消息上也出现 👍**（由 Bot 用 `setMessageReaction` 加上去）。**不额外发通知消息。**
2. **站长 → 访客**：站长在通知群话题里（或 Bot 私聊推送里）长按访客的消息、点了 👍，访客那边**他自己的原消息上也出现 👍**。
3. 取消回应时，另一边的回应同步消失。
4. **面板聊天窗口**：在对应气泡下面显示双方的表情回应。
5. **面板显示贴纸**：访客发来的贴纸，面板里直接显示贴纸图片，不再只显示「[贴纸 😂]」文字。

## 一、Telegram 接口要点（已对照 Bot API 官方文档）

- 更新类型 `message_reaction`（对象 `MessageReactionUpdated`）：**必须在 `allowed_updates` 里明确列出才会推送**，默认不推送。字段：`chat`、`message_id`、`user`（匿名时为空，此时有 `actor_chat`）、`date`、`old_reaction`、`new_reaction`。
- `ReactionType` 三种：`emoji`（有 `emoji` 字段，只能是 Telegram 规定的那批表情）、`custom_emoji`（有 `custom_emoji_id`）、`paid`。
- 文档写的是「Bot 必须是该聊天的管理员」，**没有明确提到私聊**。已知其他 Bot 在私聊里能收到，但**实现后必须用真 Bot 实测**；收不到的话，这一方向就静默不生效，不能报错。
- **Bot 自己设置的回应不会再推送给 Bot**，所以同步不会形成死循环。
- `setMessageReaction(chat_id, message_id, reaction, is_big)`：Bot **每条消息最多一个回应**，**不能用付费回应**；自定义表情 Bot 用不了（Bot 不是会员）。`reaction: []` 表示清除 Bot 的回应。
- 群可能限制了允许的表情；设置失败（如 `REACTION_INVALID`）时**静默忽略**，不影响其他流程。

## 二、订阅表情回应事件

1. `src/worker/index.js` 的 `/setup`：`allowed_updates` 改为 `['message', 'edited_message', 'callback_query', 'message_reaction']`。把这个列表提成常量 `WEBHOOK_ALLOWED_UPDATES`，两处共用。
2. **老用户不用重跑 `/setup`**：在 `syncTelegramBotSurface`（保存设置时会调用）里：
   - 调 `getWebhookInfo`。如果 `url` 非空、且 `allowed_updates` 里没有 `message_reaction`，就用**同一个 `url`**、`secret_token: env.WEBHOOK_SECRET` 和新列表重新 `setWebhook`。
   - 没有配置 `WEBHOOK_SECRET` 时**不要自动重设**（否则会把原来的密钥校验去掉），只在设置页提示「请重新运行一次 /setup 以启用表情回应同步」。
   - 结果记一次 KV 标记 `webhook:updates_rev = 1`，已经补过就不再查，避免每次保存设置都多一次 Telegram 调用。
3. Webhook 路由：`handleTelegramUpdate` 里新增 `if (update.message_reaction) { await handleMessageReaction(...); return; }`。

## 三、消息对应关系

每个方向都要从「被回应的那条消息」找到「另一边对应的那条」，且只找已知的对应，**找不到就什么也不做，绝不猜测**。

### 方向 A：访客在私聊里回应（`chat.type === 'private'`，`chat.id` 是访客）

在 `history:{uid}.pmMessageIds` 里按 `id === message_id` 找条目：

| 被回应的消息 | 条目特征 | 站长这边对应的消息 |
| :--- | :--- | :--- |
| 站长在话题里直接回复 | `sender: 'admin'`，`topicMsgId` = 站长在话题里那条 | 通知群里的 `topicMsgId` |
| 站长在面板里回复 | `sender: 'admin'`，`topicMsgId` = 话题里的同步副本 | 通知群里的 `topicMsgId` |
| 站长在 Bot 私聊里引用回复（dm 模式） | `sender: 'admin'`，有 `dmMsgId` | 主人私聊里的 `dmMsgId` |
| 访客回应自己发的消息 | `sender: 'visitor'`，有 `topicCopyId` | 通知群里的 `topicCopyId`（话题模式）；dm 模式见下 |

- 通知群里的消息 `chat_id` 用当前绑定的群；主人私聊里的用 `getOwnerChatId(env)`。
- **dm 模式下访客回应自己的消息**：现在没有记录「访客消息 → 主人私聊里那份副本」的编号。在 `pushToOwner` 里复制成功后，把 `copiedMsgId` 记进这条访客记录（字段 `dmCopyId`，写进已有的 `recordVisitorExchange`，**不增加写入**）。
- 话题被删除重建后，旧的 `topicMsgId` 可能不在新话题里，设置失败会被静默忽略，正常。

### 方向 B：站长在通知群或主人私聊里回应

- **通知群**（`chat.id` 是绑定的群）：只处理 `user` 是管理员（`isUserAdmin`）的回应。回应的是访客消息的副本时，要能从「群里的消息编号」找到「访客 + 访客原消息编号」。
  - `message_reaction` **不带话题编号**，没法从话题反查访客，所以要加一个反查表：访客消息复制进话题时（`forwardMessageToTopic` 成功后），写 KV `tmsg:{topicCopyId}` = `{"u": uid, "p": 访客原消息编号}`，`expirationTtl` 30 天。
  - 这是**每条访客消息多 1 次 KV 写入**，在 README 的成本说明里注明。
  - 回应的是站长自己的消息或面板回复的副本时：忽略，那些消息访客那边本来就是 Bot 发的。
- **主人私聊**（dm 模式，`chat.id` 是主人）：回应的是访客消息的复制件时，用已有的 `dmmap:{ownerMsgId}` 找访客。现在 `dmmap` 的值只有 uid，要扩展成 JSON `{"u": uid, "p": 访客原消息编号}`。
  - **兼容旧数据**：读到纯数字字符串时当作只有 uid，这种情况不同步回应，只是跳过。
  - 只给访客消息的副本写 `p`；卡片、站长自己的消息不写 `p`，回应它们时跳过。

### 设置回应

- 取 `new_reaction` 里**最后一个** `type === 'emoji'` 的表情，调 `setMessageReaction(对应 chat_id, 对应 message_id, [{ type: 'emoji', emoji }])`。
- `new_reaction` 里没有普通表情（为空，或者只有自定义表情、付费回应）：调 `setMessageReaction(..., [])` 清除。
- 全部 `try/catch`，失败静默。

## 四、面板显示回应

- 在 `history:{uid}.messages` 对应的条目上存：
  - `visitorReaction`：访客给这条点的表情；自定义表情存 `'✨'`；没有就删掉这个字段。
  - `ownerReaction`：站长给这条点的表情，同上。
- 通过 `pmMessageId`（方向 A，以及方向 B 已经找到的访客原消息编号）定位到具体条目。每次回应 **1 次读 + 1 次写** `history:{uid}`，写之前重新读，和撤回一样，避免覆盖并发写入。
- `VisitorsTab.jsx`：在气泡下方的 `chat-meta` 区显示小表情。访客点的显示在站长气泡下面，站长点的显示在访客气泡下面，鼠标悬停提示「对方的回应」或「我的回应」。

## 五、面板显示贴纸

- `recordVisitorExchange` 里，消息是贴纸时，`addedMessage` 新增：
  - `stickerFileId`：`msg.sticker.file_id`。
  - `stickerFormat`：`is_animated` 为 `tgs`，`is_video` 为 `webm`，否则 `webp`。
  - `mediaTag` 保留，作为加载失败时的文字兜底。
- 面板历史接口：贴纸 `file_id` 和图片一样**签名后再返回**，复用 `signMediaToken`，给出 `stickerUrl`。**不要直接暴露未签名的 `/api/sticker/:fileId` 给访客数据**：那个接口目前是给徽章用的公开接口，访客发来的贴纸属于聊天内容，要走和图片一样的签名代理（`/api/media/...`），并确认签名代理能正确返回 `tgs`、`webm` 内容。
- `VisitorsTab.jsx`：气泡里有 `stickerUrl` 时，用 `web/src/components/Emblems.jsx` 里现成的 `TgStickerMedia` / `LottieSticker` 显示（尺寸约 120px）。如果它们只接受 `fileId`，就加一个接受 `src` 的参数。贴纸气泡去掉背景色，看起来和 Telegram 里一样。
- 只改访客发来的贴纸；站长从话题里回复的贴纸也会被记录，一样显示。

## 六、测试（`tests/worker.test.js`）

1. `/setup` 注册的 `allowed_updates` 包含 `message_reaction`。
2. 保存设置时：旧 Webhook 缺少 `message_reaction` 会用相同的 url 和 `secret_token` 重设；已经有了就不重设；没有 `WEBHOOK_SECRET` 时不重设；`webhook:updates_rev` 标记生效后，不再调用 `getWebhookInfo`。
3. **方向 A**：访客回应站长在话题里的回复、面板回复的副本、dm 模式下的主人消息，分别对正确的 `chat_id` 和 `message_id` 调用 `setMessageReaction`；取消回应时调用并传 `reaction: []`。
4. 方向 A 找不到对应记录时，不调用任何 Telegram 接口。
5. **方向 B**：管理员在群里回应访客副本，会对访客私聊的原消息调用 `setMessageReaction`；非管理员的回应被忽略；回应站长自己的消息被忽略。
6. dm 模式：主人回应访客复制件，同步到访客原消息；旧格式的 `dmmap`（纯 uid）只跳过、不报错。
7. 自定义表情、付费回应：不调用设置接口（或调用清除），面板里存 `'✨'`。
8. `setMessageReaction` 返回错误时，整个更新处理不抛错。
9. 面板历史：回应写进了对应条目，历史接口返回 `visitorReaction` / `ownerReaction`。
10. 贴纸：记录了 `stickerFileId` 和 `stickerFormat`，历史接口返回签名的 `stickerUrl`，三种格式都正确。
11. **回归测试**：现有的 99 个测试全部通过，一个都不能删、不能改弱。

**验收**：`npm test && npm run build` 全部通过。合并后用真 Bot 实测：
- 访客点 👍：站长这边对应的消息上出现 👍；访客取消后消失。
- 站长在话题里点 👍：访客那边他自己的原消息上出现 👍。
- 面板气泡下面显示这些回应，访客发的贴纸能看到图片。
- **私聊里如果收不到回应**（Telegram 不推送），记录下来告诉站长，这一方向的功能静默不生效即可。

## 七、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/index.js` | `WEBHOOK_ALLOWED_UPDATES` 常量；`/setup` 使用 |
| `src/worker/bot.js` | `handleMessageReaction`（两个方向）；`syncTelegramBotSurface` 自动补订阅；`forwardMessageToTopic` 写 `tmsg:` 反查表 |
| `src/worker/inbox.js` | `dmmap` 值扩展为 JSON，兼容旧格式；记录 `dmCopyId` |
| `src/worker/visitors.js` | 回应写入历史条目；贴纸字段；历史接口签名 `stickerUrl` |
| `src/worker/api.js` | 历史接口返回贴纸签名地址（如果签名在这里做） |
| `web/src/components/VisitorsTab.jsx` | 显示回应和贴纸 |
| `web/src/components/Emblems.jsx` | 贴纸组件支持直接传 `src`（如需要） |
| `web/src/styles/theme.css` | 回应小表情和贴纸气泡样式 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`（v1.9.0 未发布）、`WhatsNew`、`README`、`README_EN`：说明表情回应同步和每条访客消息多 1 次 KV 写入 |
