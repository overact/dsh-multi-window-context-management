# 09 · 维护指南

## 常见改动

### 新增一个工具

1. `lib/tools/` 定义 `{ name, description, parameters, output }`；
2. `lib/index.js` 的 `tools` 数组注册（决定是否套 `gate`）；
3. 处理器先 `checkEnabled()` / `requireSession(exec)` / `signal.throwIfAborted()`；
4. `test/tool-surface.test.js` 加 schema 断言 + 一个行为测试；
5. 两份 README 的 Tools 表、`docs/design/06-tools.md`。

### 新增一个配置字段

见 [07-settings-client-i18n.md](./07-settings-client-i18n.md) 的清单。关键点：

- 影响工具挂载/门控 → 改 `syncTools()` 的比较签名；
- 影响窗口消息 → 改 `WindowEngine.prepare()`；
- 设置页可编辑 → 改 `lib/client.js` 的复选框列表；
- 加一个“设置变更即时生效”的测试。

### 修改窗口消息格式

1. `lib/window-engine.js` 的 `prepare()`；
2. `lib/session-state.js` 的 `parseWindowMessage()` / `SUMMARY_KINDS` / 旧版兼容分支；
3. `test/window-engine.test.js` 的记录断言；
4. 保留旧版本读取分支（历史会话不能因为升级读不出来）。

### 修改笔记快照格式

1. `lib/note-repository.js` 的 `load()` / `write()`，提升 `version`；
2. 保留旧版本读取分支；
3. `test/persistence.test.js` 的恢复与损坏隔离测试；
4. 两份 README 的 Storage 段。

## DSH 升级检查表

1. **读变更**：先看 DSH 的 release notes / 版本卡，重点关注
   `compaction/*` 事件、`session/event`、`agent/pre-step`、`tools.register`、`settings`、`agentPresets.serviceFor`。
2. **跑测试**：`npm run verify`（88+ 用例，几秒）。
3. **跑预检**：`npm run preflight -- --profile web`，确认 0 failure；`profile plugin names` 不应报警。
4. **看组合**：`dsh --profile web --dump-config`，确认 `context-management` 行存在、`/ctx` 未被占用。
5. **真实环境验收**（需要用户授权重启）：
   - 会话越过阈值后出现窗口消息；
   - `new_context` 后确实换窗（`history_search scope=windows` 能看到新窗口）；
   - `handoff.md` / `handoff-log.md` 更新；
   - 设置页能改 `lazyTools` 并即时生效。

> 源码测试通过不代表运行实例已加载。profile 用 `link:` 安装时，改完源码需要重载插件或重启 DSH；
> `hmr` 只监视 profile patch 里配置的 `root` 目录。

## 发布检查表

1. 版本号：`package.json` 的 `version`（SemVer；破坏性工具改名走 major/minor 按项目惯例）；
2. `CHANGELOG.md`：写清行为变化、迁移步骤；
3. 两份 README：版本行、兼容范围、Tools/Configuration 表；
4. `npm pack --dry-run`：确认 `files` 包含 `lib`、`scripts`、`locale`、`assets`、`cordis.patch.yml`、README、LICENSE；
5. `npm run verify` + `npm run preflight`；
6. 发布后验证 npm 页面与 tarball 内容（注意 npm 会优先展示 `README.zh-CN.md`，见 `TODO.md`）。

## 已知坑

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| profile patch 残留 `@local/...` 旧包名 | 启动日志 `patch: name mismatch ... skipping`，该行配置静默失效 | 改成实际包名；preflight 的 `profile plugin names` 会 warn |
| `lazyTools` 运行时切换 | 设置页勾选后工具面不变 | 已修：门控在 step 时读取 live 配置；回归测试在 `test/lazy-tools.test.js` |
| 笔记快照损坏 | 会话每个 step 都失败 | 已修：隔离为 `.corrupt-*` + 空笔记；`agent/pre-step` 记警告不拒绝 step |
| 微任务时序 | 溢出重试漏掉窗口消息 | 当前 DSH 在 append 后同步返回；升级时重点验证，失效则改用公开钩子 |
| `shadowedSeqs` 为空 | `through_seq` 变成 `null` | 已修：显式判空；读取端不依赖该字段 |
| 摘要事件缺失 | 窗口消息不追加 | `findSummary` 返回 null，pending 保留到下次；不要改成抛错 |
| 禁用时仍有 pending | 禁用后偷偷换窗 | `settings/document-updated` 遍历会话 `endRequest()` |
| 设置页 namespace 不匹配 | 页面空白/不可编辑 | 必须是 `context-management`（插件 `name` 与 loader entry id） |

## 真实环境验收（需要用户授权）

- **不要**在会话内执行全局 DSH 升级（会替换正在运行的包树，宿主中途死亡）。
- 升级宿主：先完全停止所有 dsh 进程，再从外部终端 `npm install -g @deepseek-ai/dsh@<精确版本>`，然后重启 `dsh web`、硬刷新浏览器。
- 重启运行中的服务、改 profile、装/卸插件都需要用户明确同意。
- 验收“模型是否真的会调 `new_context`”必须用真实模型，机械测试只能证明提示词与工具被正确注册。

## 边界

- 不修改 DSH 核心来掩盖插件不兼容。
- 不写未知 session event 类型（当前 DSH 无法重新打开含未知事件的日志）。
- 不删除用户笔记；容量不足时报错，损坏时隔离。
- 不承诺无损恢复；交接是摘要 + 按需检索。
