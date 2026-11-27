# 实现方案：聊天数据迁移到 D1（v2.0 – v2.2）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> 这是一次**底层存储迁移**，影响几乎所有核心文件。**最高原则：不丢数据、不让任何老用户的部署坏掉。**
> 文中涉及 Cloudflare 行为的地方，标了「⚠️ 必须实测」的，都要先用真实部署或官方文档确认，**不能凭猜测实现**。

## 背景和目标

现在所有数据都在 Workers KV（绑定名 `TOPIC_MAP`）里。KV 有三个问题：

1. **写入额度小**：免费套餐每天只有 1,000 次写入。每条访客消息要写好几次（聊天记录、访客资料、索引、缓存、频率限制、话题对应表……），访客一多就不够用。
2. **最终一致**：在一个机房写入，其他机房最多约 60 秒后才能读到。面板里「对方回复了却迟迟不显示」，有一部分原因就在这里。
3. **不能搜索**：只能按键整块读取，每个访客只保留最近 60 条消息，无法按关键词、时间、访客搜索聊天记录。

**D1**（Cloudflare 的 SQLite 数据库）免费额度大得多（每天 10 万行写入、500 万行读取），写入后立刻能读到，还支持 SQL 查询。

**目标**：把高频写入的数据搬到 D1，配置这类很少改动的数据继续留在 KV；**没有绑定 D1 的部署照旧使用 KV，功能完全不受影响**。

### 数据归属：每个部署者用自己的 D1

和 KV 一样，D1 建在**部署者自己的 Cloudflare 账号**里，用部署者自己的免费额度，数据不经过任何第三方。项目作者看不到、也不需要为任何人的数据付费。

## 总体设计

### 1. 存储层：有 D1 用 D1，没有就用 KV

新增目录 `src/worker/store/`：

```
src/worker/store/
  index.js          getStore(env)：env.DB 存在 → D1 实现；否则 → KV 实现
  kvStore.js        现有 KV 读写逻辑原样搬进来（行为不变）
  d1Store.js        D1 实现
  d1Schema.js       建表语句与 ensureSchema(env)
  migrate.js        KV → D1 迁移（单个访客 / 批量）
```

- 业务代码（`visitors.js`、`bot.js`、`inbox.js`、`api.js`）**不再直接读写这几类数据的 KV 键**，统一调用存储层接口。
- **两种实现对外行为必须完全一致**，包括返回的数据结构：历史接口返回给前端的 `messages`、`photos`、`links` 格式不变，前端不用改。
- 每个阶段的接口在下面各阶段里列出。

### 2. 建表：程序自动完成

- `ensureSchema(env)`：用 `env.DB.batch([...])` 执行全部 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。在同一个 Worker 实例里只执行一次（模块级 Promise 缓存），每次 D1 操作前 `await` 它。
- 表 `meta(key TEXT PRIMARY KEY, value TEXT)` 记录 `schema_version`。以后加字段时，按版本号执行 `ALTER TABLE`，不要删表重建。
- 部署者**不需要**手动执行任何 SQL。

### 3. 迁移：自动、渐进，KV 旧数据不删

- **按需迁移（自动）**：D1 实现读取某个访客的数据时，如果 D1 里没有、且这个访客还没迁移过（查表 `migrated_visitors`），就读出 KV 里的数据、批量写进 D1、标记为已迁移，再返回。整个过程对用户无感知。
- **一键迁移（手动）**：设置页提供「一键迁移全部访客」按钮，调用 `POST /api/admin/storage/migrate`。**每次请求只迁移一小批**（例如 20 个访客），返回进度 `{ done, total, finished }`，前端循环调用直到完成。这样单次请求不会超出 Worker 的 CPU 时间和子请求数限制。
- **KV 里的旧数据一律保留，不删除**，至少保留到 v2.2 之后，作为备份。
- **对应表类数据**（`tmsg:*`、`dmmap:*`）本身有过期时间，不迁移：D1 查不到时，**回退去 KV 查一次**，查到就照常用。这个回退在 v2.2 之后删除。

### 4. 部署：尽量零操作

- `wrangler.toml` 新增：

  ```toml
  [[d1_databases]]
  binding = "DB"
  database_name = "rose-panel-bot"
  # database_id 不写，交给 Wrangler 自动创建
  ```

- ⚠️ **必须实测**：不写 `database_id` 时，下面三种部署方式能否**自动创建并绑定** D1：
  1. 本地 `npx wrangler deploy`；
  2. Cloudflare Workers Builds（Git 连接自动构建，作者本人用的就是这种）；
  3. README 里的「Deploy to Cloudflare」按钮。

  哪种不行，就在 README 和设置页写清楚手动步骤：Cloudflare 后台 → D1 → 创建数据库 → 在 Worker 的「设置 → 绑定」里绑定为 `DB`。
- ⚠️ **必须实测**：老用户通过 Fork 同步拿到新版 `wrangler.toml` 后，Workers Builds 重新部署时，**现有的 KV 绑定、环境变量和密钥不能丢**（`keep_vars = true` 已经在用，确认它也覆盖新增绑定的情况）。
- 设置页新增「数据存储」状态：
  - 已绑定 D1：显示「D1 · 已迁移 x / y 个访客」和「一键迁移」按钮。
  - 未绑定：显示「KV（未绑定 D1）」和一行说明，带上手动绑定的步骤链接。

### 5. 出错时怎么办

- **绑定了 D1，D1 就是唯一可信的数据源**。D1 操作失败时按现有代码处理 KV 失败的方式处理：能静默的静默（比如对应表写入），该报错的报错（比如面板发消息）。**不要写到一半自动切回 KV**，否则两边数据会不一致。
- 没有绑定 D1：完全走 KV 实现，行为和 v1.9 一模一样。

### 6. 一致性

D1 默认所有查询都发往主数据库，写完立刻能读到。**不要开启 D1 的读副本（read replication / Sessions API）**，那会重新引入延迟一致的问题。

## 阶段一：v2.0 — 聊天记录和对应表搬到 D1

### 表结构

```sql
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,          -- 现有 m_xxx 格式
  uid              TEXT NOT NULL,             -- 访客 Telegram UID
  sender           TEXT NOT NULL,             -- 'visitor' | 'admin'
  pm_message_id    INTEGER,                   -- 访客私聊里的消息编号
  topic_msg_id     INTEGER,
  topic_copy_id    INTEGER,
  topic_thread_id  INTEGER,
  topic_chat_id    TEXT,
  dm_msg_id        INTEGER,
  dm_copy_id       INTEGER,
  text             TEXT,
  media_tag        TEXT,
  photo_file_id    TEXT,
  thumb_file_id    TEXT,
  sticker_file_id  TEXT,
  sticker_format   TEXT,
  visitor_reaction TEXT,
  owner_reaction   TEXT,
  created_at       INTEGER NOT NULL           -- 毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_messages_uid_time ON messages(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_uid_pm ON messages(uid, pm_message_id);

CREATE TABLE IF NOT EXISTS message_links (
  message_id TEXT NOT NULL,
  uid        TEXT NOT NULL,
  url        TEXT NOT NULL,
  sender     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_uid_time ON message_links(uid, created_at);

CREATE TABLE IF NOT EXISTS topic_map (       -- 替代 KV 的 tmsg:*
  group_id       TEXT NOT NULL,
  topic_msg_id   INTEGER NOT NULL,
  uid            TEXT NOT NULL,
  pm_message_id  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (group_id, topic_msg_id)
);

CREATE TABLE IF NOT EXISTS dm_map (          -- 替代 KV 的 dmmap:*
  owner_msg_id   INTEGER PRIMARY KEY,
  uid            TEXT NOT NULL,
  pm_message_id  INTEGER,                    -- 卡片、站长消息为 NULL
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migrated_visitors (
  uid         TEXT PRIMARY KEY,
  migrated_at INTEGER NOT NULL
);
```

说明：

- 现在 KV 里每个访客的聊天记录分成 `messages`、`pmMessageIds`、`photos`、`links` 四个数组。D1 里**统一成一张 `messages` 表**，每次收发一行。照片就是 `photo_file_id` 不为空的行，链接单独放 `message_links`。
- 存储层负责把查询结果**拼回**现在的数据结构，前端和历史接口的返回格式完全不变。
- **D1 不再限制条数**：KV 只留最近 60 条消息、200 个消息编号，D1 全部保留。历史接口默认仍只返回最近 60 条，翻页留到 v2.1。

### 存储层接口（阶段一）

| 接口 | 替代现在的 |
| :--- | :--- |
| `appendExchange(uid, entry)` | `recordVisitorExchange` 里对 `history:{uid}` 的读改写 |
| `getHistory(uid, { limit })` | `getVisitorHistory` |
| `findPmEntry(uid, pmMessageId)` | 各处在 `pmMessageIds` 里按编号查找（撤回、表情同步） |
| `findLatestVisitorTopicCopy(uid, threadId)` | `findLatestVisitorTopicMessage` |
| `attachTopicMirror(uid, pmMessageId, topicMsgId, topicChatId)` | 同名函数 |
| `removeAdminMessage(uid, pmMessageId)` | `recallAdminVisitorMessage` 里改历史的部分 |
| `setReaction(uid, pmMessageId, role, value)` | `updateVisitorMessageReaction` |
| `clearHistory(uid, mode)` | `clearVisitorHistory` 里改历史的部分 |
| `putTopicMap(groupId, topicMsgId, uid, pmId)` / `getTopicMap(groupId, topicMsgId)` | `tmsg:*` |
| `putDmMap(ownerMsgId, uid, pmId)` / `getDmMap(ownerMsgId)` | `dmmap:*`（`saveDmMessageMap` / `lookupDmMessageEntry`） |

- 访客资料 `user:{uid}` 里的计数（`photo_count`、`link_count`、消息数）在阶段一**仍然写 KV**，阶段三再搬。
- `appendExchange` 在 D1 里用 `env.DB.batch()` 一次写完消息和链接。

### 对应表的过期清理

KV 的对应表靠 `expirationTtl` 自动过期，D1 没有这个功能。在现有的定时任务（`index.js` 的 `scheduled`，每 5 分钟一次）里，**每天只执行一次**清理（用当前时间判断，不额外写 KV 记录）：

- `topic_map` 删除 30 天前的行；
- `dm_map` 删除 7 天前的行。

清理要在「掉线告警关闭」时也照常执行，但没有绑定 D1 时直接跳过。

### 阶段一验收

- 绑定 D1：收发消息、面板聊天、撤回、表情同步、贴纸、话题引用回复，全部和 v1.9 行为一致；每条访客消息带来的 KV 写入明显减少。
- 不绑定 D1：一切和 v1.9 完全一样。
- 老数据：老访客第一次打开聊天记录时自动迁移；一键迁移能把全部访客搬完；KV 旧数据还在。

## 阶段二：v2.1 — 聊天记录搜索与完整历史

前提：阶段一已经在真实部署上稳定运行。

- **完整历史翻页**：`GET /api/admin/visitors/:uid/history?before=<时间戳>&limit=60`，面板聊天窗口滚到顶部时加载更早的消息。
- **搜索**：`GET /api/admin/search?q=关键词&uid=&from=&to=`，按关键词、访客、时间范围搜索，结果点开直接跳到对应的聊天位置。
  - 第一版用 `LIKE '%关键词%'`，加 `LIMIT`，对 `q` 做长度限制，并转义 `%`、`_`。
  - ⚠️ **必须实测**：D1 是否支持 SQLite 的 FTS5 全文索引。支持的话，作为后续优化；不支持就继续用 `LIKE`。
- 面板「访客」页顶部新增搜索框。
- **只有绑定了 D1 才显示搜索和翻页**；KV 模式下隐藏入口，或提示「绑定 D1 后可用」。
- 设置里加「聊天记录保留时长」：永久 / 1 年 / 6 个月，默认永久。按设置在每日清理任务里删除过期消息。

## 阶段三：v2.2 — 访客资料、计数和频率限制搬到 D1

```sql
CREATE TABLE IF NOT EXISTS visitors (
  uid TEXT PRIMARY KEY,
  data TEXT NOT NULL,            -- 现在 user:{uid} 的 JSON 原样存放
  last_seen_at INTEGER,
  source TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visit_seen (
  month TEXT NOT NULL, uid TEXT NOT NULL,
  PRIMARY KEY (month, uid)
);
```

- `user:{uid}` 改存 `visitors` 表。访客列表、`visitors:index`、摘要缓存 `cache:visitor_summary` 都改为 SQL 查询，不再需要索引键和缓存。
- **频率限制**（`checkRateLimit`）：现在每条访客消息都会因为 `rl:msg:*` 写一次 KV，是 KV 写入的大头。改用 `rate_limits` 表，用一条 `INSERT ... ON CONFLICT DO UPDATE` 原子地加一。过期行在每日清理时删除。
- **本月访客数**：`visit_seen` 用 `INSERT OR IGNORE`，计数用 `COUNT(*)` 现场统计。顺便修掉 KV 版本「同时打开可能少算 1 人」的问题。
- 这一阶段完成后，删除阶段一里「对应表回退查 KV」的代码。
- **以下数据继续留在 KV**：`config:panel`、`config:supergroup_id`、人机验证的临时状态（`chal:*`、`verify_cool*`、`await_*`、`needs_verify:*`、`verified:*`、`banned:*`）、`cas:*`、各种 `cache:*`、`alert:*`、`webhook:*`、`dm:*`。它们读多写少，或者需要自动过期，KV 更合适。

## 测试要求

- **用 Node 内置的 `node:sqlite` 写一个 D1 兼容的测试替身**（`tests/helpers/d1Shim.js`）：实现 `prepare(sql).bind(...).all()` / `.first()` / `.run()` 和 `batch([...])`，底层用 `new DatabaseSync(':memory:')`。本机 Node 是 v24，自带这个模块。
  - ⚠️ 如果 CI 或其他环境的 Node 版本没有 `node:sqlite`，改用 `@cloudflare/vitest-pool-workers`（Miniflare）跑真实的 D1。选哪种，在 PR 里说明理由。
- **现有的 112 个测试一个都不能删、不能改弱**，并且要在 **KV 模式和 D1 模式下各跑一遍**（例如用 `describe.each(['kv', 'd1'])` 包一层，或者用一个测试环境变量切换）。两种模式的行为必须一致。
- 新增测试至少覆盖：
  1. `ensureSchema` 重复执行不报错，`schema_version` 正确。
  2. 按需迁移：KV 里有历史、D1 里没有时，第一次读取自动迁移，返回内容和 KV 版本一致；第二次读取不再读 KV。
  3. 一键迁移：分批推进、进度正确；中途失败后重跑，不产生重复数据（`migrated_visitors` 加主键冲突保护）。
  4. 对应表回退：D1 查不到时回退 KV 能查到；D1 和 KV 都没有时什么都不做。
  5. 每日清理只删过期的对应表行。
  6. 没有 `env.DB` 时完全走 KV，结果和 v1.9 一致。
  7. 阶段二的搜索：关键词转义（`%`、`_`）、`LIMIT` 生效、只能由管理员调用。
  8. 阶段三的频率限制：并发下计数正确、过期后重置。

**验收**：每个阶段都要 `npm test && npm run build` 全部通过，`npx wrangler deploy --dry-run` 能正确显示 `DB` 绑定。

## 上线节奏

**三个阶段分三个 PR、分三次发布**，不要一次性做完再一起上线：

1. 底层存储一旦出问题，影响的是所有人的聊天记录。分开上线，出问题时能立刻知道是哪一步引起的，回退也只需要退一小步。
2. 阶段一只换底层、**不改任何功能**，最适合用来验证「D1 读写、自动迁移、未绑定时退回 KV」这套机制在真实部署上是否可靠。它稳定了，后面两步才有可靠的基础。
3. 每个 PR 都比较小，审查更仔细，漏掉问题的可能更小。

每个阶段的流程：实现 → 开 PR → 审查 → 合并 → 作者在自己的 Bot 上实测几天 → 再开始下一阶段。

## 改动范围一览（阶段一）

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/store/*` | 新增：存储层、KV 实现、D1 实现、建表、迁移 |
| `src/worker/visitors.js` | 聊天记录相关读写改调存储层 |
| `src/worker/bot.js` | `tmsg` 对应表、撤回、表情同步、面板回复改调存储层 |
| `src/worker/inbox.js` | `dmmap` 对应表改调存储层 |
| `src/worker/api.js` | 历史接口改调存储层；新增迁移接口和存储状态 |
| `src/worker/index.js` | 每日清理任务 |
| `wrangler.toml` | `[[d1_databases]]` 绑定 |
| `web/src/components/SettingsDrawer.jsx` | 「数据存储」状态和一键迁移 |
| `tests/helpers/d1Shim.js` | 新增：D1 测试替身 |
| `tests/worker.test.js` | KV / D1 双模式运行，新增用例 |
| 文档 | `CHANGELOG`、`README`、`README_EN`、`AGENTS.md`（部署步骤、升级说明里的「升级不碰 KV」改成「KV 数据保留，聊天数据自动迁移到 D1」） |
