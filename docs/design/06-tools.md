# 06 · 工具面（tools/* 与注册生命周期）

插件向模型暴露五个工具，全部通过 DSH 的 `ctx.tools.register()` 注册：

| 工具 | 作用 | 何时可见 |
| --- | --- | --- |
| `new_context` | 请求在下一个安全边界换窗 | 始终（插件启用且 `injectTools`） |
| `notes_read` | 读/搜/列会话笔记 | `lazyTools` 开启时，首次换窗后 |
| `notes_write` | 写会话笔记（必须显式 `mode`） | 同上 |
| `history_search` | 浏览/搜索历史，或列窗口目录 | 同上 |
| `history_read` | 按 `item_<seq>` 读精确记录 | 同上 |

## 注册生命周期

`lib/index.js` 的 `syncTools()` 是唯一注册入口：

```text
enabled = enabled && injectTools && !disposed
if (registered === enabled) return
dispose 旧工具 → 若 disabled 结束 → 重新注册
```

- **`enabled` / `injectTools`**：决定“工具是否挂载”。关闭时五个工具全部卸载，压缩回到原生。
- **`lazyTools`**：只决定 notes/history 的 **step 门控**，不决定是否挂载。
  门控是 `{ when: context => !current.lazyTools || states.get(context.agent.session).windows.length > 1 }`。
- **为什么门控读 live 配置**：`lazyTools` 是策略，不是注册选项。门控在每次 step 解析工具集时读取
  `current.lazyTools`，所以设置页切换后下一次解析就生效，不需要重建工具；`syncTools()` 只负责
  `enabled` / `injectTools` 的挂载变化。早期实现把 `lazyTools` 固化进注册选项，导致切换后必须重载插件。
- **注册失败要回滚**：`try { register... } catch { dispose 已注册的; throw }`，避免半套工具。

`dispose()` 会先 `windows.close()`（阻止在途窗口消息落地），再 `syncTools()` 卸载全部工具。

## 门控的语义

`when` 在**每个 step 解析工具集时**调用一次：

- `lazyTools: true`：从未换窗的会话只看到 `new_context`，省掉四个 schema（约 2.6k 字符/step）；
- 第一次换窗后（`windows.length > 1`），四个工具自动出现；
- 门控内部 `try/catch`：状态读取失败时返回 `false`，工具保持隐藏，不阻塞 step。

`when` 只影响“模型能否看到/调用”，工具仍然注册在全局层；所以热重载不会出现第二份副本。

## 错误契约

工具处理器抛出的错误会变成模型可见的工具错误。约定：

| 检查 | 错误 |
| --- | --- |
| 插件被禁用 | `Context management tools are disabled.` |
| 没有活动会话 | `Context management requires a live DSH agent session.` |
| preset 没有压缩引擎 | `This agent preset has no compaction engine. new_context is unavailable; notes and history remain usable.` |
| 当前策略是 native | `This model uses native compaction. new_context is unavailable; notes and history remain usable.` |
| 笔记模式缺失 | `notes_write requires mode: replace or append.` |
| 跨会话笔记 | `Notes are private to the current session. Use a relative path.` |
| 历史/笔记的 `agent_name` | 显式拒绝（宿主可能传未声明参数） |

错误信息刻意说明“还有什么可用”，避免模型在 `new_context` 失败后放弃整个插件。

## Schema 预算

- 五个工具的 schema 合计约 2,868 字符（0.5.x 起压缩过一轮）；
- `new_context` 的参数是空对象 `{ type: 'object', properties: {}, additionalProperties: false }`；
- 参数尽量用短描述，长解释放在系统提示段；
- `notes_write` 的 `mode` 是必填枚举，防止默认覆盖。

## 工具输出

`lib/tools/output.js` 的 `jsonToolOutput(type)` 统一输出：

```js
{ schema: { type }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
```

- 所有工具都声明 `output`（DSH 0.2.2 的 `tools.register` 强制要求 `output.render`）；
- 字符串原样返回，对象 pretty-print；
- 不在 render 里做裁剪——裁剪在 store 层完成，保证模型看到的就是有界结果。

## 新增一个工具的清单

1. 在 `lib/tools/` 定义 `{ name, description, parameters, output }`；
2. 在 `lib/index.js` 的 `tools` 数组里注册，决定是否套 `gate`；
3. 处理器里先 `checkEnabled()` / `requireSession(exec)` / `signal.throwIfAborted()`；
4. 在 `scripts/preflight.mjs` 的 `requirements()` 里能看到它（它从源码推导工具名）；
5. 加 `test/tool-surface.test.js` 的 schema 断言与一个行为测试；
6. 更新两份 README 的 Tools 表和本文件。

## 修改时注意

- 不要在工具处理器里直接 `session.append` 业务事件；窗口消息只由 `WindowController` 追加。
- 不要给工具加 `agent_name` / `session_id` 选择器；会话隔离是硬边界。
- 改工具名是破坏性变更：旧提示词/脚本会失效，需要版本号与 CHANGELOG 说明。
- `syncTools()` 是唯一注册点；不要在别处直接 `ctx.tools.register`，否则卸载会漏。
