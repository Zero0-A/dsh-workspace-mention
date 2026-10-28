/**
 * dsh-workspace-mention —— 浏览器半体。
 *
 * 在聊天输入框里输入 `@` 时，本插件向 DSH 的输入触发管线
 * （`ctx.get('inputTriggers')`）注册一个额外的 `@` 来源，
 * 列出侧栏中已登记的所有工作区；选中某个工作区后，向草稿插入该工作区
 * 根目录的文件夹引用（例如 `@D:/dshquick/`）。模型因此能拿到另一个
 * 工作区的绝对路径，直接读取 / 操作那边的文件。
 *
 * 依赖的 Client 服务：
 *   - `inputTriggers`：`@` / `/` 触发管线与候选菜单注册表；
 *   - `workspaces`：Workspace Controller 的 Client 面，`list.getSnapshot()`
 *     给出侧栏工作区投影（`{ workspaceId, path, title, ... }`）；
 *   - `sessions`（可选）：读取当前会话的 cwd，用来标记「当前工作区」；
 *   - `locale`：本插件自己的文案命名空间。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-mention',
  factory(require) {
    /** 本插件的 locale 命名空间。 */
    const NS = 'workspace-mention'

    /** 简体中文文案（键集的事实来源）。 */
    const zh = {
      'section.workspaces': '工作区 · 附快照',
      'row.current': '当前工作区',
    }

    /** 英文文案，与中文键集一一对应。 */
    const en = {
      'section.workspaces': 'Workspaces · snapshot',
      'row.current': 'current workspace',
    }

    /** 本插件需要的 Client 服务：触发管线、工作区投影、会话投影与文案。 */
    const inject = ['inputTriggers', 'workspaces', 'sessions', 'locale']

    /** 引用的源名必须与官方 `@file` 源一致，这样插入的 token 由官方 codec 处理。 */
    const REFERENCE_SOURCE = 'reference'

    /** 编辑器 mention 语法无法安全表示的字符（控制字符与双引号）。 */
    const UNSAFE_MENTION = /[\u0000-\u001f\u007f-\u009f"]/u

    /**
     * 把一个工作区路径格式化成 `@` mention。
     *
     * 目录 mention 以尾斜杠结尾；含空白的路径使用 `@"path/"` 的带引号写法。
     * @param {string} path - 工作区根目录（主机绝对路径）。
     * @returns {string | undefined} mention 文本；路径无法安全表示时返回 undefined。
     */
    function folderMention(path) {
      if (typeof path !== 'string' || path === '') return undefined
      const normalized = `${path.replace(/\\/gu, '/').replace(/\/+$/u, '')}/`
      if (UNSAFE_MENTION.test(normalized)) return undefined
      return /\s/u.test(normalized) ? `@"${normalized}"` : `@${normalized}`
    }

    /**
     * 取路径最后一段，作为候选标题的兜底。
     * @param {string} path - 主机路径。
     * @returns {string} 最后一段；取不到时原样返回路径。
     */
    function baseName(path) {
      const segments = path.split(/[\\/]/u).filter(Boolean)
      return segments.at(-1) ?? path
    }

    /**
     * 读取侧栏当前的工作区投影。
     * @param {object} workspaces - `ctx.get('workspaces')` 服务。
     * @returns {Array<{workspaceId: string, path?: string, title?: string}>} 工作区行。
     */
    function workspaceRows(workspaces) {
      try {
        const snapshot = workspaces?.list?.getSnapshot()
        const items = snapshot?.items
        return Array.isArray(items) ? items : []
      } catch {
        return []
      }
    }

    /**
     * 读取当前会话的工作目录，用于标记「当前工作区」。
     * @param {object | undefined} sessions - `ctx.get('sessions')` 服务。
     * @param {string} sessionId - 当前会话 id。
     * @returns {string | undefined} 规范化后的 cwd。
     */
    function sessionCwd(sessions, sessionId) {
      try {
        const summary = sessions?.list?.getSnapshot()?.byId?.[sessionId]
        const cwd = summary?.cwd
        return typeof cwd === 'string' ? cwd.replace(/\\/gu, '/').replace(/\/+$/u, '') : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 一个候选行：标题 + 路径描述 + 文件夹图标 + 分组标题。
     * @param {object} workspace - 工作区投影。
     * @param {string | undefined} cwd - 当前会话 cwd。
     * @param {(key: string) => string} t - 文案函数。
     * @returns {object | undefined} 触发管线候选行。
     */
    function candidateRow(workspace, cwd, t) {
      const path = typeof workspace?.path === 'string' ? workspace.path : undefined
      if (path === undefined) return undefined
      const title = typeof workspace.title === 'string' && workspace.title !== ''
        ? workspace.title
        : baseName(path)
      const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
      const current = cwd !== undefined && cwd.toLowerCase() === normalized.toLowerCase()
      return {
        name: title,
        description: current ? `${path} · ${t('row.current')}` : path,
        icon: 'folder',
        section: t('section.workspaces'),
        value: JSON.stringify({ path, title }),
      }
    }

    /**
     * 按输入过滤工作区（标题或路径的子串匹配，大小写不敏感）。
     *
     * `工作区` / `workspace` 是整组候选的别名查询：用户直接输入 `@工作区`
     * 就能看到全部工作区，而不是因为没有任何工作区叫这个名字而看到空菜单。
     * @param {object} workspace - 工作区投影。
     * @param {string} needle - 小写查询。
     * @returns {boolean} 是否保留该行。
     */
    function matchesQuery(workspace, needle) {
      if (needle === '' || needle === '工作区' || needle === 'workspace') return true
      const title = typeof workspace?.title === 'string' ? workspace.title : ''
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      return title.toLowerCase().includes(needle) || path.toLowerCase().includes(needle)
    }

    /**
     * 插件主体：注册文案与 `@` 工作区来源。
     * @param {object} ctx - Client 根 Context。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-mention: dictionaries')
      const t = ctx.locale.bind(NS)
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')

      const source = {
        trigger: '@',
        name: 'workspace',
        // 排在官方 `reference` 来源之后，让文件 / 会话分组仍在前。
        order: 10,
        showGroupTitle: false,
        /**
         * 每次 `@` 命中时提供工作区候选。
         *
         * 触发管线要求这份候选是 thenable（它会立刻 `.then(...)`），
         * 因此这里保持 async，即使读取快照本身是同步的。
         * @param {{sessionId: string}} session - 当前会话。
         * @param {{query?: string, quoted?: boolean, signal?: AbortSignal}} request - 命中信息。
         * @returns {Promise<Array<object>>} 候选行。
         */
        async candidates(session, request) {
          const { query, quoted, signal } = request ?? {}
          // 带引号的 `@"` 只在文件补全里表示带空白的路径，工作区候选不参与。
          if (quoted === true) return []
          if (signal?.aborted === true) return []
          const needle = (typeof query === 'string' ? query : '').trim().toLowerCase()
          const cwd = sessionCwd(sessions, session?.sessionId)
          const rows = []
          for (const workspace of workspaceRows(workspaces)) {
            if (!matchesQuery(workspace, needle)) continue
            const row = candidateRow(workspace, cwd, t)
            if (row !== undefined) rows.push(row)
          }
          return rows
        },
        /**
         * 选中一个工作区：插入该工作区根目录的文件夹引用。
         * @param {{candidate: {value?: string}}} pick - 被选中的候选。
         * @returns {{insert: object} | undefined} 编辑器的插入指令。
         */
        onPick(pick) {
          const raw = pick?.candidate?.value
          if (typeof raw !== 'string') return undefined
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            return undefined
          }
          const mention = folderMention(parsed?.path)
          if (mention === undefined) return undefined
          const label = typeof parsed.title === 'string' && parsed.title !== ''
            ? parsed.title
            : baseName(parsed.path)
          return {
            insert: {
              source: REFERENCE_SOURCE,
              ref: mention,
              label: `${label}/`,
              appearance: 'folder',
              clipboardText: mention,
            },
          }
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      }

      ctx.effect(() => ctx.get('inputTriggers').registerSource(source), 'workspace-mention: @ source')
    }

    return { inject, apply }
  },
})
