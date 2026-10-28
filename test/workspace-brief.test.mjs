/**
 * 工作区快照 + pre-step 注入的单元测试。
 *
 * 快照部分在临时目录上跑真实文件系统；注入部分用假 Context 与假工作区注册表，
 * 直接检验「消息后面是否多了一条上下文消息」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import {
  LIMITS,
  attachWorkspaceContext,
  buildWorkspaceBrief,
  collectReferencedWorkspaces,
  extractMentionTokens,
  matchWorkspace,
  normalizeForCompare,
  renderWorkspacePrompt,
} from '../lib/index.js'

/** 测试用的临时工作区根目录。 */
let root

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-mention-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'export const answer = 42\n')
  await fs.writeFile(path.join(root, 'src', 'util.js'), 'export const noop = () => {}\n')
  await fs.mkdir(path.join(root, 'node_modules', 'noise'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    version: '1.2.3',
    private: true,
    scripts: { build: 'tsc', test: 'node --test' },
    dependencies: { a: '1.0.0', b: '2.0.0' },
  }, null, 2))
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture App\n\n这是一个用于测试的工作区。\n\n## 用法\n\nnpm test\n')
  await fs.mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true })
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await fs.writeFile(path.join(root, '.git', 'refs', 'heads', 'main'), '0123456789abcdef0123456789abcdef01234567\n')
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('extractMentionTokens reads bare and quoted mentions', () => {
  assert.deepEqual(extractMentionTokens('看看 @D:/proj/ 和 @"E:/两个 词/" 还有 @./rel'), [
    'D:/proj/',
    'E:/两个 词/',
    './rel',
  ])
  assert.deepEqual(extractMentionTokens('邮箱 a@b.com 不是 mention'), [])
  assert.deepEqual(extractMentionTokens('引用标记：@D:/proj/'), ['D:/proj/'])
  assert.deepEqual(extractMentionTokens('没有 mention'), [])
})

test('normalizeForCompare squares slashes and trailing separators', () => {
  assert.equal(normalizeForCompare('D:\\Proj\\Sub\\'), process.platform === 'win32' ? 'd:/proj/sub' : 'D:/Proj/Sub')
})

test('matchWorkspace only matches an absolute path equal to a registered root', () => {
  const workspaces = [{ id: 'w1', path: 'D:\\proj', title: 'proj' }]
  assert.equal(matchWorkspace('D:/proj/', workspaces)?.id, 'w1')
  assert.equal(matchWorkspace('d:\\proj', workspaces)?.id, 'w1')
  assert.equal(matchWorkspace('D:/proj/src', workspaces), undefined)
  assert.equal(matchWorkspace('./proj', workspaces), undefined)
  assert.equal(matchWorkspace('D:/other', workspaces), undefined)
})

test('collectReferencedWorkspaces dedupes and keeps first-seen order', () => {
  const workspaces = [
    { id: 'w1', path: 'D:\\proj', title: 'proj' },
    { id: 'w2', path: 'E:\\other', title: 'other' },
  ]
  const matched = collectReferencedWorkspaces('a @D:/proj/ b @E:/other/ c @D:/proj/', workspaces)
  assert.deepEqual(matched.map((item) => item.id), ['w1', 'w2'])
  assert.equal(collectReferencedWorkspaces('a @D:/proj/ b @D:/proj/', workspaces, 1).length, 1)
})

test('buildWorkspaceBrief summarises tree, manifest, readme and git', async () => {
  const brief = await buildWorkspaceBrief({ id: 'w1', path: root, title: 'Fixture' })
  assert.equal(brief.label, 'Fixture')
  const names = brief.sections.map((section) => section.name)
  assert.deepEqual(names, ['tree', 'manifest', 'readme', 'git'])
  const tree = brief.sections.find((section) => section.name === 'tree').text
  assert.match(tree, /src\//u)
  assert.match(tree, /package\.json/u)
  assert.doesNotMatch(tree, /node_modules/u)
  assert.match(brief.sections.find((section) => section.name === 'manifest').text, /fixture-app@1\.2\.3/u)
  assert.match(brief.sections.find((section) => section.name === 'readme').text, /Fixture App/u)
  assert.match(brief.sections.find((section) => section.name === 'git').text, /branch: main/u)
  assert.match(brief.sections.find((section) => section.name === 'git').text, /0123456789ab/u)
})

test('buildWorkspaceBrief tolerates a missing directory', async () => {
  const brief = await buildWorkspaceBrief({ id: 'w2', path: path.join(root, 'missing-dir'), title: 'gone' })
  assert.equal(brief.label, 'gone')
  // 目录读不到时只剩路径，仍然给出一个可用的最小快照
  assert.deepEqual(brief.sections, [])
})

test('renderWorkspacePrompt carries the untrusted warning and escapes tags', async () => {
  const brief = await buildWorkspaceBrief({ id: 'w1', path: root, title: 'Fixture' })
  const prompt = renderWorkspacePrompt([{ ...brief, sections: [{ name: 'tree', text: '<script>alert(1)</script>' }] }])
  assert.match(prompt, /untrusted, read-only/u)
  assert.match(prompt, /<referenced-workspaces>/u)
  assert.match(prompt, /\\u003cscript>/u)
  assert.doesNotMatch(prompt, /<script>/u)
})

test('budget keeps the rendered prompt bounded', async () => {
  const brief = await buildWorkspaceBrief({ id: 'w1', path: root, title: 'Fixture' })
  const fat = [{ ...brief, sections: [{ name: 'readme', text: 'x'.repeat(50000) }] }]
  const prompt = renderWorkspacePrompt(fat)
  assert.ok(prompt.length < LIMITS.maxTotalChars + 1000, `prompt length ${prompt.length}`)
  assert.match(prompt, /truncated/u)
})

test('attachWorkspaceContext appends one context message after the citing message', async () => {
  const calls = []
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { list: () => [{ id: 'w1', path: root, title: 'Fixture' }] }
    },
  }
  const messages = [{
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `看看这个工作区 @${root.replace(/\\/gu, '/')}/` }],
  }]
  const result = await attachWorkspaceContext(ctx, messages, undefined)
  assert.equal(result.length, 2)
  assert.equal(result[0], messages[0])
  const context = result[1]
  assert.equal(context.source.kind, 'workspace-reference')
  assert.equal(context.source.form, 'notice')
  assert.match(context.content[0].text, /referenced-workspaces/u)
  assert.match(context.content[0].text, /Fixture/u)
  assert.match(context.source.summary, /Fixture/u)
})

test('attachWorkspaceContext leaves unrelated messages untouched', async () => {
  const ctx = {
    get: () => ({ list: () => [{ id: 'w1', path: root, title: 'Fixture' }] }),
  }
  const messages = [{
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '没有引用任何工作区的普通消息 @README.md' }],
  }]
  assert.equal(await attachWorkspaceContext(ctx, messages, undefined), undefined)
})

test('attachWorkspaceContext is idempotent for a message that already has context', async () => {
  const ctx = {
    get: () => ({ list: () => [{ id: 'w1', path: root, title: 'Fixture' }] }),
  }
  const user = {
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `@${root.replace(/\\/gu, '/')}/` }],
  }
  const prepared = [user, { id: 'c1', role: 'user', source: { kind: 'workspace-reference' }, content: [] }]
  assert.equal(await attachWorkspaceContext(ctx, prepared, undefined), undefined)
})

test('attachWorkspaceContext degrades quietly when the registry is missing', async () => {
  const ctx = { get: () => undefined }
  const messages = [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '@D:/proj/' }] }]
  assert.equal(await attachWorkspaceContext(ctx, messages, undefined), undefined)
})
