# 07 · 配置、设置页与语言（settings / client / locale）

## 配置 schema

`lib/index.js` 用 Schemastery 定义一个扁平 schema：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后工具卸载、压缩回原生 |
| `overrideCompaction` | `true` | 是否在压缩后追加换窗交接 |
| `injectTools` | `true` | 是否向模型提供工具 |
| `lazyTools` | `true` | notes/history 是否等到首次换窗后才出现 |
| `defaultStrategy` | `'window'` | 未在 `modelPolicies` 中列出的模型用什么策略 |
| `modelPolicies` | `[]` | 精确 `provider` + `model` → `window` / `native` |
| `handoffMaxChars` | `6000` | 窗口消息的字符预算（4000–32000） |

所有字段都标记为 `.volatile()`：DSH 的设置表单只允许编辑 volatile 字段，且修改会直接更新运行中的配置对象，
不需要重启插件。`readConfig()` 每次读取都用 `value.get()` 取最新值，所以策略、预算、开关都是实时的。

**为什么不缓存配置？** 设置页、`/ctx`、profile patch 三处都可能改同一份配置；缓存会制造第二真相。
唯一的例外是工具注册：`lazyTools` 改变的是门控，必须由 `syncTools()` 重建（见 06）。

## 设置页（lib/client.js）

客户端模块是一个 **lazy-CJS** 工厂，由 DSH 的模块加载器执行：

```js
window.__ModuleLoader__.load({
  id: 'dsh-multi-window-context-management',
  factory(require) { ... return { name: 'context-management', inject: ['slots', 'locale', 'configForms'], apply }; },
});
```

`apply(ctx)` 做三件事：

1. `ctx.configForms.get('context-management')` 拿到后端设置表单（读写同一份配置）；
2. `ctx.locale.register('context-management', dictionaries)` 注册中英文案；
3. `ctx.slots.inject('settings.section', ...)` 注册设置页分区（`order: 22`）。

组件用 `useSyncExternalStore` 订阅表单快照：

- `snapshot.status === 'ready' && snapshot.writable` 才允许编辑；
- 写入失败显示 `role="alert"` 的错误，不回显乐观值；
- 只读连接、加载中、保存中都有明确状态；
- 复选框只覆盖 `enabled`、`overrideCompaction`、`injectTools`、`lazyTools` 四个布尔项；策略与预算通过配置文件或 `/ctx` 之外的入口改。

**为什么不做乐观更新？** 设置是全局的（影响所有会话），失败时显示成功会误导用户。
组件只渲染最后一次被宿主接受的值。

## `/ctx` 命令

```js
ctx.commands.register({ name: 'ctx', description: t('command.ctx'), handler: toggle });
```

`toggle()`：

- 串行化（`toggleTail`）避免连点导致交错写入；
- `ctx.settings.update('context-management', { enabled: !current.enabled })`；
- 返回 `{ kind: 'success', text: ... }`，由 DSH 渲染；
- 语言变化时重新注册命令（`registerCommands()`），确保描述跟随语言。

`/ctx` 与设置页共享同一份后端状态，不存在“页面显示开、命令显示关”的分裂。

## 设置变更监听

```js
ctx.on('settings/document-updated', ns => {
  if (ns === 'locale') { locale = resolveLocale(ctx); t = translator(locale); registerCommands(); return; }
  if (ns !== name) return;
  const hadTools = toolsEnabled(current);
  current = readConfig();
  if (hadTools && !toolsEnabled(current)) { /* 给所有 pending 会话写可见说明 */ }
  syncTools();
});
```

- 只有本插件（`context-management`）和 `locale` 两个命名空间会触发动作；
- 关闭工具时，遍历 `ctx.sessions.list()` 把 pending 请求收尾，避免“禁用后仍偷偷换窗”；
- `syncTools()` 负责 `enabled` / `injectTools` / `lazyTools` 的差异重建。

## 语言跟随

`lib/locale.js`：

- `resolveLocale(ctx)`：读 `ctx.settings.describe()` 里 `ns === 'locale'` 的 `value.preference`，`zh` → 中文，其余 → 英文；
- `translator(locale)`：查字典，缺键回退英文，再缺回退 key；
- `description(key)`：返回 `{ en, zh }`，供设置表单的字段描述使用；
- `locale/en.json`、`locale/zh.json`：插件列表里的显示名与描述（DSH 插件市场/列表读取）。

覆盖范围：配置描述、`/ctx` 文案、系统提示段、窗口消息、交接笔记、设置页。语言变化时命令会重新注册。

## 新增一个配置字段的清单

1. `PlainConfig` 加字段（默认值、范围、`description('config.x')`）；
2. `lib/locale.js` 的 `EN` / `ZH` 加 `config.x` 文案；
3. 如果字段影响工具挂载/门控 → 改 `syncTools()` 的比较签名；
4. 如果字段影响窗口消息 → 改 `WindowEngine.prepare()` 的参数；
5. 设置页需要可编辑 → 在 `lib/client.js` 的复选框列表里加字段；
6. 两份 README 的 Configuration 表 + 本文件；
7. 加一个“设置变更即时生效”的测试（参考 `test/lazy-tools.test.js`）。

## 修改时注意

- 字段名是公开契约（配置文件、设置页、文档都用它）；改名要按破坏性变更处理。
- 不要把敏感值放进配置描述或日志。
- 客户端模块不要 import Node 内置模块；它运行在浏览器里。
- 设置页的 `namespace` 必须与插件 `name` / loader entry id 一致（`context-management`），否则 `configForms.get()` 拿不到表单。
