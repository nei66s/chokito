import express, { type Request, type Response } from 'express'
import dotenv from 'dotenv'
import fs from 'fs/promises'
import fssync from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { runAgent, streamAgent, tokenBudget, fileCache } from './llm.js'
import {
  initDatabase,
  getConversationCosts,
  saveCoordinatorTask,
  saveCoordinatedSubtask,
  getCoordinatorTasks,
  getCoordinatedSubtasks,
} from './db.js'
import { Coordinator } from './coordinator/index.js'
import {
  createConversation,
  deleteConversation,
  duplicateConversation,
  getWorkflowState,
  listConversations,
  renameConversation,
  saveConversationSnapshot,
} from './store.js'
import { getToolStatuses, runTool, type PermissionMode } from './tools.js'
import { moderateText } from './moderation.js'
import { initPermissionPipeline, getPermissionPipeline } from './permissions/index.js'
import { initDefaultRules } from './permissions/defaults.js'
import { getHookRegistry, initHooks } from './hooks/index.js'
import { AuditLogger } from './audit/logger.js'
import {
  deletePluginManifest,
  getPluginRuntime,
  getPluginRegistry,
  hydrateRegistryFromStorage,
  initPluginRegistry,
  initPluginRuntime,
  initPluginStorage,
  loadPluginsFromDirectory,
  setPluginEnabled,
  upsertPluginManifest,
  validatePluginManifest,
} from './plugins/index.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : path.resolve(process.cwd(), '..')
const PLUGINS_ROOT = process.env.PLUGINS_ROOT
  ? path.resolve(process.env.PLUGINS_ROOT)
  : path.resolve(process.cwd(), 'plugins')

const app = express()
app.use(express.json())
app.use(express.static(path.resolve(__dirname, '..', 'public')))

// === Coordinator Instance ===
// Controlled by CHOKITO_COORDINATOR_MODE env var (any truthy value enables it).
// Default: disabled. Set CHOKITO_COORDINATOR_MODE=true in .env to enable.
function isCoordinatorMode(): boolean {
  const raw = String(process.env.CHOKITO_COORDINATOR_MODE || '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

const coordinator = new Coordinator({
  maxWorkers: 6,
  taskDecompositionTokenLimit: 2000,
  routingStrategy: 'skill-match',
})

type RequestUser = {
  id: string
  displayName: string
}

function getFullAccess(req: Request) {
  const headerValue = req.header('x-chocks-full-access')
  const bodyValue = req.body?.fullAccess
  const queryValue = req.query?.fullAccess
  const raw = String(headerValue ?? bodyValue ?? queryValue ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

function getPermissionMode(req: Request): PermissionMode {
  const headerValue = req.header('x-chocks-permission-mode')
  const bodyValue = req.body?.permissionMode
  const queryValue = req.query?.permissionMode
  const raw = String(headerValue ?? bodyValue ?? queryValue ?? '').trim().toLowerCase()
  if (raw === 'auto') return 'auto'
  if (raw === 'read_only' || raw === 'readonly' || raw === 'read-only') return 'read_only'
  return 'ask'
}

function getApprovedTools(req: Request) {
  const headerValue = req.header('x-chocks-approved-tools')
  const bodyValue = req.body?.approvedTools
  const rawItems = Array.isArray(bodyValue)
    ? bodyValue
    : String(headerValue || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

  return rawItems.map((item: unknown) => String(item || '').trim()).filter(Boolean)
}

async function executeToolWithPlugins(tool: string, input: unknown, context: {
  chatId?: string
  userId?: string
  displayName?: string
  fullAccess?: boolean
  permissionMode?: PermissionMode
  latestUserMessage?: string
  approvedTools?: string[]
} = {}) {
  const pluginRuntime = getPluginRuntime()
  if (pluginRuntime.hasTool(tool)) {
    return pluginRuntime.runTool(tool, input, context)
  }
  return runTool(tool, input, context)
}

async function syncPluginRuntimeFromRegistry() {
  const pluginRuntime = getPluginRuntime()
  await pluginRuntime.syncWithRegistry()
  return pluginRuntime.getRuntimeStatus()
}

function resolveRequestedPathForFiles(req: Request, targetPath: string) {
  const fullAccess = getFullAccess(req)
  const trimmed = String(targetPath || '').trim()
  if (!trimmed) throw new Error('path required')

  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : fullAccess
      ? path.resolve(trimmed)
      : path.resolve(PROJECT_ROOT, trimmed)

  if (fullAccess) return absolutePath
  if (absolutePath === PROJECT_ROOT || absolutePath.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    return absolutePath
  }

  throw new Error('path outside project not allowed')
}

type DirectDeleteIntent = {
  path: string
}

type DirectReadIntent = {
  path: string
}

function parseDesktopListIntent(text: string) {
  const normalized = String(text || '').trim().toLowerCase()
  if (!normalized) return false

  const mentionsDesktop =
    normalized.includes('area de trabalho') ||
    normalized.includes('área de trabalho') ||
    normalized.includes('desktop')

  const asksToList =
    normalized.includes('o que tem') ||
    normalized.includes('listar') ||
    normalized.includes('liste') ||
    normalized.includes('mostre') ||
    normalized.includes('veja') ||
    normalized.includes('quais arquivos') ||
    normalized.includes('quais pastas')

  return mentionsDesktop && asksToList
}

async function resolveDesktopPath() {
  const candidates = [
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Área de Trabalho') : null,
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      // try next candidate
    }
  }

  return null
}

async function tryDirectDesktopList(messages: any[], req: Request) {
  const userText = getLastUserMessageText(messages)
  if (!parseDesktopListIntent(userText)) return null

  if (!getFullAccess(req)) {
    return {
      output_text: 'Ative o botão "Acesso total: off/on" na barra superior para eu listar a sua Área de Trabalho do sistema.',
      trace: [],
    }
  }

  const desktopPath = await resolveDesktopPath()
  if (!desktopPath) {
    return {
      output_text: 'Nao encontrei a pasta da Area de Trabalho neste computador.',
      trace: [],
    }
  }

  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
  const user = getRequestUser(req)
  const out = await runTool('ls_safe', { path: desktopPath }, {
    chatId,
    userId: user.id,
    displayName: user.displayName,
    fullAccess: true,
    permissionMode: getPermissionMode(req),
    latestUserMessage: userText,
    approvedTools: getApprovedTools(req),
  })
  const callId = `direct_desktop_${Date.now()}`
  const entries = Array.isArray(out?.output?.entries) ? out.output.entries : []
  const sortedEntries = [...entries].sort((a: any, b: any) => {
    if (a?.type !== b?.type) return a?.type === 'dir' ? -1 : 1
    return String(a?.name || '').localeCompare(String(b?.name || ''), 'pt-BR', { sensitivity: 'base' })
  })
  const preview = sortedEntries.slice(0, 40)
  const lines = preview.map((entry: any) => `${entry.type === 'dir' ? 'Pasta' : 'Arquivo'}  ${entry.name}`)
  const summary = `${entries.length} ${entries.length === 1 ? 'item encontrado' : 'itens encontrados'}`
  const suffix = entries.length > preview.length ? `\n\nMostrando ${preview.length} de ${entries.length} itens.` : ''

  return {
    output_text: `Area de Trabalho\n${desktopPath}\n\n${summary}\n\n${lines.join('\n') || 'Vazia.'}${suffix}`,
    trace: [
      {
        type: 'tool_call',
        name: 'ls_safe',
        call_id: callId,
        arguments: JSON.stringify({ path: desktopPath }),
      },
      {
        type: 'tool_output',
        call_id: callId,
        output: JSON.stringify(out),
      },
    ],
  }
}

function getRequestUser(req: Request): RequestUser {
  const idHeader = req.header('x-chocks-user-id')
  const displayNameHeader = req.header('x-chocks-display-name')
  const id = String(idHeader || req.body?.userId || req.query?.userId || 'legacy-local').trim() || 'legacy-local'
  const displayName = String(displayNameHeader || req.body?.displayName || 'Local user').trim() || 'Local user'
  return { id, displayName }
}

function getLastUserMessageText(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && typeof message?.content === 'string' && message.content.trim()) {
      return message.content.trim()
    }
  }
  return ''
}

function parseDirectDeleteIntent(text: string): DirectDeleteIntent | null {
  const normalized = String(text || '').trim()
  if (!normalized) return null

  const deleteVerb = /\b(apague|apagar|exclua|excluir|delete|remova|remover)\b/iu
  if (!deleteVerb.test(normalized)) return null

  const quotedPathMatch = normalized.match(/["']([A-Za-z]:[\\/][^"']+)["']/u)
  if (quotedPathMatch?.[1]) {
    return { path: quotedPathMatch[1] }
  }

  const windowsPathMatch = normalized.match(/[A-Za-z]:[\\/][^\r\n]+/u)
  if (!windowsPathMatch?.[0]) return null

  const extractedPath = windowsPathMatch[0].trim().replace(/[.,;:!?]+$/u, '')
  if (!extractedPath) return null
  return { path: extractedPath }
}

function extractWorkspacePath(text: string) {
  const normalized = String(text || '').trim()
  if (!normalized) return null

  const quotedPathMatch = normalized.match(/["']([A-Za-z]:[\\/][^"']+?\.[A-Za-z0-9_-]+)["']/u)
  if (quotedPathMatch?.[1]) {
    return quotedPathMatch[1]
  }

  const windowsPathMatch = normalized.match(/[A-Za-z]:[\\/][^\r\n"'?]+?\.[A-Za-z0-9_-]+/u)
  if (!windowsPathMatch?.[0]) return null
  const extractedPath = windowsPathMatch[0].trim().replace(/[.,;:!?]+$/u, '')
  return extractedPath || null
}

function parseDirectReadIntent(text: string): DirectReadIntent | null {
  const normalized = String(text || '').trim()
  if (!normalized) return null

  const lowered = normalized.toLowerCase()
  const hasReadIntent =
    lowered.includes('leia') ||
    lowered.includes('ler ') ||
    lowered.includes('mostre') ||
    lowered.includes('mostrar') ||
    lowered.includes('veja') ||
    lowered.includes('ver ') ||
    lowered.includes('abra') ||
    lowered.includes('abrir') ||
    lowered.includes('conteudo') ||
    lowered.includes('conteúdo') ||
    lowered.includes('o que esta escrito') ||
    lowered.includes('o que está escrito')
  if (!hasReadIntent) return null

  const extractedPath = extractWorkspacePath(normalized)
  if (!extractedPath) return null
  return { path: extractedPath }
}

async function tryDirectDelete(messages: any[], req: Request) {
  const userText = getLastUserMessageText(messages)
  const intent = parseDirectDeleteIntent(userText)
  if (!intent) return null

  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
  const user = getRequestUser(req)
  const fullAccess = getFullAccess(req)
  const out = await runTool('file_delete', { path: intent.path }, {
    chatId,
    userId: user.id,
    displayName: user.displayName,
    fullAccess,
    permissionMode: getPermissionMode(req),
    latestUserMessage: userText,
    approvedTools: getApprovedTools(req),
  })
  const callId = `direct_delete_${Date.now()}`

  return {
    output_text: `Arquivo excluido com sucesso: ${intent.path}`,
    trace: [
      {
        type: 'tool_call',
        name: 'file_delete',
        call_id: callId,
        arguments: JSON.stringify({ path: intent.path }),
      },
      {
        type: 'tool_output',
        call_id: callId,
        output: JSON.stringify(out),
      },
    ],
  }
}

async function tryDirectRead(messages: any[], req: Request) {
  const userText = getLastUserMessageText(messages)
  const intent = parseDirectReadIntent(userText)
  if (!intent) return null

  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
  const user = getRequestUser(req)
  const fullAccess = getFullAccess(req)
  const out = await runTool('file_read', { path: intent.path }, {
    chatId,
    userId: user.id,
    displayName: user.displayName,
    fullAccess,
    permissionMode: getPermissionMode(req),
    latestUserMessage: userText,
    approvedTools: getApprovedTools(req),
  })
  const callId = `direct_read_${Date.now()}`
  const content = String(out?.output || '')

  return {
    output_text: content
      ? `Conteudo de ${intent.path}:\n\n${content}`
      : `O arquivo ${intent.path} esta vazio.`,
    trace: [
      {
        type: 'tool_call',
        name: 'file_read',
        call_id: callId,
        arguments: JSON.stringify({ path: intent.path }),
      },
      {
        type: 'tool_output',
        call_id: callId,
        output: JSON.stringify(out),
      },
    ],
  }
}

app.get('/conversations', async (_req: Request, res: Response) => {
  try {
    const user = getRequestUser(_req)
    const conversations = await listConversations(user.id)
    res.json({ conversations })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/conversations', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : ''
  const title = typeof req.body?.title === 'string' ? req.body.title : 'Nova conversa'
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const user = getRequestUser(req)
    const conversation = await createConversation({ id, title }, user)
    res.status(201).json({ conversation })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.put('/conversations/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ error: 'conversation id required' })

  try {
    const user = getRequestUser(req)
    const conversation = await saveConversationSnapshot({
      id,
      ownerId: user.id,
      title: req.body?.title,
      messages: req.body?.messages,
    }, user)
    res.json({ conversation })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.patch('/conversations/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim()
  const title = String(req.body?.title || '').trim()
  if (!id) return res.status(400).json({ error: 'conversation id required' })
  if (!title) return res.status(400).json({ error: 'title required' })

  try {
    const user = getRequestUser(req)
    const conversation = await renameConversation(id, title, user.id)
    res.json({ conversation })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/conversations/:id/duplicate', async (req: Request, res: Response) => {
  const sourceId = String(req.params.id || '').trim()
  const nextId = String(req.body?.id || '').trim()
  if (!sourceId) return res.status(400).json({ error: 'source conversation id required' })
  if (!nextId) return res.status(400).json({ error: 'new conversation id required' })

  try {
    const user = getRequestUser(req)
    const conversation = await duplicateConversation(sourceId, nextId, user)
    res.status(201).json({ conversation })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.delete('/conversations/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ error: 'conversation id required' })

  try {
    const user = getRequestUser(req)
    const result = await deleteConversation(id, user.id)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/chat', async (req: Request, res: Response) => {
  const messages = req.body?.messages
  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required (array)' })

  // Simple moderation: join user messages and check
  const userText = messages.map((m: any) => m.content || '').join('\n')
  try {
    const mod = await moderateText(userText)
    if (!mod.allowed) return res.status(403).json({ error: 'content blocked by moderation', details: mod })

    const directDelete = await tryDirectDelete(messages, req)
    if (directDelete) {
      return res.json({
        output_text: directDelete.output_text,
        response: { output_text: directDelete.output_text },
        trace: directDelete.trace,
      })
    }

    const directDesktopList = await tryDirectDesktopList(messages, req)
    if (directDesktopList) {
      return res.json({
        output_text: directDesktopList.output_text,
        response: { output_text: directDesktopList.output_text },
        trace: directDesktopList.trace,
      })
    }

    const directRead = await tryDirectRead(messages, req)
    if (directRead) {
      return res.json({
        output_text: directRead.output_text,
        response: { output_text: directRead.output_text },
        trace: directRead.trace,
      })
    }

    const user = getRequestUser(req)
    const latestUserMessage = getLastUserMessageText(messages)
    const pluginRuntime = getPluginRuntime()
    const result = await runAgent(messages, {
      chatId,
      userId: user.id,
      displayName: user.displayName,
      fullAccess: getFullAccess(req),
      permissionMode: getPermissionMode(req),
      latestUserMessage,
      approvedTools: getApprovedTools(req),
    }, {
      extraToolDefinitions: pluginRuntime.listToolDefinitions(),
      executeTool: executeToolWithPlugins,
    })
    res.json({
      output_text: result.response.output_text,
      response: result.response,
      trace: result.trace,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/chat/stream', async (req: Request, res: Response) => {
  const messages = req.body?.messages
  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required (array)' })

  const userText = messages.map((m: any) => m.content || '').join('\n')
  try {
    const mod = await moderateText(userText)
    if (!mod.allowed) return res.status(403).json({ error: 'content blocked by moderation', details: mod })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const directDelete = await tryDirectDelete(messages, req)
    if (directDelete) {
      sendEvent('trace', directDelete.trace[0])
      sendEvent('trace', directDelete.trace[1])
      sendEvent('done', {
        output_text: directDelete.output_text,
        trace: directDelete.trace,
      })
      return res.end()
    }

    const directDesktopList = await tryDirectDesktopList(messages, req)
    if (directDesktopList) {
      for (const entry of directDesktopList.trace) {
        sendEvent('trace', entry)
      }
      sendEvent('done', {
        output_text: directDesktopList.output_text,
        trace: directDesktopList.trace,
      })
      return res.end()
    }

    const directRead = await tryDirectRead(messages, req)
    if (directRead) {
      sendEvent('trace', directRead.trace[0])
      sendEvent('trace', directRead.trace[1])
      sendEvent('done', {
        output_text: directRead.output_text,
        trace: directRead.trace,
      })
      return res.end()
    }

    const user = getRequestUser(req)
    const latestUserMessage = getLastUserMessageText(messages)
    const pluginRuntime = getPluginRuntime()
    const result = await streamAgent(messages, {
      chatId,
      userId: user.id,
      displayName: user.displayName,
      fullAccess: getFullAccess(req),
      permissionMode: getPermissionMode(req),
      latestUserMessage,
      approvedTools: getApprovedTools(req),
    }, {
      onTextDelta: (delta) => sendEvent('text-delta', { delta }),
      onTrace: (entry) => sendEvent('trace', entry),
    }, {
      extraToolDefinitions: pluginRuntime.listToolDefinitions(),
      executeTool: executeToolWithPlugins,
    })

    sendEvent('done', {
      output_text: result.response.output_text,
      trace: result.trace,
    })
    res.end()
  } catch (err) {
    res.write(`event: error\n`)
    res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
    res.end()
  }
})

app.post('/tools/run', async (req: Request, res: Response) => {
  const tool = req.body?.tool
  const input = req.body?.input
  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
  if (!tool) return res.status(400).json({ error: 'tool required' })

  try {
    const user = getRequestUser(req)
    const context = {
      chatId,
      userId: user.id,
      displayName: user.displayName,
      fullAccess: getFullAccess(req),
      permissionMode: getPermissionMode(req),
      latestUserMessage: typeof req.body?.userMessage === 'string' ? req.body.userMessage : '',
      approvedTools: getApprovedTools(req),
    }

    // Phase 2: Permission pipeline check
    const pipeline = getPermissionPipeline()
    const permissionCheck = await pipeline.check(tool, input, context)
    
    if (!permissionCheck.allowed) {
      AuditLogger.logPermissionDenied(tool, permissionCheck.reason || 'Unknown', user.id, chatId)
      return res.status(403).json({
        error: 'permission denied',
        reason: permissionCheck.reason,
        step: permissionCheck.step,
      })
    }

    // Dispatch PreToolUse hook
    const hookRegistry = getHookRegistry()
    await hookRegistry.dispatch({
      type: 'PreToolUse',
      timestamp: new Date().toISOString(),
      userId: user.id,
      chatId,
      data: { tool, input },
    })

    const out = await executeToolWithPlugins(tool, input, context)
    
    // Log successful execution
    AuditLogger.logToolExecution(tool, input, out, user.id, chatId)

    // Dispatch PostToolUse hook
    await hookRegistry.dispatch({
      type: 'PostToolUse',
      timestamp: new Date().toISOString(),
      userId: user.id,
      chatId,
      data: { tool, input, output: out },
    })

    res.json(out)
  } catch (err) {
    const tool = req.body?.tool
    const user = getRequestUser(req)
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : undefined
    
    AuditLogger.log({
      action: 'tool_error',
      tool,
      error: String(err),
      userId: user.id,
      chatId,
    })

    res.status(500).json({ error: String(err) })
  }
})

app.get('/tools/status', (req: Request, res: Response) => {
  const pluginRuntime = getPluginRuntime()
  const pluginTools = pluginRuntime.listToolDefinitions().map((tool) => ({
    name: tool.name,
    enabled: true,
    category: 'plugin',
    reason: 'provided by plugin runtime',
  }))

  res.json({
    permissionMode: getPermissionMode(req),
    tools: [
      ...getToolStatuses({ permissionMode: getPermissionMode(req) }),
      ...pluginTools,
    ],
  })
})

app.get('/workflow/status', async (req: Request, res: Response) => {
  try {
    const chatId = typeof req.query?.chatId === 'string' ? req.query.chatId : undefined
    const user = getRequestUser(req)
    const active = await getWorkflowState(chatId, user.id)
    res.json({ active })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/audit/recent', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query?.limit || 50)
    const user = getRequestUser(req)
    const entries = AuditLogger.getRecent(limit, {
      userId: user.id,
    })
    res.json({ entries })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/audit/stats', async (req: Request, res: Response) => {
  try {
    const stats = AuditLogger.getStats()
    res.json({ stats })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/plugins', async (_req: Request, res: Response) => {
  try {
    const registry = getPluginRegistry()
    const plugins = registry.list()
    const runtime = getPluginRuntime().getRuntimeStatus()
    res.json({
      plugins,
      count: plugins.length,
      runtime,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/plugins/register', async (req: Request, res: Response) => {
  try {
    const inputManifest = req.body?.manifest ?? req.body
    const manifest = validatePluginManifest(inputManifest)

    if (typeof req.body?.source === 'string' && req.body.source.trim()) {
      manifest.source = req.body.source.trim()
    }

    const registry = getPluginRegistry()
    registry.register(manifest, { overwrite: true })
    await upsertPluginManifest(manifest)
    await syncPluginRuntimeFromRegistry()

    res.status(201).json({ plugin: manifest })
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

app.patch('/plugins/:id/enabled', async (req: Request, res: Response) => {
  const pluginId = String(req.params.id || '').trim()
  if (!pluginId) return res.status(400).json({ error: 'plugin id required' })

  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' })
  }

  try {
    const registry = getPluginRegistry()
    const plugin = registry.setEnabled(pluginId, req.body.enabled)
    await setPluginEnabled(pluginId, req.body.enabled)
    await syncPluginRuntimeFromRegistry()
    res.json({ plugin })
  } catch (err) {
    const message = String(err)
    if (message.includes('plugin not found')) {
      return res.status(404).json({ error: message })
    }
    return res.status(500).json({ error: message })
  }
})

app.delete('/plugins/:id', async (req: Request, res: Response) => {
  const pluginId = String(req.params.id || '').trim()
  if (!pluginId) return res.status(400).json({ error: 'plugin id required' })

  try {
    const registry = getPluginRegistry()
    const removed = registry.unregister(pluginId)
    await deletePluginManifest(pluginId)
    await syncPluginRuntimeFromRegistry()

    if (!removed) {
      return res.status(404).json({ error: `plugin not found: ${pluginId}` })
    }

    return res.json({ ok: true, pluginId })
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
})

app.post('/plugins/reload', async (req: Request, res: Response) => {
  const requestedDirectory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : ''
  const targetDirectory = requestedDirectory ? path.resolve(requestedDirectory) : PLUGINS_ROOT

  try {
    const report = await loadPluginsFromDirectory(targetDirectory)
    const registry = getPluginRegistry()
    let persisted = 0

    for (const entry of report.loaded) {
      registry.register(entry.manifest, { overwrite: true })
      await upsertPluginManifest(entry.manifest)
      persisted += 1
    }

    const runtime = await syncPluginRuntimeFromRegistry()

    res.json({
      directory: targetDirectory,
      loaded: report.loaded.length,
      failed: report.failed,
      persisted,
      plugins: registry.list(),
      runtime,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/plugins/runtime', async (_req: Request, res: Response) => {
  try {
    const runtime = getPluginRuntime().getRuntimeStatus()
    res.json({ runtime })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/files/download', async (req: Request, res: Response) => {
  const targetPath = String(req.query?.path || '').trim()
  if (!targetPath) return res.status(400).json({ error: 'path required' })

  try {
    const resolved = await runTool('file_read', { path: targetPath }, {
      fullAccess: getFullAccess(req),
      permissionMode: 'auto',
      approvedTools: ['file_read'],
    })
    if (!resolved?.ok) throw new Error('unable to read file')

    const absolutePath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : getFullAccess(req)
        ? path.resolve(targetPath)
        : path.resolve(process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : path.resolve(process.cwd(), '..'), targetPath)

    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) return res.status(400).json({ error: 'path is not a file' })

    res.download(absolutePath, path.basename(absolutePath))
  } catch (err) {
    const message = String(err)
    if (message.includes('outside project')) {
      return res.status(403).json({ error: message })
    }
    if (message.includes('ENOENT')) {
      return res.status(404).json({ error: 'file not found' })
    }
    if (!fssync.existsSync(targetPath) && message.includes('permission blocked')) {
      return res.status(403).json({ error: message })
    }
    return res.status(500).json({ error: message })
  }
})

app.get('/files/raw', async (req: Request, res: Response) => {
  const targetPath = String(req.query?.path || '').trim()
  if (!targetPath) return res.status(400).json({ error: 'path required' })

  try {
    const absolutePath = resolveRequestedPathForFiles(req, targetPath)
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) return res.status(400).json({ error: 'path is not a file' })
    res.sendFile(absolutePath)
  } catch (err) {
    const message = String(err)
    if (message.includes('outside project')) {
      return res.status(403).json({ error: message })
    }
    if (message.includes('ENOENT')) {
      return res.status(404).json({ error: 'file not found' })
    }
    return res.status(500).json({ error: message })
  }
})

// ===== Fase 5: QueryEngine Endpoints =====

// GET /api/cache/stats - Monitor file cache usage
app.get('/api/cache/stats', (_req: Request, res: Response) => {
  try {
    const stats = fileCache.stats()
    res.json({
      cache: stats,
      description: 'File content LRU cache statistics',
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/budget/:chatId - Get token budget progress
app.get('/api/budget/:chatId', (req: Request, res: Response) => {
  try {
    const chatId = String(req.params.chatId || '').trim()
    if (!chatId) return res.status(400).json({ error: 'chatId required' })

    const budget = tokenBudget.getBudget(chatId)
    if (!budget) {
      return res.json({
        chatId,
        found: false,
        message: 'No budget created yet for this chat',
      })
    }

    const progress = tokenBudget.getProgress(chatId)
    res.json({
      chatId,
      found: true,
      budget: {
        limit: budget.tokenLimit,
        used: budget.tokenUsed,
      },
      progress,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/costs - Get token costs for a conversation
app.get('/api/costs', async (req: Request, res: Response) => {
  try {
    const chatId = typeof req.query?.chatId === 'string' ? req.query.chatId : undefined
    if (!chatId) {
      return res.status(400).json({
        error: 'chatId required as query parameter',
        example: '/api/costs?chatId=conv-123',
      })
    }

    const costs = await getConversationCosts(chatId)
    res.json({
      chatId,
      costs,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ===== Fase 6: Coordinator Mode Endpoints =====

// GET /api/coordinator/mode - Check if coordinator mode is active
app.get('/api/coordinator/mode', (_req: Request, res: Response) => {
  res.json({
    enabled: isCoordinatorMode(),
    hint: isCoordinatorMode()
      ? 'Coordinator mode is active. Use /api/coordinator/orchestrate to dispatch tasks.'
      : 'Coordinator mode is disabled. Set CHOKITO_COORDINATOR_MODE=true in .env to enable.',
  })
})

// POST /api/coordinator/orchestrate - Decompose and orchestrate complex task
app.post('/api/coordinator/orchestrate', async (req: Request, res: Response) => {
  if (!isCoordinatorMode()) {
    return res.status(503).json({ error: 'Coordinator mode is disabled. Set CHOKITO_COORDINATOR_MODE=true to enable.' })
  }
  try {
    const { userMessage, chatId } = req.body
    if (!userMessage) {
      return res.status(400).json({ error: 'userMessage required' })
    }

    const conversationId = chatId || `coordinator-${Date.now()}`
    console.log(`[Coordinator] Orchestrating: ${userMessage.substring(0, 50)}`)

    const synthesis = await coordinator.orchestrateTask(userMessage, conversationId)

    // Persist to database (async, non-blocking)
    ;(async () => {
      try {
        // Get the most recent task that was created
        const coordinatedTask = coordinator.getLastCoordinatedTask()
        
        if (coordinatedTask) {
          // Save main task
          await saveCoordinatorTask(
            coordinatedTask.id,
            conversationId,
            userMessage,
            synthesis,
            'completed'
          )

          // Save all subtasks
          for (const subtask of coordinatedTask.decomperatedSubtasks) {
            await saveCoordinatedSubtask(
              subtask.id,
              coordinatedTask.id,
              subtask.description,
              subtask.assignedWorkerId,
              subtask.status,
              subtask.result,
              subtask.error
            )
          }

          console.log(`[Coordinator] Task ${coordinatedTask.id} persisted to database`)
        }
      } catch (dbError) {
        console.error('[Coordinator] Database persistence error:', dbError instanceof Error ? dbError.message : String(dbError))
      }
    })()

    res.json({
      success: true,
      conversationId,
      synthesis,
      message: 'Task orchestrated across specialized workers',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[Coordinator] Error:', message)
    res.status(500).json({
      success: false,
      error: message,
    })
  }
})

// GET /api/coordinator/stats - Get coordinator statistics
app.get('/api/coordinator/stats', (_req: Request, res: Response) => {
  if (!isCoordinatorMode()) {
    return res.status(503).json({ error: 'Coordinator mode is disabled.' })
  }
  try {
    const coordinatorStats = coordinator.getCoordinatorStats()
    const workerPool = coordinator['workerPool']
    const poolStats = workerPool.getPoolStats()
    const routingStats = coordinator['router'].getRoutingStats()

    res.json({
      coordinator: coordinatorStats,
      workerPool: poolStats,
      routing: routingStats,
      description: 'Coordinator and worker pool statistics',
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/coordinator/workers - List all workers and their status
  // (supports fallback chains with retry logic)
app.get('/api/coordinator/workers', (_req: Request, res: Response) => {
  if (!isCoordinatorMode()) {
    return res.status(503).json({ error: 'Coordinator mode is disabled.' })
  }
  try {
    const workerPool = coordinator['workerPool']
    const workers = workerPool.getAllWorkers()

    res.json({
      workers: workers.map(w => ({
        id: w.id,
        name: w.name,
        specialty: w.specialty,
        isAvailable: w.isAvailable,
        currentTask: w.currentTask,
        skillset: w.skillset,
      })),
      count: workers.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/coordinator/tasks/:conversationId - Get task history for a conversation
app.get('/api/coordinator/tasks/:conversationId', async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId || '')
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId required' })
    }

    const tasks = await getCoordinatorTasks(conversationId)
    res.json({
      conversationId,
      tasks,
      count: tasks.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/coordinator/tasks/:conversationId/:taskId - Get subtasks for a task
app.get('/api/coordinator/tasks/:conversationId/:taskId', async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId || '')
    if (!taskId) {
      return res.status(400).json({ error: 'taskId required' })
    }

    const subtasks = await getCoordinatedSubtasks(taskId)
    res.json({
      taskId,
      subtasks,
      count: subtasks.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ============ FASE 7: AGENT SWARMS ENDPOINTS ============

import * as swarms from './swarm/index.js'

// POST /api/swarm/teams - Create a new team
app.post('/api/swarm/teams', async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body
    if (!name) {
      return res.status(400).json({ error: 'Team name required' })
    }

    // Generate unique name if needed
    const uniqueName = await swarms.generateUniqueName(name)
    const config = await swarms.createTeam(uniqueName, description)

    res.json({
      success: true,
      teamName: config.name,
      leadAgentId: config.leadAgentId,
      createdAt: config.createdAt,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/swarm/teams - List all teams
app.get('/api/swarm/teams', async (req: Request, res: Response) => {
  try {
    const teams = await swarms.listTeams()
    const teamConfigs = []

    for (const teamName of teams) {
      const config = await swarms.loadTeamConfig(teamName)
      if (config) {
        teamConfigs.push({
          name: config.name,
          description: config.description,
          createdAt: config.createdAt,
          leadAgentId: config.leadAgentId,
          memberCount: config.members.length,
          members: config.members.map((m) => ({
            agentId: m.agentId,
            name: m.name,
            isActive: m.isActive,
            backendType: m.backendType,
          })),
        })
      }
    }

    res.json({
      teams: teamConfigs,
      count: teamConfigs.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/swarm/teams/:teamName/spawn - Spawn a teammate
app.post('/api/swarm/teams/:teamName/spawn', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')
    const {
      name,
      model,
      color,
      permissionMode,
      planModeRequired,
      backendType,
      cwd,
      initialPrompt,
    } = req.body

    if (!name || !cwd || !initialPrompt) {
      return res.status(400).json({
        error: 'name, cwd, and initialPrompt required',
      })
    }

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    const member = await swarms.spawnTeammate({
      name,
      teamName,
      model,
      color,
      permissionMode,
      planModeRequired,
      backendType: backendType as swarms.BackendType,
      cwd,
      initialPrompt,
    })

    res.json({
      success: true,
      agentId: member.agentId,
      name: member.name,
      backendType: member.backendType,
      isActive: member.isActive,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/swarm/teams/:teamName/send-message - Send message to teammate
app.post('/api/swarm/teams/:teamName/send-message', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')
    const { from, to, content } = req.body

    if (!from || !to || !content) {
      return res.status(400).json({
        error: 'from, to, and content required',
      })
    }

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    const message = await swarms.sendDirectMessage(teamName, from, to, content)

    res.json({
      success: true,
      messageId: message.id,
      timestamp: message.timestamp,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/swarm/teams/:teamName/mailbox/:agentName - Read mailbox for agent
app.get('/api/swarm/teams/:teamName/mailbox/:agentName', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')
    const agentName = String(req.params.agentName || '')

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    const messages = await swarms.readMailbox(teamName, agentName)

    res.json({
      teamName,
      agentName,
      messages,
      count: messages.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/swarm/teams/:teamName/shutdown - Shutdown entire team
app.post('/api/swarm/teams/:teamName/shutdown', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    await swarms.shutdownTeam(teamName)

    res.json({
      success: true,
      message: `Team ${teamName} shut down and deleted`,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ============ FASE 7 SESSION 2: PERMISSION DELEGATION + PLAN MODE ============

import * as swarmPerms from './swarm/permissions.js'
import * as swarmPlans from './swarm/plans.js'

// GET /api/swarm/teams/:teamName/permissions/pending - Leader check pending permissions
app.get(
  '/api/swarm/teams/:teamName/permissions/pending',
  async (req: Request, res: Response) => {
    try {
      const teamName = String(req.params.teamName || '')

      if (!(await swarms.teamExists(teamName))) {
        return res.status(404).json({ error: `Team ${teamName} not found` })
      }

      const requests = await swarmPerms.getPendingPermissionRequests(teamName)

      res.json({
        teamName,
        requests: requests.map((r) => ({
          messageId: r.messageId,
          workerName: r.workerName,
          toolName: r.request.toolName,
          reason: r.request.reason,
          requestId: r.request.requestId,
        })),
        count: requests.length,
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  },
)

// POST /api/swarm/teams/:teamName/permissions/approve - Leader approve permission
app.post(
  '/api/swarm/teams/:teamName/permissions/approve',
  async (req: Request, res: Response) => {
    try {
      const teamName = String(req.params.teamName || '')
      const { workerName, requestId, reason } = req.body

      if (!workerName || !requestId) {
        return res.status(400).json({ error: 'workerName and requestId required' })
      }

      if (!(await swarms.teamExists(teamName))) {
        return res.status(404).json({ error: `Team ${teamName} not found` })
      }

      await swarmPerms.respondToPermissionRequest(
        teamName,
        workerName,
        true,
        requestId,
        reason,
      )

      res.json({
        success: true,
        message: `Permission approved for ${workerName}`,
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  },
)

// POST /api/swarm/teams/:teamName/permissions/deny - Leader deny permission
app.post(
  '/api/swarm/teams/:teamName/permissions/deny',
  async (req: Request, res: Response) => {
    try {
      const teamName = String(req.params.teamName || '')
      const { workerName, requestId, reason } = req.body

      if (!workerName || !requestId) {
        return res.status(400).json({ error: 'workerName and requestId required' })
      }

      if (!(await swarms.teamExists(teamName))) {
        return res.status(404).json({ error: `Team ${teamName} not found` })
      }

      await swarmPerms.respondToPermissionRequest(
        teamName,
        workerName,
        false,
        requestId,
        reason,
      )

      res.json({
        success: true,
        message: `Permission denied for ${workerName}`,
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  },
)

// GET /api/swarm/teams/:teamName/plans/pending - Leader check pending plans
app.get('/api/swarm/teams/:teamName/plans/pending', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    const requests = await swarmPlans.getPendingPlanApprovals(teamName)

    res.json({
      teamName,
      plans: requests.map((r) => ({
        messageId: r.messageId,
        workerName: r.workerName,
        planId: r.request.planId,
        title: r.request.plan.title,
        description: r.request.plan.description,
        stepCount: r.request.plan.steps.length,
      })),
      count: requests.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/swarm/teams/:teamName/plans/approve - Leader approve plan
app.post('/api/swarm/teams/:teamName/plans/approve', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')
    const { workerName, planId, feedback } = req.body

    if (!workerName || !planId) {
      return res.status(400).json({ error: 'workerName and planId required' })
    }

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    await swarmPlans.respondToPlanApproval(teamName, workerName, planId, true, feedback)

    res.json({
      success: true,
      message: `Plan approved for ${workerName}`,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/swarm/teams/:teamName/plans/reject - Leader reject plan
app.post('/api/swarm/teams/:teamName/plans/reject', async (req: Request, res: Response) => {
  try {
    const teamName = String(req.params.teamName || '')
    const { workerName, planId, feedback, requestedChanges } = req.body

    if (!workerName || !planId) {
      return res.status(400).json({ error: 'workerName and planId required' })
    }

    if (!(await swarms.teamExists(teamName))) {
      return res.status(404).json({ error: `Team ${teamName} not found` })
    }

    await swarmPlans.respondToPlanApproval(
      teamName,
      workerName,
      planId,
      false,
      feedback,
      requestedChanges,
    )

    res.json({
      success: true,
      message: `Plan rejected for ${workerName}`,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export { coordinator }

const port = process.env.PORT || 3000

async function startServer() {
  await initDatabase()
  await initPluginStorage()

  const pluginRegistry = initPluginRegistry()
  await hydrateRegistryFromStorage(pluginRegistry)
  initHooks()
  initPluginRuntime(pluginRegistry, PLUGINS_ROOT)

  const autoLoadPlugins = String(process.env.PLUGINS_AUTOLOAD || 'true').toLowerCase() !== 'false'
  if (autoLoadPlugins) {
    const loadReport = await loadPluginsFromDirectory(PLUGINS_ROOT).catch((error) => {
      const message = String(error)
      if (message.includes('ENOENT')) {
        return { loaded: [], failed: [] }
      }
      throw error
    })

    for (const entry of loadReport.loaded) {
      pluginRegistry.register(entry.manifest, { overwrite: true })
      await upsertPluginManifest(entry.manifest)
    }
  }

  await syncPluginRuntimeFromRegistry()
  
  // Initialize Fase 2 infrastructure
  const pipeline = initPermissionPipeline()
  initDefaultRules(pipeline)
  
  app.listen(port, () => console.log(`Chocks listening on ${port}`))
}

startServer().catch((error) => {
  console.error('Failed to start Chocks:', error)
  process.exit(1)
})
