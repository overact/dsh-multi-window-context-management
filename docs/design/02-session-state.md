# 02 · 会话状态投影（session-state）

## 为什么需要它

DSH 的会话日志是**不可变、只追加**的事件流。插件需要的很多信息（当前窗口、最近用户指令、goal、todo、待执行的换窗请求）
都不是某一条事件直接给出的，而是要从日志里“折叠”出来。

`SessionStateStore` 就是这层折叠：

- **不建第二个数据库、不复制历史正文**。只保留窗口边界、指针和少量摘要文本。
- **每个 `Session` 一份状态**，存在 `WeakMap` 里，随会话对象生命周期回收。
- **增量折叠**：`cursor` 记录已处理到哪个 seq，`get()` 只处理新增事件；恢复会话时从 0 重建。
- **幂等**：重复调用 `get()` 不会重复计数或重复开窗。

```js
const state = states.get(session);   // 折叠到 session.seq
state.windows.at(-1).window_id;      // 当前窗口
state.pending;                       // 待执行的换窗请求
```

## 状态结构

| 字段 | 含义 | 生命周期 |
| --- | --- | --- |
| `cursor` | 已折叠到的下一个 seq | 随日志增长 |
| `notes` | 当前笔记快照（`NotesStore`） | 从仓库加载；写入成功后替换 |
| `windows` | 窗口目录，至少一个 `win_001` | 每次换窗追加 |
| `latestUsers` | 最近 4 条人类指令的 seq | 环形裁剪 |
| `goal` / `goalSeq` | 最近一次 `goal/change` 的 goal 与 seq | 覆盖 |
| `todos` / `todoSeq` | 最近一次 `todo/write` 的清单与 seq | 覆盖 |
| `pending` | 已登记、尚未执行的换窗请求 `{ seq }` | 开窗或失败时清空 |
| `candidates` | 旧版 checkpoint 摘要的候选（`compactionId → { id, previous, summarySeq, record }`） | `compaction/end` 时删除 |
| `summaries` | 未开窗的摘要 seq（`compactionId → seq`），最多 16 条 | 开窗时清空 |
| `openCalls` / `resultNames` | 工具调用 id → 名称，用于把 `tool/result` 关联回工具名 | 逐事件维护 |

窗口对象：

| 字段 | 含义 |
| --- | --- |
| `window_id` | `win_001`、`win_002`…… |
| `start_seq` / `end_seq` | 窗口在日志中的起止 seq（`end_seq` 在换窗时回填） |
| `created_at` | 窗口开始时间 |
| `item_count` | 该窗口内聊天类事件数 |
| `topic` / `latest_user` / `last_assistant` | 窗口概览用的轻量摘录 |
| `summary` / `summary_kind` | 进入该窗口时使用的摘要文本与类型 |
| `summary_item_id` | 摘要事件的 `item_<seq>` 地址 |

## 折叠规则

`fold(state, event)` 按事件类型更新状态：

| 事件 | 处理 |
| --- | --- |
| `assistant/message` | 记录最后一段助手文本；登记 `tool-call` 的 call id → 名称 |
| `tool/result` | 用 call id 或 `sourceEventSeqs` 反查工具名，写入 `resultNames` |
| `todo/write` | 覆盖 `todos` / `todoSeq` |
| `goal/change` | 覆盖 `goal` / `goalSeq`（`clear` 操作没有 `goal` 字段，自然变成 `null`） |
| `compaction/summary` | 记录 `summaries`；识别旧版（≤0.3.x）窗口摘要，写入 `candidates` |
| `user/message` | 识别窗口消息 → 开新窗口；识别旧版 checkpoint → 开新窗口；识别人类指令 → 更新 `latestUsers` 与窗口概览 |
| `compaction/end` | 删除 `candidates`；失败时删除 `summaries` |

`item_count` 只统计 `HISTORY_EVENT_TYPES`（聊天类事件），不把 goal/todo/compaction 算进去。

## 窗口识别的两条路径

1. **新版（v3，当前）**：插件追加的 `user/message` 以 `<context_window id="win_002" previous_window_id="win_001">` 开头，
   第二行是 `<window_record>{...}</window_record>`。`parseWindowMessage()` 校验 `version === 3`、
   `window_id` 与开头标签一致、`summary` 长度 ≤ 1200、`summary_kind` 合法。
2. **旧版（≤0.3.x）**：摘要直接替换了 summary 文本，窗口由 `compaction/summary` 的候选 + 一条
   `source.kind === 'compact-checkpoint'`（或 `source.plugin === 'compact'`）的 user message 共同确认。

只有 `previous === 当前窗口 id` 时才开窗，防止乱序或重复消息推进目录。

## pending 的语义

`pending` 是**内存态**，不是日志事件：

- `new_context` 调 `states.request(session)`，第一次登记 `{ seq: session.seq }`，重复调用返回同一个 seq。
- `agent/pre-step` 发现 `pending` 就执行一次换窗；成功开窗时在 `fold` 里清空。
- 失败、取消、禁用、恢复会话都不会重放未完成的请求——`pending` 随进程消失。
- 禁用插件时，`index.js` 会遍历 `ctx.sessions.list()`，用 `endRequest()` 给每个 pending 会话追加一条可见说明。

这是有意的：换窗请求是“当前 turn 的意图”，不是跨重启的持久任务。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| 笔记快照损坏 | `NoteRepository.load()` 隔离为 `.corrupt-*` 并返回空 store；投影继续 |
| 摘要事件缺失 | 窗口消息不追加（`findSummary` 返回 null），pending 保留到下次 |
| 旧版摘要没有结构化记录 | 仍按旧版路径开窗，`summary_kind = 'legacy'` |
| 同一 compaction 被重复处理 | `previous === 当前窗口` 校验会拒绝第二次 |

## 修改时注意

- **不要在 `fold` 里做 I/O**。它会在每次 `get()` 时同步执行；任何 await/磁盘访问都会拖慢每个 step。
- **新增窗口状态字段时**，同时更新 `window-engine.prepare()`、`history_search(scope=windows)` 的输出和本文件。
- **`session.eventAt(seq)` 是 O(1)**，但 `findSummary` 是向后线性扫描；不要把大范围扫描放进 `fold`。
- **恢复路径**：`Session.fromRestore()` 后第一次 `get()` 会从 0 折叠整个日志，这是设计内的成本；不要缓存到磁盘。
