import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import fetch from 'node-fetch'
import fg from 'fast-glob'
import {
  addTodo,
  clearWorkflowState,
  getWorkflowState,
  listTodos,
  saveWorkflowState,
  updateTodo,
} from './store.js'

const execp = promisify(exec)

export type ToolResult = { ok: boolean; output?: any }

export type ToolStatus = {
  name: string
  enabled: boolean
  category: string
  reason?: string
}

export type WorkflowStepStatus = 'pending' | 'in_progress' | 'completed'

export type WorkflowStep = {
  id: string
  text: string
  status: WorkflowStepStatus
}

export type WorkflowState = {
  chatId: string
  goal: string
  summary?: string
  createdAt: string
  updatedAt: string
  steps: WorkflowStep[]
}

export type PermissionMode = 'ask' | 'auto' | 'read_only'

export type ToolContext = {
  chatId?: string
  userId?: string
  displayName?: string
  fullAccess?: boolean
  permissionMode?: PermissionMode
  latestUserMessage?: string
  approvedTools?: string[]
}

const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : path.resolve(process.cwd(), '..')

const ALLOW_BASH_EXEC = String(process.env.ALLOW_BASH_EXEC || '').toLowerCase() === 'true'
const ALLOW_WEB_FETCH = String(process.env.ALLOW_WEB_FETCH || '').toLowerCase() === 'true'
const SAFE_CMD = /^(?:\s*)(?:echo|ls|dir|cat|type|pwd)\b/iu
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 512 * 1024)
const WEB_FETCH_ALLOWLIST = String(process.env.WEB_FETCH_ALLOWLIST || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)

function normalizePermissionMode(value: unknown): PermissionMode {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'auto') return 'auto'
  if (raw === 'read_only' || raw === 'readonly' || raw === 'read-only') return 'read_only'
  return 'ask'
}

function normalizeIntentText(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function hasIntent(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text))
}

function requiresExplicitUserApproval(tool: string) {
  return (
    tool === 'file_write' ||
    tool === 'file.write' ||
    tool === 'file_edit' ||
    tool === 'file_copy' ||
    tool === 'file_delete' ||
    tool === 'file_move' ||
    tool === 'directory_create' ||
    tool === 'bash_exec' ||
    tool === 'bash.exec' ||
    tool === 'web_fetch'
  )
}

function isReadOnlyTool(tool: string) {
  return (
    tool === 'file_read' ||
    tool === 'file.read' ||
    tool === 'glob' ||
    tool === 'grep' ||
    tool === 'todo_list' ||
    tool === 'workflow_get' ||
    tool === 'env_get' ||
    tool === 'pwd' ||
    tool === 'ls_safe'
  )
}

function hasExplicitApproval(tool: string, latestUserMessage: unknown) {
  const text = normalizeIntentText(latestUserMessage)
  if (!text) return false

  if (tool === 'file_delete') {
    return hasIntent(text, [/\b(apague|apagar|exclua|excluir|delete|remova|remover)\b/u])
  }

  if (
    tool === 'file_write' ||
    tool === 'file.write' ||
    tool === 'file_edit' ||
    tool === 'file_copy' ||
    tool === 'file_move' ||
    tool === 'directory_create'
  ) {
    return hasIntent(text, [
      /\b(crie|criar|escreva|escrever|salve|salvar|gere|gerar|adicione|adicionar)\b/u,
      /\b(edite|editar|altere|alterar|mude|mudar|atualize|atualizar|substitua|substituir)\b/u,
      /\b(mova|mover|renomeie|renomear|copie|copiar)\b/u,
      /\b(corrija|corrigir|ajuste|ajustar|implemente|implementar|refatore|refatorar)\b/u,
    ])
  }

  if (tool === 'bash_exec' || tool === 'bash.exec') {
    return hasIntent(text, [
      /\b(rode|rodar|execute|executar|comando|terminal|bash|powershell|cmd)\b/u,
    ])
  }

  if (tool === 'web_fetch') {
    return hasIntent(text, [
      /\b(acesse|acessar|abra|abrir|busque|buscar|pesquise|pesquisar|site|url|link|pagina|pagina)\b/u,
    ])
  }

  return false
}

function assertToolPermission(tool: string, context?: ToolContext) {
  const permissionMode = normalizePermissionMode(context?.permissionMode)
  const approvedTools = Array.isArray(context?.approvedTools)
    ? context.approvedTools.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (approvedTools.includes(tool)) return

  if (permissionMode === 'auto') return

  if (permissionMode === 'read_only') {
    if (!isReadOnlyTool(tool)) {
      throw new Error(`permission blocked: ${tool} disabled in read-only mode`)
    }
    return
  }

  if (requiresExplicitUserApproval(tool) && !hasExplicitApproval(tool, context?.latestUserMessage)) {
    throw new Error(`permission blocked: ${tool} requires explicit user approval in ask mode`)
  }
}

function resolveRequestedPath(targetPath: string, context?: ToolContext) {
  if (path.isAbsolute(targetPath)) {
    return path.resolve(targetPath)
  }

  if (context?.fullAccess) {
    return path.resolve(targetPath)
  }

  return path.resolve(PROJECT_ROOT, targetPath)
}

function isInsideRoot(targetPath: string, context?: ToolContext) {
  const abs = resolveRequestedPath(targetPath, context)
  return abs === PROJECT_ROOT || abs.startsWith(`${PROJECT_ROOT}${path.sep}`)
}

function assertAllowedPath(targetPath: string, context?: ToolContext) {
  const abs = resolveRequestedPath(targetPath, context)
  if (context?.fullAccess) return abs
  if (!(abs === PROJECT_ROOT || abs.startsWith(`${PROJECT_ROOT}${path.sep}`))) {
    throw new Error('path outside project not allowed')
  }
  return abs
}

function toDisplayPath(targetPath: string, context?: ToolContext) {
  const abs = assertAllowedPath(targetPath, context)
  if (context?.fullAccess) return abs
  return path.relative(PROJECT_ROOT, abs) || '.'
}

async function readTextFile(absPath: string) {
  const stat = await fs.stat(absPath)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file too large (${stat.size} bytes)`)
  return fs.readFile(absPath, 'utf8')
}

function normalizeWorkflowStep(step: any, index: number): WorkflowStep {
  const text = String(step?.text || '').trim()
  if (!text) throw new Error(`workflow step ${index + 1} missing text`)

  const rawStatus = String(step?.status || 'pending')
  const status: WorkflowStepStatus =
    rawStatus === 'in_progress' || rawStatus === 'completed' ? rawStatus : 'pending'

  const rawId = String(step?.id || `step_${index + 1}`)
  const id = rawId.trim() || `step_${index + 1}`

  return { id, text, status }
}

function resolveWorkflowChatId(context?: ToolContext) {
  return String(context?.chatId || 'global').trim() || 'global'
}

function resolveUser(context?: ToolContext) {
  return {
    id: String(context?.userId || 'legacy-local').trim() || 'legacy-local',
    displayName: String(context?.displayName || 'Local user').trim() || 'Local user',
  }
}

export const toolDefinitions = [
  {
    type: 'function',
    name: 'file_read',
    description: 'Read a UTF-8 text file from the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the project root, e.g. README.md',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'file_write',
    description: 'Write a UTF-8 text file inside the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the project root, e.g. notes/test.txt',
        },
        content: {
          type: 'string',
          description: 'Text content to write.',
        },
        append: {
          type: 'boolean',
          description: 'Append instead of overwrite.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'file_edit',
    description: 'Find and replace text in a file inside the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from project root.' },
        find: { type: 'string', description: 'Exact text to find.' },
        replace: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences.' },
      },
      required: ['path', 'find', 'replace'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'file_delete',
    description: 'Delete a file inside the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the project root to the file that should be deleted.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'file_move',
    description: 'Move or rename a file or folder inside the allowed filesystem scope.',
    parameters: {
      type: 'object',
      properties: {
        from_path: {
          type: 'string',
          description: 'Current file or folder path.',
        },
        to_path: {
          type: 'string',
          description: 'Destination file or folder path.',
        },
      },
      required: ['from_path', 'to_path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'file_copy',
    description: 'Copy a file or folder inside the allowed filesystem scope.',
    parameters: {
      type: 'object',
      properties: {
        from_path: {
          type: 'string',
          description: 'Source file or folder path.',
        },
        to_path: {
          type: 'string',
          description: 'Destination file or folder path.',
        },
      },
      required: ['from_path', 'to_path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'directory_create',
    description: 'Create a folder inside the allowed filesystem scope.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder path to create.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'glob',
    description: 'Find files by glob pattern inside the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts' },
        limit: { type: 'number', description: 'Max results (default 200).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'grep',
    description: 'Search file contents for a string or regex.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern.' },
        path: { type: 'string', description: 'Relative directory or file (default ".").' },
        regex: { type: 'boolean', description: 'Treat pattern as regex.' },
        limit: { type: 'number', description: 'Max matches (default 200).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'bash_exec',
    description: 'Run a safe shell command and return stdout/stderr.',
    parameters: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Command to run, e.g. "dir" or "type README.md".',
        },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'web_fetch',
    description: 'Fetch a URL (GET). Optional allowlist via WEB_FETCH_ALLOWLIST.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https://example.com' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'todo_list',
    description: 'List local todos stored in .chocks/todos.json.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'todo_add',
    description: 'Add a todo item.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Todo text' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'todo_update',
    description: 'Update a todo item by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Todo id' },
        text: { type: 'string', description: 'Updated text' },
        done: { type: 'boolean', description: 'Mark complete' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_get',
    description: 'Read the active workflow plan for the current task.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_replace',
    description: 'Create or replace the active workflow plan with a goal and short step list.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'User-visible goal for the current task.' },
        summary: { type: 'string', description: 'Optional short note about the plan.' },
        steps: {
          type: 'array',
          description: 'Ordered steps for the task.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable short step id.' },
              text: { type: 'string', description: 'Step description.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current step status.',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      required: ['goal', 'steps'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_update_step',
    description: 'Update the status or text of one workflow step by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Step id to update.' },
        text: { type: 'string', description: 'Optional new step text.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New step status.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_clear',
    description: 'Clear the active workflow plan when the task is complete or abandoned.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'env_get',
    description: 'Read environment variables by key (safe list).',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' } },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'pwd',
    description: 'Return the project root path.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'ls_safe',
    description: 'List directory entries inside project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path (default ".")' },
      },
      additionalProperties: false,
    },
  },
]

export function getToolStatuses(context?: Pick<ToolContext, 'permissionMode'>): ToolStatus[] {
  const permissionMode = normalizePermissionMode(context?.permissionMode)
  const annotate = (tool: string, status: ToolStatus): ToolStatus => {
    if (permissionMode === 'read_only' && !isReadOnlyTool(tool)) {
      return { ...status, enabled: false, reason: 'blocked by read-only permission mode' }
    }
    if (permissionMode === 'ask' && requiresExplicitUserApproval(tool)) {
      return { ...status, reason: 'requires explicit user request in ask mode' }
    }
    return status
  }

  return [
    annotate('file_read', { name: 'file_read', enabled: true, category: 'files' }),
    annotate('file_write', { name: 'file_write', enabled: true, category: 'files' }),
    annotate('file_edit', { name: 'file_edit', enabled: true, category: 'files' }),
    annotate('file_copy', { name: 'file_copy', enabled: true, category: 'files' }),
    annotate('file_delete', { name: 'file_delete', enabled: true, category: 'files' }),
    annotate('file_move', { name: 'file_move', enabled: true, category: 'files' }),
    annotate('directory_create', { name: 'directory_create', enabled: true, category: 'files' }),
    annotate('glob', { name: 'glob', enabled: true, category: 'search' }),
    annotate('grep', { name: 'grep', enabled: true, category: 'search' }),
    annotate('bash_exec', {
      name: 'bash_exec',
      enabled: ALLOW_BASH_EXEC,
      category: 'execution',
      reason: ALLOW_BASH_EXEC ? 'enabled by ALLOW_BASH_EXEC=true' : 'disabled by ALLOW_BASH_EXEC=false',
    }),
    annotate('web_fetch', {
      name: 'web_fetch',
      enabled: ALLOW_WEB_FETCH,
      category: 'web',
      reason: ALLOW_WEB_FETCH
        ? WEB_FETCH_ALLOWLIST.length > 0
          ? `allowlist: ${WEB_FETCH_ALLOWLIST.join(', ')}`
          : 'enabled without allowlist'
        : 'disabled by ALLOW_WEB_FETCH=false',
    }),
    annotate('todo_list', { name: 'todo_list', enabled: true, category: 'planning' }),
    annotate('todo_add', { name: 'todo_add', enabled: true, category: 'planning' }),
    annotate('todo_update', { name: 'todo_update', enabled: true, category: 'planning' }),
    annotate('workflow_get', { name: 'workflow_get', enabled: true, category: 'workflow' }),
    annotate('workflow_replace', { name: 'workflow_replace', enabled: true, category: 'workflow' }),
    annotate('workflow_update_step', { name: 'workflow_update_step', enabled: true, category: 'workflow' }),
    annotate('workflow_clear', { name: 'workflow_clear', enabled: true, category: 'workflow' }),
    annotate('env_get', { name: 'env_get', enabled: true, category: 'system' }),
    annotate('pwd', { name: 'pwd', enabled: true, category: 'system' }),
    annotate('ls_safe', { name: 'ls_safe', enabled: true, category: 'system' }),
  ]
}

export async function runTool(tool: string, input: any, context?: ToolContext): Promise<ToolResult> {
  assertToolPermission(tool, context)

  if (tool === 'file_read' || tool === 'file.read') {
    const rel = input?.path
    if (!rel) throw new Error('input.path required')
    const abs = assertAllowedPath(rel, context)
    const data = await readTextFile(abs)
    return { ok: true, output: data }
  }

  if (tool === 'file_write' || tool === 'file.write') {
    const rel = input?.path
    const content = input?.content
    if (!rel) throw new Error('input.path required')
    if (typeof content !== 'string') throw new Error('input.content must be a string')
    const abs = assertAllowedPath(rel, context)
    const normalizedPath = toDisplayPath(rel, context)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    if (input?.append) {
      await fs.appendFile(abs, content, 'utf8')
    } else {
      await fs.writeFile(abs, content, 'utf8')
    }
    return { ok: true, output: { path: normalizedPath, bytes: content.length, append: !!input?.append } }
  }

  if (tool === 'file_edit') {
    const rel = input?.path
    const find = input?.find
    const replace = input?.replace
    if (!rel) throw new Error('input.path required')
    if (typeof find !== 'string' || typeof replace !== 'string') throw new Error('find/replace must be strings')
    const abs = assertAllowedPath(rel, context)
    const original = await readTextFile(abs)
    const replaced = input?.replace_all ? original.split(find).join(replace) : original.replace(find, replace)
    if (replaced === original) return { ok: false, output: { changed: false } }
    await fs.writeFile(abs, replaced, 'utf8')
    return { ok: true, output: { changed: true, path: toDisplayPath(rel, context) } }
  }

  if (tool === 'file_delete') {
    const rel = input?.path
    if (!rel) throw new Error('input.path required')
    const abs = assertAllowedPath(rel, context)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw new Error('only files can be deleted with file_delete')
    await fs.unlink(abs)
    return { ok: true, output: { deleted: true, path: toDisplayPath(rel, context) } }
  }

  if (tool === 'file_move') {
    const fromPath = input?.from_path
    const toPath = input?.to_path
    if (!fromPath) throw new Error('input.from_path required')
    if (!toPath) throw new Error('input.to_path required')
    const fromAbs = assertAllowedPath(fromPath, context)
    const toAbs = assertAllowedPath(toPath, context)
    await fs.stat(fromAbs)
    await fs.mkdir(path.dirname(toAbs), { recursive: true })
    await fs.rename(fromAbs, toAbs)
    return {
      ok: true,
      output: {
        moved: true,
        from_path: toDisplayPath(fromPath, context),
        to_path: toDisplayPath(toPath, context),
      },
    }
  }

  if (tool === 'file_copy') {
    const fromPath = input?.from_path
    const toPath = input?.to_path
    if (!fromPath) throw new Error('input.from_path required')
    if (!toPath) throw new Error('input.to_path required')
    const fromAbs = assertAllowedPath(fromPath, context)
    const toAbs = assertAllowedPath(toPath, context)
    const stat = await fs.stat(fromAbs)
    await fs.mkdir(path.dirname(toAbs), { recursive: true })
    if (stat.isDirectory()) {
      await fs.cp(fromAbs, toAbs, { recursive: true })
    } else {
      await fs.copyFile(fromAbs, toAbs)
    }
    return {
      ok: true,
      output: {
        copied: true,
        from_path: toDisplayPath(fromPath, context),
        to_path: toDisplayPath(toPath, context),
      },
    }
  }

  if (tool === 'directory_create') {
    const rel = input?.path
    if (!rel) throw new Error('input.path required')
    const abs = assertAllowedPath(rel, context)
    await fs.mkdir(abs, { recursive: true })
    return { ok: true, output: { created: true, path: toDisplayPath(rel, context) } }
  }

  if (tool === 'glob') {
    const pattern = input?.pattern
    const limit = Number(input?.limit || 200)
    if (!pattern) throw new Error('input.pattern required')
    const matches = await fg(pattern, {
      cwd: PROJECT_ROOT,
      dot: true,
      onlyFiles: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })
    return { ok: true, output: matches.slice(0, limit) }
  }

  if (tool === 'grep') {
    const pattern = input?.pattern
    const rel = input?.path || '.'
    const limit = Number(input?.limit || 200)
    if (!pattern) throw new Error('input.pattern required')
    if (!isInsideRoot(rel, context) && !context?.fullAccess) throw new Error('path outside project not allowed')
    const abs = assertAllowedPath(rel, context)
    const stats = await fs.stat(abs)
    const files = stats.isDirectory()
      ? await fg('**/*', {
          cwd: abs,
          dot: true,
          onlyFiles: true,
          unique: true,
          followSymbolicLinks: false,
          ignore: ['**/node_modules/**', '**/.git/**'],
        })
      : [path.basename(abs)]
    const baseDir = stats.isDirectory() ? abs : path.dirname(abs)
    const re = input?.regex ? new RegExp(pattern, 'u') : null
    const results: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      if (results.length >= limit) break
      const filePath = path.resolve(baseDir, file)
      try {
        const text = await readTextFile(filePath)
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i += 1) {
          const lineText = lines[i]
          const hit = re ? re.test(lineText) : lineText.includes(pattern)
          if (hit) {
            const displayFile = context?.fullAccess ? filePath : path.relative(PROJECT_ROOT, filePath)
            results.push({ file: displayFile, line: i + 1, text: lineText })
            if (results.length >= limit) break
          }
        }
      } catch {
        // ignore unreadable files
      }
    }
    return { ok: true, output: results }
  }

  if (tool === 'bash_exec' || tool === 'bash.exec') {
    if (!ALLOW_BASH_EXEC) throw new Error('bash.exec disabled (set ALLOW_BASH_EXEC=true to enable)')
    const cmd = input?.cmd
    if (!cmd) throw new Error('input.cmd required')
    if (!SAFE_CMD.test(String(cmd))) throw new Error('command not allowed')
    const { stdout, stderr } = await execp(cmd, { cwd: PROJECT_ROOT })
    return { ok: true, output: { stdout, stderr } }
  }

  if (tool === 'web_fetch') {
    if (!ALLOW_WEB_FETCH) throw new Error('web_fetch disabled (set ALLOW_WEB_FETCH=true to enable)')
    const url = String(input?.url || '')
    if (!url) throw new Error('input.url required')
    const parsed = new URL(url)
    if (WEB_FETCH_ALLOWLIST.length > 0) {
      const allowed = WEB_FETCH_ALLOWLIST.some(host => parsed.hostname.endsWith(host))
      if (!allowed) throw new Error('url not in allowlist')
    }
    const resp = await fetch(url, { method: 'GET' })
    const text = await resp.text()
    return { ok: true, output: { status: resp.status, body: text.slice(0, 20000) } }
  }

  if (tool === 'todo_list') {
    const data = await listTodos(resolveUser(context).id)
    return { ok: true, output: data }
  }

  if (tool === 'todo_add') {
    const text = input?.text
    if (!text) throw new Error('input.text required')
    const item = await addTodo(String(text), resolveUser(context))
    return { ok: true, output: item }
  }

  if (tool === 'todo_update') {
    const id = Number(input?.id)
    if (!id) throw new Error('input.id required')
    const item = await updateTodo(id, {
      text: typeof input?.text === 'string' ? input.text : undefined,
      done: typeof input?.done === 'boolean' ? input.done : undefined,
    }, resolveUser(context).id)
    return { ok: true, output: item }
  }

  if (tool === 'workflow_get') {
    const active = await getWorkflowState(resolveWorkflowChatId(context), resolveUser(context).id)
    return { ok: true, output: active }
  }

  if (tool === 'workflow_replace') {
    const goal = String(input?.goal || '').trim()
    const stepsInput = input?.steps
    if (!goal) throw new Error('input.goal required')
    if (!Array.isArray(stepsInput) || stepsInput.length === 0) throw new Error('input.steps must be a non-empty array')

    const chatId = resolveWorkflowChatId(context)
    const now = new Date().toISOString()
    const nextState: WorkflowState = {
      chatId,
      goal,
      summary: typeof input?.summary === 'string' && input.summary.trim() ? input.summary.trim() : undefined,
      createdAt: now,
      updatedAt: now,
      steps: stepsInput.map(normalizeWorkflowStep),
    }

    const saved = await saveWorkflowState(nextState, resolveUser(context))
    return { ok: true, output: saved }
  }

  if (tool === 'workflow_update_step') {
    const id = String(input?.id || '').trim()
    if (!id) throw new Error('input.id required')

    const chatId = resolveWorkflowChatId(context)
    const active = await getWorkflowState(chatId, resolveUser(context).id)
    if (!active) throw new Error('no active workflow')

    const step = active.steps.find(item => item.id === id)
    if (!step) throw new Error('workflow step not found')

    if (typeof input?.text === 'string' && input.text.trim()) {
      step.text = input.text.trim()
    }
    if (typeof input?.status === 'string') {
      const nextStatus = String(input.status)
      if (nextStatus !== 'pending' && nextStatus !== 'in_progress' && nextStatus !== 'completed') {
        throw new Error('invalid workflow status')
      }
      step.status = nextStatus
    }

    active.updatedAt = new Date().toISOString()
    const saved = await saveWorkflowState(active, resolveUser(context))
    return { ok: true, output: saved }
  }

  if (tool === 'workflow_clear') {
    const chatId = resolveWorkflowChatId(context)
    const cleared = await clearWorkflowState(chatId, resolveUser(context).id)
    return { ok: true, output: cleared }
  }

  if (tool === 'env_get') {
    const keys = input?.keys
    if (!Array.isArray(keys)) throw new Error('input.keys must be array')
    const out: Record<string, string | null> = {}
    for (const key of keys) {
      out[String(key)] = process.env[String(key)] ?? null
    }
    return { ok: true, output: out }
  }

  if (tool === 'pwd') {
    return { ok: true, output: PROJECT_ROOT }
  }

  if (tool === 'ls_safe') {
    const rel = input?.path || '.'
    const abs = assertAllowedPath(rel, context)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    return {
      ok: true,
      output: {
        path: toDisplayPath(rel, context),
        entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
      },
    }
  }

  throw new Error(`unknown tool: ${tool}`)
}
