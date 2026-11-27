# 实现方案：探针掉线告警（v1.8）

> 给实现者（AI 编码助手或人类开发者）：请先通读本文和根目录的 `AGENTS.md`，再动手。
> 本方案依赖 v1.7 的 `resolveInboxMode`（见 `docs/plans/dm-inbox.md`），请在 v1.7 合并之后再实现。
> 文中的行号以写方案时的 `main`（`e04fb23`）为准，代码有变动时请按函数名定位。

## 目标

节点掉线、恢复，或资源持续超过阈值时，Bot 主动通知站长。

- **整个功能默认关闭**，在小程序 **⚙️ 设置 → 节点探针 → 掉线告警** 里一键打开。
- 关闭时，定时任务读一次配置就立即退出，**不请求探针，不写 KV**。
- 演示模式（`demoMode`）或没配置探针时，永远不发告警。

## 一、定时触发

- `wrangler.toml` 增加：

  ```toml
  [triggers]
  crons = ["*/5 * * * *"]
  ```

  Cloudflare 免费套餐支持 Cron Trigger。用 Git 集成部署的用户，合并后会自动生效。
- `src/worker/index.js` 的默认导出里增加 `scheduled(event, env, ctx)`，调用 `ctx.waitUntil(runProbeAlerts(env, event.scheduledTime))`。
- **检测间隔**：设置里可选 5、10、15、30 分钟，Cron 固定每 5 分钟触发一次。用 `Math.floor(scheduledTime / 60000) % interval` 判断这一轮跑不跑，**不需要为记录「上次运行时间」写 KV**。

## 二、新增 `src/worker/alerts.js`

### `runProbeAlerts(env, scheduledTime)`

1. 读取配置（`loadPanelConfig`）。`probe.alerts.enabled !== true`、`demoMode`、没有 `probe.url`，或这一轮不在检测间隔上，就直接返回。
2. 调用 `fetchProbeStatus(env, probe, { forceRefresh: true, skipCacheWrite: true })` 拉取最新数据。
   - **需要给 `fetchProbeStatus`（`src/worker/komari.js`）新增 `skipCacheWrite` 选项**：现在每次拉取都会写一次探针缓存，定时任务如果也写，每 5 分钟一次就是每天 288 次写入，会吃掉免费额度（每天 1000 次）的近三成。
3. 读取告警状态 `alert:state`，和本次结果对比（规则见第三节），得出要发的通知。
4. **只有状态发生变化时才写回 `alert:state`**。一切正常时，一轮检测零写入。
5. 发送通知（见第四节）。

### 告警状态 `alert:state`（单个 JSON）

```json
{
  "probeDown": { "misses": 0, "notified": false, "since": null },
  "nodes": {
    "<uuid>": {
      "name": "东京 01",
      "online": true,
      "misses": 0,
      "notifiedOffline": false,
      "offlineSince": null,
      "breach": { "cpu": 0, "ram": 0, "disk": 0 },
      "notifiedBreach": { "cpu": false, "ram": false, "disk": false }
    }
  }
}
```

探针返回的节点列表里已经没有的 uuid（节点被删了），要从状态里清掉。

## 三、告警规则

| 事件 | 触发条件 | 通知 |
| :--- | :--- | :--- |
| **节点掉线** | 连续 `confirmChecks` 次（默认 2）检测到 `online === false` | `🔴 节点掉线：东京 01（已离线约 10 分钟）` |
| **节点恢复** | 之前通知过掉线，现在 `online === true` | `🟢 节点恢复：东京 01（离线 37 分钟）`。可以在设置里关掉恢复通知 |
| **探针本身连不上** | 连续 `confirmChecks` 次返回 `protocol === 'error'` | `⚠️ 探针连接失败：<错误信息>`。**连不上期间不判断任何节点**，避免一次性刷出所有节点的掉线告警；恢复连接时发 `✅ 探针已恢复连接` |
| **资源告警**（单独开关，默认关闭） | CPU、内存或磁盘连续 `sustainChecks` 次（默认 3）≥ 阈值（默认都是 90%） | `🟠 东京 01 CPU 持续 ≥ 90%（当前 97%）`。降到阈值以下时清除，**不发恢复通知** |

规则要点：

- 首次检测到一个新节点时只记录状态，不发通知。这样刚打开告警时，已经离线的节点不会马上刷屏。
- 被静音的节点（`mutedNodes`，存 uuid）完全跳过。
- **同一事件只通知一次**，用 `notifiedOffline`、`notifiedBreach` 标记去重，恢复后才会重新开始计数。
- 同一轮检测有多条通知时，**合并成一条消息**发送，最多列 10 个节点，超出的写「另有 N 个」。

## 四、通知发到哪里

复用 v1.7 的 `resolveInboxMode(env)`：

| 模式 | 发到 |
| :--- | :--- |
| `topic` | 通知群里专门的「🔔 探针告警」话题。首次需要时用 `createForumTopic` 创建，话题编号存在 `alert:topic_id`；话题被删时（`thread not found`）重建一次 |
| `dm` | 主人私聊（`ADMIN_IDS` 第一个） |
| `off` | 不发，只更新状态 |

- 消息带一个按钮 `📡 打开探针面板`：话题群里用 `buildPanelButton(..., { isGroup: true, startParam: 'probe' })`，私聊里用 `{ isGroup: false, query: 'tab=probe' }`。
- 恢复、探针恢复连接这类通知用 `disable_notification: true`（静默）发送，掉线和连接失败正常响铃。
- 发送失败时吞掉错误，不影响状态写回。

## 五、配置

`src/worker/config.js` 的 `DEFAULT_CONFIG.probe` 新增：

```js
alerts: {
  enabled: false,          // 总开关，默认关闭
  intervalMinutes: 5,      // 5 | 10 | 15 | 30
  confirmChecks: 2,        // 1–5
  notifyRecovery: true,
  mutedNodes: [],          // 节点 uuid 列表
  resource: {
    enabled: false,        // 资源告警单独开关，默认关闭
    cpu: 90, ram: 90, disk: 90,   // 50–100，填 0 表示不检测这一项
    sustainChecks: 3,      // 1–10
  },
},
```

- 在合并配置（`mergeConfig`）和规范化配置时，对上面每个字段做范围钳制和类型校验，写法参照 `pmBot` 现有的处理。
- `sanitizePublicConfig` **不能**返回 `alerts`。只通过 `sanitizeAdminConfig` 给管理员。
- 旧部署升级后 KV 里没有这个字段，会取默认值（关闭），**不需要迁移数据**。

## 六、接口

- `POST /api/admin/probe/alert-test`：用当前的通知方式发一条测试告警，返回发到了哪里（话题群或私聊）、是否成功。**每分钟最多 3 次**（复用 `checkRateLimit`）。
- 现有保存配置的接口已经能保存 `probe.alerts`，确认一下即可。

## 七、前端（`web/src/components/SettingsDrawer.jsx`）

在「节点探针」分区里新增一个「🔔 掉线告警」折叠块：

1. **总开关**，默认关闭。关闭时下面所有选项都折叠隐藏。
2. 检测间隔（下拉）、确认次数（数字）、恢复通知（开关）。
3. 资源告警：开关，加 CPU、内存、磁盘阈值和持续次数。
4. 静音节点：从当前探针节点列表里多选。
5. **发送测试告警**按钮，结果用 toast 提示，例如「已发送到 Bot 私聊」。
6. 一行说明：「通知会发到：通知群『探针告警』话题 / Bot 私聊」，根据 `inboxMode` 显示。通知方式为 `off` 时显示黄色提示「请先配置 ADMIN_IDS 或绑定通知群」，并禁用总开关。

## 八、文档

- `CHANGELOG.md` 写新条目，`WhatsNewModal.jsx` 加对应说明。
- `README.md` 和 `README_EN.md` 的探针一节加上告警说明，并注明「默认关闭」。
- `AGENTS.md` 模块 3 的说明里补一句「可选掉线告警（默认关闭，设置里开启）」。

## 九、成本

| 项目 | 关闭时 | 开启、一切正常时 |
| :--- | :--- | :--- |
| Worker 调用 | 每天 288 次 | 每天 288 次 |
| KV 读取 | 每轮 1 次（配置） | 每轮 2 次（配置 + 状态） |
| KV 写入 | 0 | **0**，只在状态变化时写入 |
| 探针请求 | 0 | 每轮 1 次 |

- 哪吒和 NodeGet 用 WebSocket 拉取数据，耗时主要是等待网络，不占 CPU 时间，免费套餐每次 10ms 的 CPU 上限一般够用。实现后在真实探针上测一次耗时。
- **不做（留到以后）**：静默时段、按节点单独设阈值、流量配额告警、续费到期提醒。到期提醒需要先确认各探针的真实返回里有没有到期字段，**不要凭猜测解析字段**（AGENTS.md 的要求）。

## 十、测试（`tests/worker.test.js`）

1. 总开关关闭：不请求探针、不写 KV。
2. 演示模式或没配置探针：不发告警。
3. 掉线确认：第 1 次检测到离线不通知，第 2 次通知；之后持续离线不再重复通知。
4. 恢复：通知内容带离线时长；关闭恢复通知后不发。
5. 探针连不上：只发一条「探针连接失败」，不发节点掉线；恢复后发「已恢复连接」。
6. 首次检测到的节点即使离线也不通知；静音节点完全跳过。
7. 资源告警：持续次数不够不通知；达到后通知一次；回落后清除。
8. 检测间隔：例如间隔 10 分钟时，只有 `scheduledTime` 落在整 10 分钟上那一轮才运行。
9. 一切正常时一轮检测零 KV 写入；`fetchProbeStatus` 的 `skipCacheWrite` 生效。
10. 通知分发：`topic` 模式会创建并复用告警话题，`dm` 模式发给主人；同一轮多条通知合并成一条。
11. `sanitizePublicConfig` 的结果里不包含 `alerts`。

**验收**：`npm test && npm run build` 全部通过。

## 十一、改动范围一览

| 文件 | 改动 |
| :--- | :--- |
| `src/worker/alerts.js` | 新增，约 200 行 |
| `src/worker/index.js` | 新增 `scheduled` 处理 |
| `src/worker/komari.js` | `fetchProbeStatus` 支持 `skipCacheWrite` |
| `src/worker/config.js` | `probe.alerts` 默认值、校验，只给管理员返回 |
| `src/worker/api.js` | 测试告警接口 |
| `wrangler.toml` | `[triggers]` 定时触发 |
| `web/src/components/SettingsDrawer.jsx` | 掉线告警设置块 |
| `tests/worker.test.js` | 新增用例 |
| 文档 | `CHANGELOG`、`WhatsNew`、`README`、`README_EN`、`AGENTS.md` |
