# 05 · 历史检索（history-store / tools/history）

历史功能回答一个问题：**换窗之后，模型怎样找回被摘要掉的精确信息？**
答案是：直接读调用者自己的不可变会话日志，不建第二份索引，也不复制正文。

## 设计取舍

| 选择 | 理由 | 代价 |
| --- | --- | --- |
| 只读原始日志 | 不重复存储、不会与 DSH 的日志不一致 | 每次查询要扫描事件 |
| `item_<seq>` 作为稳定地址 | seq 是日志的天然主键，恢复后不变 | 地址不表达语义 |
| 分页 + 扫描上限 | 防止一次工具调用把上下文撑爆 | 深分页需要多次调用 |
| 不提供跨会话读取 | 会话隔离是硬边界 | 不能“查另一个会话” |
| 文本与 JSON 两种读取 | 文本省 token，JSON 保留原始结构 | 两套输出契约 |

## 地址模型

- 每条可寻址事件地址为 `item_<seq>`，例如 `item_42`；
- 只有 `ADDRESSABLE_EVENT_TYPES` 里的类型可读：
  - 聊天类：`user/message`、`assistant/message`、`tool/result`、`tool/code-dispatch`、`tool/call`、`system/message`、`developer/message`；
  - 记录类：`compaction/summary`、`goal/change`、`todo/write`。
- 记录类的角色统一投影为 `system`，内容分别是摘要文本、goal JSON、todo JSON；
- `history_read` 的 `format: "json"` 返回**完整原始事件**（包括 `rawOutput`、调用参数、元数据）。

窗口消息里打印的 `item_<seq>` 都来自这里，所以模型看到的 ID 一定能被 `history_read` 解析。

## 窗口目录

`history_search({ scope: "windows" })` 返回 `SessionStateStore` 里的窗口数组：

```json
{ "windows": [{ "window_id": "win_002", "start_seq": 41, "end_seq": 88, "item_count": 12,
  "summary_item_id": "item_40", "created_at": "…" }],
  "has_more": true, "next_cursor": 0 }
```

- 默认最新在前（`recent_first: true`），`cursor` 是窗口数组下标；
- 每页最多 50；
- 只接受 `cursor`、`limit`、`recent_first`，混用其他过滤参数会报错。

## 消息查询

`history_search({ query? , role?, tool_name?, tool_namespace?, window_id?, limit?, cursor?, ... })`：

- 无 `query` → 列出条目；有 `query` → 字面量搜索（默认大小写敏感）；
- `window_id` 把扫描限定在某个窗口的 seq 区间；
- 结果里带 `truncated_content`、`offset_chars`、`total_chars`，提示这是节选；
- 扫描上限：2000 个事件、2,000,000 字符输入、12,000 字符输出、每页最多 50 条；
- `has_more` / `next_cursor` 让模型继续翻页。

**为什么有扫描上限？** 历史可能很长，一个 `query` 命中很晚的事件时，不能把整个日志读进内存再拼结果。
上限保证单次调用有界；找不到时返回 `has_more: true`，让模型用 `next_cursor` 继续。

## 单条读取

`history_read({ item_id, format?, offset_chars?, limit_chars? })`：

- 文本模式返回投影后的正文（默认 8000 字符，最多 20000）；
- JSON 模式返回完整事件；
- 支持字符分页（`offset_chars` / `limit_chars`），用于读很长的工具输出；
- `window_id` 可选，用于校验条目属于该窗口；
- 找不到时返回 `{ error: "History item not found ..." }`，而不是抛错。

## 工具契约

| 工具 | 参数要点 | 输出 |
| --- | --- | --- |
| `history_search` | `scope`（messages/windows）、`query`、`window_id`、`role`、`tool_name`、`tool_namespace`、`limit`、`recent_first`、`cursor`、`max_chars_per_item`、`case_sensitive` | `items` / `matches` / `windows` + `has_more` + `next_cursor` |
| `history_read` | `item_id`（必填）、`window_id`、`offset_chars`、`limit_chars`、`format` | 正文或完整事件 + 分页字段 |

两个工具都拒绝 `agent_name`：宿主运行时可能传入未声明的参数，处理器显式拒绝，避免被当成会话选择器。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| `item_id` 非法或越界 | 返回 `null` / `error`，不抛异常 |
| 查询为空或超长 | 抛错（模型可见） |
| 窗口不存在 | 返回空结果 + `has_more: false` |
| 事件类型不可寻址 | 返回 `null` |
| 会话已恢复但状态未折叠 | `states.get()` 会先折叠到最新 |

## 修改时注意

- 新增可寻址事件类型 → 同时改 `HISTORY_EVENT_TYPES` / `ADDRESSABLE_EVENT_TYPES`、`eventInfo` 的投影、preflight 的 `session log types` 检查。
- 改分页字段 → 同步 README 的 Tools 表、两份 README 的示例、`test/history.test.js`。
- 不要在查询里调用 `session.append` 或任何写操作；`HistoryStore` 是只读视图。
- 不要缓存查询结果：日志是只追加的，缓存会与恢复后的会话不一致。
