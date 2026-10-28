/**
 * dsh-workspace-mention 的浏览器半体单元测试。
 *
 * `lib/client.js` 是给 DSH Web 的 Module Loader 用的脚本：顶层调用
 * `window.__ModuleLoader__.load({ id, factory })`，返回的 factory 内部才是
 * Cordis 插件（`{ inject, apply }`）。测试用假 `window` 捕获 factory，
 * 再用假的 Client Context 跑 `apply`，直接检验注册出来的 `@` 来源。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** 捕获到的 Module Loader 定义。 */
let definition

globalThis.window = {
  __ModuleLoader__: {
    load(input) {
      definition = input
    },
  },
}

await import('../lib/client.js')

/** 假的中文文案表，与 client.js 里的键集保持一致。 */
const ZH = {
  'section.workspaces': '工作区',
  'row.current': '当前工作区',
}

/**
 * 造一个最小的 Client Context，并记录注册出来的 `@` 来源。
 * @param {object} options - 假的 workspaces / sessions 服务。
 * @returns {{context: object, sources: object[], disposals: Array<() => void>}} 假上下文与记录。
 */
function makeContext({ workspaces, sessions } = {}) {
  const sources = []
  const disposals = []
  const context = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposals.push(dispose)
      return dispose
    },
    locale: {
      register() {
        return () => {}
      },
      bind() {
        return (key) => ZH[key] ?? key
      },
    },
    get(name) {
      if (name === 'inputTriggers') {
        return {
          registerSource(source) {
            sources.push(source)
            return () => {}
          },
        }
      }
      if (name === 'workspaces') return workspaces
      if (name === 'sessions') return sessions
      return undefined
    },
  }
  return { context, sources, disposals }
}

/**
 * 造一个与 Workspace Controller Client 面同形的假服务。
 * @param {Array<{workspaceId: string, path: string, title: string}>} items - 工作区投影。
 * @returns {object} 假 workspaces 服务。
 */
function makeWorkspaces(items) {
  return { list: { getSnapshot: () => ({ items, state: 'idle', phase: 'ready' }) } }
}

/** 造一个只带列表快照的假 sessions 服务。 */
function makeSessions(byId) {
  return { list: { getSnapshot: () => ({ byId }) } }
}

test('loads as a module loader definition with the package id', () => {
  assert.equal(definition?.id, 'dsh-workspace-mention')
  assert.equal(typeof definition.factory, 'function')
})

test('registers one @ source', () => {
  const plugin = definition.factory(() => {
    throw new Error('client half must not require external modules')
  })
  assert.deepEqual(plugin.inject, ['inputTriggers', 'workspaces', 'sessions', 'locale'])
  const { context, sources } = makeContext({ workspaces: makeWorkspaces([]) })
  plugin.apply(context)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].trigger, '@')
  assert.equal(sources[0].name, 'workspace')
  assert.equal(sources[0].showGroupTitle, false)
})

test('lists every workspace with a folder icon and a section heading', async () => {
  const items = [
    { workspaceId: 'a', path: 'D:\\dshquick', title: 'dshquick' },
    { workspaceId: 'b', path: 'E:/project/实验 项目', title: '实验项目' },
  ]
  const plugin = definition.factory(() => {})
  const { context, sources } = makeContext({
    workspaces: makeWorkspaces(items),
    sessions: makeSessions({ s1: { cwd: 'D:\\dshquick' } }),
  })
  plugin.apply(context)
  const rows = await sources[0].candidates({ sessionId: 's1' }, { query: '', quoted: false })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'dshquick')
  assert.equal(rows[0].icon, 'folder')
  assert.equal(rows[0].section, '工作区')
  assert.match(rows[0].description, /当前工作区/u)
  assert.equal(rows[1].name, '实验项目')
  assert.equal(rows[1].description, 'E:/project/实验 项目')
})

test('filters candidates by title or path, case-insensitively', async () => {
  const items = [
    { workspaceId: 'a', path: 'D:\\dshquick', title: 'dshquick' },
    { workspaceId: 'b', path: 'E:\\alpha', title: 'Alpha' },
  ]
  const plugin = definition.factory(() => {})
  const { context, sources } = makeContext({
    workspaces: makeWorkspaces(items),
    sessions: makeSessions({}),
  })
  plugin.apply(context)
  const source = sources[0]
  assert.deepEqual((await source.candidates({ sessionId: 's1' }, { query: 'alp' })).map((row) => row.name), ['Alpha'])
  assert.deepEqual((await source.candidates({ sessionId: 's1' }, { query: 'dshq' })).map((row) => row.name), ['dshquick'])
  assert.deepEqual(await source.candidates({ sessionId: 's1' }, { query: 'nothing' }), [])
})

test('the group alias query 工作区 / workspace matches every workspace', async () => {
  const items = [
    { workspaceId: 'a', path: 'D:\\dshquick', title: 'dshquick' },
    { workspaceId: 'b', path: 'E:\\alpha', title: 'Alpha' },
  ]
  const plugin = definition.factory(() => {})
  const { context, sources } = makeContext({
    workspaces: makeWorkspaces(items),
    sessions: makeSessions({}),
  })
  plugin.apply(context)
  const source = sources[0]
  assert.equal((await source.candidates({ sessionId: 's1' }, { query: '工作区' })).length, 2)
  assert.equal((await source.candidates({ sessionId: 's1' }, { query: 'workspace' })).length, 2)
})

test('skips workspace candidates for a quoted file query', async () => {
  const plugin = definition.factory(() => {})
  const { context, sources } = makeContext({
    workspaces: makeWorkspaces([{ workspaceId: 'a', path: 'D:\\dshquick', title: 'dshquick' }]),
  })
  plugin.apply(context)
  assert.deepEqual(await sources[0].candidates({ sessionId: 's1' }, { query: 'dsh', quoted: true }), [])
})

test('picks insert an absolute folder reference closed with a trailing slash', async () => {
  const plugin = definition.factory(() => {})
  const { context, sources } = makeContext({
    workspaces: makeWorkspaces([{ workspaceId: 'a', path: 'D:\\dshquick', title: 'dshquick' }]),
  })
  plugin.apply(context)
  const source = sources[0]
  const [row] = await source.candidates({ sessionId: 's1' }, { query: '' })
  assert.deepEqual(source.onPick({ candidate: row, action: 'pick' }), {
    insert: {
      source: 'reference',
      ref: '@D:/dshquick/',
      label: 'dshquick/',
      appearance: 'folder',
      clipboardText: '@D:/dshquick/',
    },
  })
})

test('picks quote paths that contain whitespace', async () => {
  const plugin = definition.factory(() => {})
  const { context, sources } = makeContext({
    workspaces: makeWorkspaces([{ workspaceId: 'a', path: 'E:/项目 一', title: '项目一' }]),
  })
  plugin.apply(context)
  const source = sources[0]
  const [row] = await source.candidates({ sessionId: 's1' }, { query: '' })
  const picked = source.onPick({ candidate: row })
  assert.equal(picked.insert.ref, '@"E:/项目 一/"')
  assert.equal(picked.insert.label, '项目一/')
})

test('malformed picks and missing workspace projection yield no candidates', async () => {
  const plugin = definition.factory(() => {})
  const broken = makeContext({ workspaces: undefined })
  plugin.apply(broken.context)
  assert.deepEqual(await broken.sources[0].candidates({ sessionId: 's1' }, { query: '' }), [])
  assert.equal(broken.sources[0].onPick({ candidate: { value: 'not json' } }), undefined)
  assert.equal(broken.sources[0].onPick({ candidate: { value: JSON.stringify({ title: 'no path' }) } }), undefined)
})

test('host half exports an empty apply', async () => {
  const host = await import('../lib/index.js')
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.apply(), undefined)
})
