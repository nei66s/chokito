import express, { type Request, type Response } from 'express'
import dotenv from 'dotenv'
import fs from 'fs/promises'
import fssync from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { runAgent, streamAgent } from './llm.js'
import { initDatabase } from './db.js'
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
import { initHooks } from './hooks/index.js'
import { AuditLogger } from './audit/logger.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : path.resolve(process.cwd(), '..')

const app = express()
app.use(express.json())
app.use(express.static(path.resolve(__dirname, '..', 'public')))

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
    const result = await runAgent(messages, {
      chatId,
      userId: user.id,
      displayName: user.displayName,
      fullAccess: getFullAccess(req),
      permissionMode: getPermissionMode(req),
      latestUserMessage,
      approvedTools: getApprovedTools(req),
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
    const hookRegistry = require('./hooks/index.js').getHookRegistry?.() || null
    if (hookRegistry) {
      await hookRegistry.dispatch({
        type: 'PreToolUse',
        timestamp: new Date().toISOString(),
        userId: user.id,
        chatId,
        data: { tool, input },
      })
    }

    const out = await runTool(tool, input, context)
    
    // Log successful execution
    AuditLogger.logToolExecution(tool, input, out, user.id, chatId)

    // Dispatch PostToolUse hook
    if (hookRegistry) {
      await hookRegistry.dispatch({
        type: 'PostToolUse',
        timestamp: new Date().toISOString(),
        userId: user.id,
        chatId,
        data: { tool, input, output: out },
      })
    }

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
  res.json({
    permissionMode: getPermissionMode(req),
    tools: getToolStatuses({ permissionMode: getPermissionMode(req) }),
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

const port = process.env.PORT || 3000

async function startServer() {
  await initDatabase()
  
  // Initialize Fase 2 infrastructure
  const pipeline = initPermissionPipeline()
  initHooks()
  initDefaultRules(pipeline)
  
  app.listen(port, () => console.log(`Chocks listening on ${port}`))
}

startServer().catch((error) => {
  console.error('Failed to start Chocks:', error)
  process.exit(1)
})
