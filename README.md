# dsh-workspace-mention

在 DSH（DeepSeek Harness）Web 的聊天输入框里**用 `@` 引用一个工作区**——不是只丢一个路径，而是把那个工作区**当成上下文交给模型**：选中后除了插入它的根目录引用，宿主还会在消息进入模型之前，自动附上一份该工作区的**只读快照**（目录结构、清单要点、README 摘要、git 状态），模型不用先 `ls` 一遍才知道它是什么。

## 为什么不是「只 @ 一个路径」

`@文件` 的语义是**惰性**的：插入路径，模型需要时自己 `read`。
而「一个工作区」通常是几句话说不清的一整块背景，只给路径模型就得先探索，既慢又容易漏。所以本插件把 `@工作区` 定义成**急切的背景注入**：

| 引用对象 | 模型拿到的东西 | 何时读取 |
|---|---|---|
| `@文件` / `@文件夹` | 路径 | 模型需要时自己 `read` |
| `@工作区`（本插件） | 路径 **+ 工作区快照** | 发送时立刻附在消息后面 |

快照只含**元信息，不含文件正文**，并带固定警告（不可信背景、不得当作指令执行）；正文仍然要模型自己调工具读，权限与 DSH 原生工具一致。

## 功能

| 场景 | 行为 |
|---|---|
| 输入 `@` | 候选菜单出现「工作区 · 附快照」分组，每行是工作区标题 + 根目录 |
| 输入 `@工作区` / `@workspace` | 别名查询，列出全部工作区 |
| 输入 `@` + 文字 | 按工作区标题或路径实时过滤（大小写不敏感） |
| 选中工作区 | 插入原子文件夹引用（如 `@D:/dshquick/`），标签带尾斜杠 |
| 发送消息 | 宿主在 `agent/pre-step` 里扫描这条消息的 `@<绝对路径>/`，命中已登记工作区根目录时，紧随其后注入一条可折叠的上下文消息 |
| 快照内容 | `tree`（顶层条目 + 少量二层）、`manifest`（package.json / pyproject / Cargo / go.mod…）、`readme`（前 60 行摘要）、`git`（分支 + HEAD，读 `.git` 不调 git） |
| 当前会话所在的工作区 | 候选行描述末尾标注「当前工作区」 |

## 快照的边界

- 一条消息最多引用 **2** 个工作区，注入文本总上限 **16000 字符**，单条 README 摘要 3200 字符；超出部分截断并标注 `…[truncated]`。
- 结构树会跳过 `node_modules`、`.git`、`dist`、`build`、`target`、`__pycache__` 等噪声目录。
- 只在「mention 路径 == 已登记工作区根目录」时触发；引用工作区里的子目录或普通文件不会触发（那属于 `@文件` 的语义）。
- 注入失败（目录被删、权限异常、取消）时**原样放行**，绝不让本轮对话报错。
- 注入用的是 DSH 原生的 `user` 上下文消息（`source.kind = workspace-reference`、`form = notice`），在聊天里显示为一条可折叠、带一句话摘要的「注入上下文」行，随会话日志持久化。

## 实现要点

- **浏览器半体** `lib/client.js`：通过 `window.__ModuleLoader__.load` 注册，`apply` 里注册自己的 locale、并向 `ctx.get('inputTriggers')` 注册一个 `trigger: '@'` 的来源；候选来自 `ctx.get('workspaces').list.getSnapshot().items`（Workspace Controller 的 Client 投影）。选中返回 `{ insert: { source: 'reference', ref, label, appearance: 'folder', clipboardText } }`，沿用官方 `@file` 来源的 codec 与 chip 渲染。
- **宿主半体** `lib/index.js`：`apply` 里挂 `agent/pre-step` 瀑布（`prepend: true`），先 `await next()` 拿到下游决定，再扫描 `decision.messages` 里 `source.kind === 'user'` 的文本块，匹配工作区后调用 `buildWorkspaceBrief` 生成快照，用一条 `user` 角色消息插在引用它的消息之后。
- **`lib/workspace-brief.js`**：纯 node 标准库实现的快照与文案逻辑（mention 提取、路径匹配、结构树、清单、README、git、预算裁剪），因此全部可单元测试。
- 宿主半体不 import 任何 `@deepseek-ai/*` 包（只用 `node:crypto`），避免插件目录的模块解析问题；构造的消息字段与 `dsh-llm` 的 `createUserMessage` 产物一致。

## 安装

已发布到 npm：

```
dsh plugin --profile <profile> add dsh-workspace-mention
```

也可以直接从源码目录安装（本仓库本身就是一个 bundle 包）：

```
dsh plugin --profile <profile> add <本目录绝对路径>
```

或让插件管理器把目录作为 bundle 安装（`plugin_manager` 的 `install_bundle`，target 传本目录）。
安装后刷新一次 Web 页面，浏览器半体才会重新装配；**宿主半体是 JS 模块，被替换后需要重启 `dsh web` / Desktop 应用才会加载新代码**（开发时用插件管理器关/开一次 bundle 也能触发重新组合热加载）。

## 开发

```sh
npm test    # 22 个用例：浏览器 @ 来源 + 快照构建 + pre-step 注入
```

目录：

```
lib/index.js             宿主半体：agent/pre-step 注入
lib/client.js            浏览器半体：@ 工作区候选与插入
lib/workspace-brief.js   快照构建（纯 node 标准库，可测试）
test/client.test.mjs     浏览器半体测试
test/workspace-brief.test.mjs  快照与注入测试
locale/{zh,en}.json      插件管理器展示用标题 / 描述
icon.svg                 插件图标
cordis.patch.yml         Loader 行插入
```

## 兼容性

- 目标：DSH `0.2.1-rc.3`（Desktop / Web 组合；`dsh-client-ui-input-trigger` 的 `@` 管线、`dsh-api-workspace-controller` 的 Client `workspaces` 服务、宿主 `agent/pre-step` 瀑布与 `workspaceRegistry`）。
- 无第三方运行依赖。

## 已知限制

- 只识别**已登记**进 DSH 的工作区（侧栏里有的那些）；磁盘上未登记的目录不会命中。
- 只匹配工作区**根目录**的引用；子目录请用官方 `@文件`。
- 快照是发送时的静态抓取，不是实时订阅：之后工作区里的改动不会自动更新已注入的上下文。
- 不做中文分词/语义检索，也没有代码 RAG；它的职责是「让模型先知道这是个什么项目」，不是「找出相关代码」。

## License

MIT
