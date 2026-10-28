# dsh-workspace-mention

在 DSH（DeepSeek Harness）Web 的聊天输入框里**用 `@` 引用工作区**：输入 `@` 后，候选菜单里多出一组「工作区」，列出侧栏里登记过的每一个工作区；选中一个，就会往草稿里插入该工作区根目录的引用（例如 `@D:/dshquick/`）。模型因此能直接拿到另一个工作区的绝对路径，跨工作区读取 / 操作文件，不必再手打路径。

## 功能

| 场景 | 行为 |
|---|---|
| 输入 `@` | 候选菜单出现「工作区」分组，说明列是该工作区的根目录 |
| 输入 `@` + 文字 | 按工作区标题或路径实时过滤（大小写不敏感） |
| 选中工作区 | 插入原子文件夹引用：可点击 `@D:/dshquick/`，标签带尾斜杠 |
| 当前会话所在的工作区 | 其行描述末尾标注「当前工作区」 |
| 路径含空格 | 自动使用带引号写法 `@"E:/项目 一/"` |
| 输入 `@"` | 工作区候选不参与（这是官方文件补全的带引号路径通道） |

插入的引用由 DSH 官方的文件引用渲染器接管（文件夹图标 + 文件夹名），发出去后模型看到的是 `@绝对路径/` 这样的普通提示词文本；插件不读取、不上传任何文件内容。

## 实现要点

- **纯浏览器插件 + 空宿主半体**：宿主编译产物 `lib/index.js` 只导出空 `apply()`，作用是把本包放进 Loader 组合；真正的功能在 `lib/client.js`。
- 浏览器半体通过 `window.__ModuleLoader__.load` 注册，`apply` 里做两件事：
  1. `ctx.locale.register('workspace-mention', { zh, en })` 注册自己的文案；
  2. `ctx.get('inputTriggers').registerSource(source)` 往输入触发管线加一个 `trigger: '@'` 的来源。
- 候选来自 `ctx.get('workspaces').list.getSnapshot().items`——也就是 Workspace Controller（`@deepseek-ai/dsh-api-workspace-controller`）的 Client 投影，字段为 `{ workspaceId, path, title, sessionIds, createdAt, updatedAt }`；当前会话 cwd 来自 `ctx.get('sessions').list.getSnapshot().byId[sessionId].cwd`，只用于标记。
- 选中后返回 `{ insert: { source: 'reference', ref: mention, label, appearance: 'folder', clipboardText } }`；`source: 'reference'` 表示沿用官方 `@file` 来源的 codec 与 chip 渲染，因此和官方引用完全同款。
- 不注册任何 Host 服务、工具、提示词段，也不改 DSH 原生行为。

## 安装

本仓库是一个 bundle 包，两种安装方式：

**绿手安装（推荐）**

```
dsh plugin --profile <profile> add <本目录绝对路径>
```

或让插件管理器把这个目录作为 bundle 安装（`plugin_manager` 的 `install_bundle`，target 传本目录）。

**手动装配**

1. 在 profile 的 `package.json` 依赖里加 `"dsh-workspace-mention": "file:<本目录绝对路径>"`；
2. 把 `"dsh-workspace-mention"` 追加进同文件的 `dsh.profile.bundles` 数组；
3. `pnpm install` 后重启 `dsh web` / 刷新页面。

## 开发

```sh
npm test        # node --test test/，用假 window 捕获 Module Loader 定义后直接校验 @ 来源
```

目录：

```
lib/index.js          宿主半体（空插件）
lib/client.js         浏览器半体：注册「工作区」@ 来源
test/client.test.mjs  单元测试
locale/{en,zh}.json   插件管理器展示用标题 / 描述
icon.svg              插件图标
cordis.patch.yml      Loader 行插入
```

## 兼容性

- 目标：DSH `0.2.1-rc.3`（Desktop / Web 组合，`dsh-client-ui-input-trigger` 的 `@` 触发管线 + `dsh-api-workspace-controller` 的 Client `workspaces` 服务）。
- 不引入任何第三方运行依赖；浏览器半体只用 `require` 不加载模块。

## 已知限制

- 工作区候选只来自侧栏已登记的工作区；磁盘上未登记进 DSH 的目录不会出现（需要先用「添加工作区」登记）。
- 插入的是工作区**根目录**引用，不是整个目录树的内容；想引用具体文件请继续用官方的 `@文件`。
- 当前工作区的判定依赖会话摘要里的 `cwd`，缺失时只是不显示「当前工作区」标记。

## License

MIT
