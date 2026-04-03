import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { getHookRegistry } from '../hooks/index.js'
import type { HookEventType, HookPayload } from '../hooks/events.js'
import type { ToolContext, ToolResult } from '../tools.js'
import type { PluginCapability, PluginManifest } from './manifest.js'
import type { PluginRegistry } from './registry.js'

export type PluginToolDefinition = {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

type PluginToolRunner = (input: unknown, context?: ToolContext) => Promise<ToolResult> | ToolResult

type PluginHookModule = {
  event: HookEventType
  handler: (payload: HookPayload) => Promise<void> | void
  priority?: number
}

type PluginToolModule = {
  definition?: Partial<PluginToolDefinition>
  run: PluginToolRunner
}

type CapabilityRuntimeStatus = {
  capability: string
  type: PluginCapability['type']
  status: 'active' | 'failed'
  message?: string
}

type RuntimePluginRecord = {
  pluginId: string
  hookRegistrationIds: string[]
  capabilityStatus: CapabilityRuntimeStatus[]
  activatedAt: string
}

type RuntimeToolRecord = {
  pluginId: string
  capability: PluginCapability
  definition: PluginToolDefinition
  run: PluginToolRunner
}

export type PluginRuntimeStatus = {
  pluginId: string
  active: boolean
  activatedAt?: string
  hookCount: number
  toolCount: number
  capabilityStatus: CapabilityRuntimeStatus[]
}

const KNOWN_HOOK_EVENTS: HookEventType[] = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'ToolError',
  'PermissionDenied',
  'PermissionAsked',
  'PermissionApproved',
  'PermissionRevoked',
  'MessageReceived',
  'MessageProcessed',
  'MessageSent',
  'FileRead',
  'FileWrite',
  'FileDelete',
  'FileMove',
  'WorkflowCreated',
  'WorkflowUpdated',
  'WorkflowCompleted',
  'SecurityAlert',
]

function nowIso() {
  return new Date().toISOString()
}

function toModuleUrl(filePath: string) {
  return `${pathToFileURL(filePath).href}?v=${Date.now()}`
}

function ensureInside(rootDir: string, targetPath: string) {
  const normalizedRoot = path.resolve(rootDir)
  const normalizedTarget = path.resolve(targetPath)
  if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    return normalizedTarget
  }
  throw new Error(`entry path outside plugins root: ${targetPath}`)
}

function defaultToolDefinition(capabilityName: string): PluginToolDefinition {
  return {
    type: 'function',
    name: capabilityName,
    description: `Plugin tool: ${capabilityName}`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  }
}

function normalizeToolDefinition(capabilityName: string, partial?: Partial<PluginToolDefinition>): PluginToolDefinition {
  if (!partial) return defaultToolDefinition(capabilityName)

  return {
    type: 'function',
    name: String(partial.name || capabilityName).trim() || capabilityName,
    description: String(partial.description || `Plugin tool: ${capabilityName}`).trim(),
    parameters: {
      type: 'object',
      properties: (partial.parameters?.properties as Record<string, unknown>) || {},
      ...(Array.isArray(partial.parameters?.required) ? { required: partial.parameters?.required } : {}),
      additionalProperties:
        typeof partial.parameters?.additionalProperties === 'boolean'
          ? partial.parameters.additionalProperties
          : true,
    },
  }
}

function isHookEvent(value: string): value is HookEventType {
  return KNOWN_HOOK_EVENTS.includes(value as HookEventType)
}

async function resolveCapabilityEntryPath(
  pluginsRoot: string,
  manifest: PluginManifest,
  capability: PluginCapability,
) {
  const sourcePath = manifest.source ? path.resolve(manifest.source) : undefined
  const baseDir = sourcePath ? path.dirname(sourcePath) : pluginsRoot
  const entryCandidate = path.isAbsolute(capability.entry)
    ? capability.entry
    : path.resolve(baseDir, capability.entry)
  const insideRoot = ensureInside(pluginsRoot, entryCandidate)
  await fs.stat(insideRoot)
  return insideRoot
}

function resolveDependencyGraph(manifests: PluginManifest[]) {
  const enabled = manifests.filter((item) => item.enabled)
  const map = new Map(enabled.map((manifest) => [manifest.id, manifest]))

  const missing: Array<{ pluginId: string; dependency: string }> = []
  for (const manifest of enabled) {
    for (const dep of manifest.dependencies) {
      if (!map.has(dep)) {
        missing.push({ pluginId: manifest.id, dependency: dep })
      }
    }
  }

  if (missing.length > 0) {
    const text = missing.map((item) => `${item.pluginId}->${item.dependency}`).join(', ')
    throw new Error(`plugin dependency missing: ${text}`)
  }

  const order: PluginManifest[] = []
  const state = new Map<string, 'visiting' | 'visited'>()

  const visit = (pluginId: string, stack: string[]) => {
    const currentState = state.get(pluginId)
    if (currentState === 'visited') return
    if (currentState === 'visiting') {
      throw new Error(`plugin dependency cycle: ${[...stack, pluginId].join(' -> ')}`)
    }

    const manifest = map.get(pluginId)
    if (!manifest) return

    state.set(pluginId, 'visiting')
    for (const dependency of manifest.dependencies) {
      visit(dependency, [...stack, pluginId])
    }
    state.set(pluginId, 'visited')
    order.push(manifest)
  }

  for (const manifest of enabled) {
    visit(manifest.id, [])
  }

  return order
}

class PluginRuntime {
  private runtimeRecords = new Map<string, RuntimePluginRecord>()
  private tools = new Map<string, RuntimeToolRecord>()
  private registry: PluginRegistry
  private pluginsRoot: string

  constructor(registry: PluginRegistry, pluginsRoot: string) {
    this.registry = registry
    this.pluginsRoot = path.resolve(pluginsRoot)
  }

  async deactivatePlugin(pluginId: string) {
    const record = this.runtimeRecords.get(pluginId)
    if (!record) return

    const hookRegistry = getHookRegistry()
    for (const hookId of record.hookRegistrationIds) {
      hookRegistry.unregister(hookId)
    }

    for (const [toolName, toolRecord] of this.tools.entries()) {
      if (toolRecord.pluginId === pluginId) {
        this.tools.delete(toolName)
      }
    }

    this.runtimeRecords.delete(pluginId)
  }

  async activatePlugin(manifest: PluginManifest) {
    await this.deactivatePlugin(manifest.id)

    const capabilityStatus: CapabilityRuntimeStatus[] = []
    const hookRegistrationIds: string[] = []
    const hookRegistry = getHookRegistry()

    for (const capability of manifest.capabilities) {
      try {
        if (capability.type === 'tool') {
          const entryPath = await resolveCapabilityEntryPath(this.pluginsRoot, manifest, capability)
          const mod = (await import(toModuleUrl(entryPath))) as Partial<PluginToolModule> & {
            default?: unknown
            run?: PluginToolRunner
          }

          const resolvedModule = (typeof mod.default === 'object' && mod.default ? mod.default : mod) as Partial<PluginToolModule>
          const runCandidate =
            (typeof resolvedModule.run === 'function' ? resolvedModule.run : undefined) ||
            (typeof mod.run === 'function' ? mod.run : undefined) ||
            (typeof mod.default === 'function' ? (mod.default as PluginToolRunner) : undefined)

          if (!runCandidate) {
            throw new Error('tool module must export run(input, context)')
          }

          const definition = normalizeToolDefinition(capability.name, resolvedModule.definition)
          this.tools.set(definition.name, {
            pluginId: manifest.id,
            capability,
            definition,
            run: runCandidate,
          })

          capabilityStatus.push({
            capability: capability.name,
            type: capability.type,
            status: 'active',
          })
          continue
        }

        if (capability.type === 'hook') {
          const entryPath = await resolveCapabilityEntryPath(this.pluginsRoot, manifest, capability)
          const mod = (await import(toModuleUrl(entryPath))) as {
            default?: unknown
            hook?: unknown
            event?: unknown
            handler?: unknown
            priority?: unknown
          }

          const fallback = {
            event: mod.event,
            handler: mod.handler,
            priority: mod.priority,
          }

          const hookDefUnknown = mod.hook ?? mod.default ?? fallback
          const hookDef = hookDefUnknown as Partial<PluginHookModule>
          const eventText = String(hookDef.event || '').trim()
          if (!eventText || !isHookEvent(eventText)) {
            throw new Error('hook module must export a valid event')
          }

          if (typeof hookDef.handler !== 'function') {
            throw new Error('hook module must export handler(payload)')
          }

          const hookId = hookRegistry.register(eventText, hookDef.handler, Number(hookDef.priority || 50))
          hookRegistrationIds.push(hookId)
          capabilityStatus.push({
            capability: capability.name,
            type: capability.type,
            status: 'active',
          })
          continue
        }

        // Skills and agents are metadata-level capabilities for now.
        await resolveCapabilityEntryPath(this.pluginsRoot, manifest, capability)
        capabilityStatus.push({
          capability: capability.name,
          type: capability.type,
          status: 'active',
        })
      } catch (error) {
        capabilityStatus.push({
          capability: capability.name,
          type: capability.type,
          status: 'failed',
          message: String(error),
        })
      }
    }

    this.runtimeRecords.set(manifest.id, {
      pluginId: manifest.id,
      hookRegistrationIds,
      capabilityStatus,
      activatedAt: nowIso(),
    })
  }

  async syncWithRegistry() {
    const manifests = this.registry.list()
    const enabledIds = new Set(manifests.filter((item) => item.enabled).map((item) => item.id))

    for (const pluginId of this.runtimeRecords.keys()) {
      if (!enabledIds.has(pluginId)) {
        await this.deactivatePlugin(pluginId)
      }
    }

    const ordered = resolveDependencyGraph(manifests)
    for (const manifest of ordered) {
      await this.activatePlugin(manifest)
    }
  }

  listToolDefinitions() {
    return [...this.tools.values()]
      .map((item) => item.definition)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  hasTool(toolName: string) {
    return this.tools.has(String(toolName || '').trim())
  }

  async runTool(toolName: string, input: unknown, context?: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(String(toolName || '').trim())
    if (!tool) {
      throw new Error(`plugin tool not found: ${toolName}`)
    }

    const result = await Promise.resolve(tool.run(input, context))
    if (!result || typeof result !== 'object' || typeof (result as ToolResult).ok !== 'boolean') {
      return { ok: true, output: result }
    }
    return result as ToolResult
  }

  getRuntimeStatus(): PluginRuntimeStatus[] {
    const manifests = this.registry.list()

    return manifests.map((manifest) => {
      const runtime = this.runtimeRecords.get(manifest.id)
      const toolCount = [...this.tools.values()].filter((tool) => tool.pluginId === manifest.id).length
      return {
        pluginId: manifest.id,
        active: !!runtime,
        ...(runtime?.activatedAt ? { activatedAt: runtime.activatedAt } : {}),
        hookCount: runtime?.hookRegistrationIds.length || 0,
        toolCount,
        capabilityStatus: runtime?.capabilityStatus || [],
      }
    })
  }
}

let runtimeSingleton: PluginRuntime | null = null

export function initPluginRuntime(registry: PluginRegistry, pluginsRoot: string) {
  if (!runtimeSingleton) {
    runtimeSingleton = new PluginRuntime(registry, pluginsRoot)
  }
  return runtimeSingleton
}

export function getPluginRuntime() {
  if (!runtimeSingleton) {
    throw new Error('plugin runtime not initialized')
  }
  return runtimeSingleton
}
