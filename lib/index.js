/**
 * dsh-workspace-mention —— 宿主半体。
 *
 * 浏览器半体负责让用户在输入框里 `@` 一个工作区并插入它的根目录引用；
 * 这一半负责把「路径」升级成「上下文」：在用户消息进入模型之前
 * （`agent/pre-step` 瀑布），扫描这条消息里的 `@<绝对路径>/` 引用，
 * 命中的路径如果正好是某个已登记工作区的根目录，就在这条用户消息后面
 * 追加一条只读的上下文消息，内容是该工作区的结构树、清单要点、
 * README 摘要与 git 状态。
 *
 * 设计约束：
 *   - 这是「增强」不是「拦截」：任何失败都原样放行，绝不让用户这一轮报错。
 *   - 上下文是不可信背景（文件系统内容），带固定警告，且不含文件正文。
 *   - 不 import 任何 DSH 包，只依赖 node 标准库，避免插件目录的模块解析问题。
 */
import { randomUUID } from 'node:crypto'
import {
  LIMITS,
  buildWorkspaceBrief,
  collectReferencedWorkspaces,
  renderWorkspacePrompt,
} from './workspace-brief.js'

export * from './workspace-brief.js'

/** 上下文消息的来源标记：UI 会把它渲染成可折叠的「注入上下文」行。 */
const SOURCE_KIND = 'workspace-reference'

/** `notice` 折叠行的一句话摘要上限（与 DSH 的 CONTEXT_SUMMARY_MAX_CHARS 一致）。 */
const SUMMARY_MAX_CHARS = 120

/**
 * 把一句话摘要裁到上限。
 * @param {string} summary - 原始摘要。
 * @returns {string} 裁剪后的摘要。
 */
function boundSummary(summary) {
  return summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * 构造一条 model-facing 的 user 上下文消息。
 *
 * 字段与 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 产物一致
 * （id / role / content / source），只是不把这个包作为依赖引入。
 * @param {{kind: string, form: string, version: number, summary?: string, references?: object[]}} source - 来源标记。
 * @param {string} text - 模型可见文本。
 * @returns {object} 一条冻结前的 user 消息。
 */
function contextMessage(source, text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

/**
 * 从一条消息的 content 里拼出纯文本。
 * @param {readonly object[] | undefined} content - 消息内容块。
 * @returns {string} 文本。
 */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 为一条已经带有工作区引用的消息补上快照上下文。
 * @param {object} ctx - 宿主 Context。
 * @param {readonly object[]} messages - 这一步进入模型的用户消息。
 * @param {AbortSignal | undefined} signal - 本轮取消信号。
 * @returns {Promise<readonly object[] | undefined>} 替换后的消息列表；无需改动时 undefined。
 */
export async function attachWorkspaceContext(ctx, messages, signal) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  const workspaces = registry.list().map((workspace) => ({
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
  }))
  if (workspaces.length === 0) return undefined

  let changed = false
  const output = []
  for (const [index, message] of messages.entries()) {
    output.push(message)
    if (message?.source?.kind !== 'user') continue
    // 已经为这条消息准备过快照就不再重复注入（同一批消息被再次处理时）。
    if (messages[index + 1]?.source?.kind === SOURCE_KIND) continue
    const matched = collectReferencedWorkspaces(messageText(message.content), workspaces, LIMITS.maxReferences)
    if (matched.length === 0) continue
    if (signal?.aborted === true) return undefined
    const briefs = await Promise.all(matched.map((workspace) => buildWorkspaceBrief(workspace, LIMITS)))
    if (signal?.aborted === true) return undefined
    output.push(contextMessage({
      kind: SOURCE_KIND,
      form: 'notice',
      version: 1,
      summary: boundSummary(`Workspace: ${briefs.map((brief) => brief.label).join(', ')}`),
      references: briefs.map((brief) => ({ label: brief.label, path: brief.path })),
    }, renderWorkspacePrompt(briefs, LIMITS)))
    changed = true
  }
  return changed ? output : undefined
}

/**
 * 宿主插件主体：挂一个 `agent/pre-step` 监听器。
 * @param {object} ctx - 宿主 Context。
 */
export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ signal }, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    if (signal?.aborted === true) return decision
    try {
      const messages = await attachWorkspaceContext(ctx, decision.messages, signal)
      return messages === undefined ? decision : { ...decision, messages }
    } catch (error) {
      // 增强失败绝不影响本轮对话。
      console.warn('[workspace-mention] workspace context preparation failed:', error)
      return decision
    }
  }, { prepend: true })
}
