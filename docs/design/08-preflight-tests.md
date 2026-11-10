# 08 · 能力预检与测试（scripts/preflight / test）

## 预检的立场

DSH 的版本号不能说明某个扩展点是否还在。插件采用**按能力检查**：

- 需求从 `lib/` 源码**推导**，不在 preflight 里手写一份 API 清单；
- 检查对象是**已安装的 DSH 包**和**目标 profile**，不是版本字符串；
- 失败分两级：`fail` 阻止安装，`warn` 只提示。

```bash
npm run preflight -- --profile web
```

## 检查项

| 检查 | 级别 | 内容 |
| --- | --- | --- |
| `import <pkg>` | fail | 源码里 `import { ... } from '@deepseek-ai/dsh-*'` 的每个命名导出都存在 |
| `preset compaction` | fail | `BasicCompactionEngine.prototype.compactIfNeeded` 与 `agentPresets.serviceFor` 存在 |
| `service <name>` | fail | 源码里 `ctx.<service>.<method>()` 的方法在对应包的原型上存在 |
| `host events` | fail | `ctx.on('...')` 的事件名在 DSH 代码里出现 |
| `session log types` | fail | 历史/窗口用到的 session event 类型 DSH 认识 |
| `notes storage` | fail | `$DSH_HOME/context-management/notes` 可写，且解析在 `$DSH_HOME` 内 |
| `client packages` | warn | 设置页注入的客户端包存在 |
| `client services` | warn | `configForms` / `locale` / `slots` 在客户端代码里出现 |
| `tool names` | fail | 五个工具名没有被 DSH 或其他 profile 插件占用 |
| `command names` | fail | `/ctx` 没有被占用 |
| `legacy preset overrides` | fail | profile patch 不再残留 `@local/dsh-context-management/compaction` |
| `profile plugin names` | warn | profile patch 里没有 `@local/...` 旧包名（loader 会按名字跳过该行） |

**为什么 `profile plugin names` 是 warn？** 插件自己的 bundle 行仍然能正确加载；旧行只是让该行的配置静默失效。
把它设成 fail 会阻止那些故意使用 `@local/` 别名安装的 profile。

## 测试策略

```bash
npm run verify     # = npm run check（语法）+ node --test test/*.test.js
```

测试**不调用付费模型**：

- 用真实 `Context`、`Session`、`SessionStore`、`TokenMeter`、`BasicCompactionEngine`、`ToolRuntime`、`CommandRuntime`；
- 只把 `BasicCompactionEngine.summarize()` 换成固定摘要器（DSH 文档化的定制点）；
- 用真实的 JSONL 持久化后端验证恢复；
- 设置用真实的 `SettingsForms` + 内存 `configEditor`。

fixture 在 `test/helpers/dsh.js`：

- `fixture()` 挂载插件、真实存储、真实压缩引擎；
- `f.agent()` 创建会话与 agent 对象；
- `f.execute()` 走 `ctx.tools.resolve` + 批量执行，和宿主一致；
- `f.native.compactNow()` 触发一次真实压缩；
- 每个 fixture 用临时 `$DSH_HOME`，结束后清理。

## 测试地图

| 文件 | 覆盖 |
| --- | --- |
| `test/integration.test.js` | 换窗主流程、策略、设置、禁用/启用、手动 `/compact` |
| `test/window-engine.test.js` | 窗口消息预算、记录格式、空 `shadowedSeqs` |
| `test/session-state`（在 integration/notes 中） | 折叠、窗口识别、恢复 |
| `test/notes.test.js` | 笔记路径、容量、切片、搜索、工具行为 |
| `test/persistence.test.js` | JSONL 恢复、并发写、取消、损坏隔离 |
| `test/history.test.js` | 分页、搜索、窗口目录、JSON 读取 |
| `test/lazy-tools.test.js` | lazy 门控、首次换窗后出现、**运行时切换** |
| `test/hot-swap.test.js` | 卸载/重挂不重复注册、提示段不重复 |
| `test/manual-compact.test.js` | `/compact` 与插件策略的交互 |
| `test/switchable.test.js` | 开关切换、pending 收尾 |
| `test/client.test.js` | 设置页读写、只读/失败状态 |
| `test/locale.test.js` | 语言解析、回退、窗口文案 |
| `test/preflight.test.js` | 能力检查、缺 seam、冲突、旧 `@local` 名 |
| `test/tool-surface.test.js` | 五个 schema、无别名 |

## 新增测试的约定

- 用 `node:test` + `assert/strict`，不引入测试框架；
- 行为测试优先走 `f.execute()`（真实工具执行路径），而不是直接调处理器；
- 需要“失败”时用真实失败源（坏文件、抛错的 flush、取消信号），不要 mock 掉被测逻辑；
- 临时文件放 fixture 的临时根目录或 `/tmp`，不要写进仓库；
- 涉及持久化的测试要在 `finally` 里释放 fixture 和临时目录。

## 测试证明不了的事

- 真实模型是否会在合适的时机调用 `new_context`（需要真实模型验收）；
- 真实 DSH 实例是否加载了当前源码（源码测试通过 ≠ 运行实例已加载）；
- 长时间运行的 token 成本与摘要质量；
- Web 设置页在真实浏览器里的渲染（`client.test.js` 是 VM fixture，preflight 只证明依赖存在）。

这些需要在真实环境里单独验收，见 [09-maintenance.md](./09-maintenance.md)。
