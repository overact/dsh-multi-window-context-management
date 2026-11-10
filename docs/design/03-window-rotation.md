# 03 · 换窗编排（window-controller / window-engine / window-policy）

这是插件的核心功能：**在 DSH 原生压缩提交之后，追加一条窗口消息，开启下一个窗口。**
压缩本身完全由会话所属 preset 的引擎完成；插件只决定“何时请求一次压缩”和“压缩后补什么”。

## 策略层（window-policy.js）

```js
toolsEnabled(config)  // enabled && injectTools
strategyFor(agent, config)
  // 1. 读 agent.session.requestHeader()?.config（或 agent.options）
  // 2. modelPolicies 里精确匹配 provider + model → 该策略
  // 3. 否则 defaultStrategy（默认 'window'）
```

`active(agent)` 同时要求：`toolsEnabled`、`overrideCompaction`、`strategyFor === 'window'`。
三者缺一，插件只保留工具与提示，不追加窗口消息，压缩回到 DSH 原生行为。

**为什么按精确 provider/model 匹配？** 不从模型名推断能力，也不维护“哪些模型支持长上下文”的名单；
用户显式配置的策略优先，未列出的走默认值。

## 请求路径（new_context）

```text
new_context(args, exec)
  → signal.throwIfAborted()
  → requireSession(exec)
  → flush(session)                 // 确保当前日志已持久化
  → checkEnabled()
  → states.request(session)        // 登记 pending，返回 request_seq
  → { status: 'context_window_requested', request_seq, current_window_id, message }
```

工具**不立即压缩**。它只登记“下一个安全边界换窗”，因为当前 step 的兄弟工具结果可能还没全部落盘；
`agent/pre-step` 才是“上一步已闭合、下一步必然执行”的边界。

## 执行路径（rotatePending）

`lib/index.js` 的 `agent/pre-step` 监听器：

```js
ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
  try {
    if (toolsEnabled(current) && states.get(agent.session).pending)
      await windows.rotatePending(agent, signal);
  } catch (error) {
    // 状态层是辅助的：坏笔记不应拒绝 step；取消仍然向上抛。
    if (signal?.aborted) throw error;
    ctx.logger?.warn?.('context-management: pre-step rotation check failed', error);
  }
  return next();
});
```

`rotatePending` 的分支：

| 情况 | 行为 |
| --- | --- |
| 没有 pending | 直接返回 |
| preset 没有压缩引擎 | 清 pending，追加可见说明“没有压缩引擎” |
| 当前策略是 native | 清 pending，追加可见说明“使用原生压缩” |
| `compactIfNeeded` 返回 `null` | 清 pending，追加“没有可安全压缩的历史” |
| 抛错 | 清 pending，追加错误摘要；`signal.aborted` 时继续向上抛 |
| 成功 | 等 `compaction/end` 的监听器追加窗口消息 |

**为什么用 `context-overflow` 触发器？** DSH 的 `compactIfNeeded(agent, 'context-overflow')` 会绕过正常阈值与保留尾部策略，
强制做一次“尽可能有用”的压缩；这正是显式换窗想要的语义。代价是它会比 `pressure` 压缩掉更多历史——
这是 `new_context` 的文档要求模型“不要为常规问题调用”的原因。

**引擎查找**：

```js
ctx.get('agentPresets')?.serviceFor?.(agent, 'compaction') ?? ctx.get('compaction') ?? null
```

优先用 agent 所属 preset 的隔离引擎；没有 preset 注册表时退回宿主级 `compaction` 服务。
两者都没有就明确报错，不自己造引擎。

## 压缩之后（compactionEnded → announce）

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'compaction/end') windows.compactionEnded(session, event);
});
```

`compactionEnded`：

1. `event.data.error` 存在 → 直接返回（失败不写窗口消息）。
2. `queueMicrotask(...)`：会话在发布事件时不能追加，必须等发布边界关闭。
3. `announce(session, compactionId)`：
   - `active({ session })` 再确认一次策略（模型可能在会话中途切换）；
   - `findSummary` 从 `session.seq - 1` 向前找同一 `compactionId` 的 `compaction/summary`，遇到同 id 的 `compaction/start` 停止；
   - `WindowEngine.prepare()` 构造 header；
   - `session.append('user/message', createUserMessage({ content, source: { kind: 'plugin:context-management' } }), { surfaceOp: 'append' })`。
4. 追加成功 → `writeHandoff(session)` 写交接笔记。

### 微任务时序

窗口消息必须在**压缩引擎恢复执行之前**进入日志，这样溢出重试的请求已经能看到它。
当前 DSH 的 `compactSurfaceRegion` 在 `session.append("compaction/end")` 之后同步返回，
`queueMicrotask` 排在该函数返回、调用方 await 续体之前，所以顺序成立。

这是对 DSH 内部时序的**隐式依赖**，不是公开契约。升级 DSH 后要重点验证：

- `compaction/end` 是否仍在 append 后同步返回；
- `compaction/summary` 是否仍带 `shadowedSeqs`、`provider`、`model`、`rawOutput`；
- `compaction/end` 的 payload 是否仍是 `{ compactionId, error? }`；
- `session/event` 是否仍以 `(session, event)` 发布、seed 事件是否仍不发布。

如果 DSH 在 append 与 return 之间加入 await，溢出重试可能漏掉窗口消息；届时应改为在
`compaction/end` 的持久化回调或引擎的公开钩子里追加，而不是继续依赖微任务。

## 窗口消息（window-engine.js）

`prepare(session, maxChars, summary)` 返回 `{ previousWindowId, newWindowId, header, record }`。

格式（v3）：

```text
<context_window id="win_002" previous_window_id="win_001">
<window_record>{"version":3,"window_id":"win_001","compaction_id":"…","through_seq":42,"summary_kind":"generated","summary":"…"}</window_record>
Window rotated: the compaction summary (item_99, provider/model) replaces win_001; …
Session goal [item_…] phase=active: …
Session checklist [item_…]: 3 items, 1 completed.
…
Recent user instructions (chronological):
[item_…] …
Note self/notes/… (written in win_001):
…
Goal/todo are durable session state. history_search scope=windows …
</context_window>
```

内容与预算：

| 部分 | 预算 |
| --- | --- |
| 总长 | `handoffMaxChars`（默认 6000，范围 4000–32000） |
| `record.summary` | 按 **JSON 转义后**长度 ≤ 1200，避免反斜杠撑爆记录 |
| goal | 700 字符 |
| todo 未完成项 | 700 字符 |
| 每条最近用户指令 | 1000 字符，最多 4 条 |
| 笔记 | 最多 4 个，每个 ≤ 800 字符，按 `updated_at` 降序，排除 handoff 自身 |
| 摘要正文 | **不复制**，只引用 `item_<seq>`；正文留在 DSH 的 checkpoint 里 |

`record.summary` 是窗口目录的“gist”，不是完整摘要；完整正文通过 `history_read(item_<summarySeq>, format: "json")` 取回。
`through_seq` 在 `shadowedSeqs` 为空时显式为 `null`（不再让 `Math.max()` 的 `-Infinity` 被 JSON 序列化成 `null`）。

## 失败收尾（endRequest）

```js
endRequest(states, session, seq, reason, visible = true)
  → states.finishRequest(session, seq)
  → visible 时 append 一条 user/message（source 仍是 plugin:context-management）
```

这条说明消息会被 `session-state` 识别为“插件消息”，**不会**被当成人类指令进入 `latestUsers`。
`visible = false` 用于取消场景，避免在用户主动中断后还往日志里写解释。

## 交接笔记（handoff-note.js）

每次成功开窗后：

- `handoff.md`：**替换**为最新摘要副本（rawOutput 优先，最多 200,000 字符，超出加截断标记）；
- `handoff-log.md`：**追加**一行 `- win_N 时间 item_<seq> 来源: 首行`；
- 幂等：日志里已有 `- <window_id> ` 开头的一行就跳过，重试不会重复；
- 写入按会话串行（`sessionHandoffWrites`），一个会话的慢 IO 不阻塞其他会话；
- 写失败只记 warning，不影响已经完成的换窗。

## 修改时注意

- 改窗口消息格式 → 同步 `session-state.parseWindowMessage`、`SUMMARY_KINDS`、旧版兼容分支、`window-engine` 测试。
- 改 `compaction/end` 处理 → 先确认 `findSummary` 的停止条件（`compaction/start`）仍成立。
- 不要把 `announce` 改成同步 append：发布中的会话会直接抛 “cannot append while publishing”。
- 新增失败分支 → 想清楚 `visible` 是 true 还是 false，以及 pending 是否必须清空。
