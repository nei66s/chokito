/**
 * Hook System for Agent Swarms
 * Arquivo: src/swarm/hooks.ts
 *
 * Lifecycle hooks: pre (validation), post (side effects), error (recovery)
 * Allows plugins and external systems to extend swarm behavior
 */

import { TeamConfig, MailboxMessage, TeamMember } from './constants.js'

/**
 * Hook execution phases
 */
export type HookPhase = 'pre' | 'post' | 'error'

/**
 * Hook context types
 */
export interface HookContext {
  timestamp: number
  metadata?: Record<string, any>
}

/**
 * Team lifecycle hooks
 */
export interface TeamHooks {
  onCreate?: Array<(config: TeamConfig, context: HookContext) => Promise<void | boolean>>
  onDelete?: Array<(teamName: string, context: HookContext) => Promise<void | boolean>>
  onMemberAdd?: Array<(teamName: string, member: TeamMember, context: HookContext) => Promise<void | boolean>>
  onMemberRemove?: Array<(teamName: string, agentId: string, context: HookContext) => Promise<void | boolean>>
}

/**
 * Message lifecycle hooks
 */
export interface MessageHooks {
  onSend?: Array<(teamName: string, message: MailboxMessage, context: HookContext) => Promise<void | boolean>>
  onReceive?: Array<(teamName: string, message: MailboxMessage, context: HookContext) => Promise<void | boolean>>
  onRead?: Array<(teamName: string, messageId: string, context: HookContext) => Promise<void | boolean>>
}

/**
 * Permission lifecycle hooks
 */
export interface PermissionHooks {
  onRequested?: Array<(teamName: string, requestId: string, context: HookContext) => Promise<void | boolean>>
  onApproved?: Array<(teamName: string, requestId: string, context: HookContext) => Promise<void | boolean>>
  onDenied?: Array<(teamName: string, requestId: string, context: HookContext) => Promise<void | boolean>>
}

/**
 * Plan lifecycle hooks
 */
export interface PlanHooks {
  onSubmitted?: Array<(teamName: string, planId: string, context: HookContext) => Promise<void | boolean>>
  onApproved?: Array<(teamName: string, planId: string, context: HookContext) => Promise<void | boolean>>
  onRejected?: Array<(teamName: string, planId: string, context: HookContext) => Promise<void | boolean>>
}

/**
 * All hooks registry
 */
export interface AllHooks {
  team: TeamHooks
  message: MessageHooks
  permission: PermissionHooks
  plan: PlanHooks
}

/**
 * Global hooks registry
 */
let globalHooks: AllHooks = {
  team: {},
  message: {},
  permission: {},
  plan: {},
}

/**
 * Register a hook handler
 */
export function registerHook<K extends keyof AllHooks, H extends keyof AllHooks[K]>(
  category: K,
  hookName: H,
  handler: any,
): void {
  const categoryHooks = globalHooks[category]
  if (!categoryHooks[hookName]) {
    ;(categoryHooks[hookName] as any) = []
  }
  ;(categoryHooks[hookName] as any[]).push(handler)
}

/**
 * Unregister a hook handler
 */
export function unregisterHook<K extends keyof AllHooks, H extends keyof AllHooks[K]>(
  category: K,
  hookName: H,
  handler: any,
): void {
  const categoryHooks = globalHooks[category]
  if (categoryHooks[hookName]) {
    const handlers = categoryHooks[hookName] as any[]
    const index = handlers.indexOf(handler)
    if (index !== -1) {
      handlers.splice(index, 1)
    }
  }
}

/**
 * Execute pre-hooks for validation/transformation
 * Returns false if any hook rejects the operation
 */
export async function executePreHooks<K extends keyof AllHooks, H extends keyof AllHooks[K]>(
  category: K,
  hookName: H,
  data: any,
  context: HookContext,
): Promise<boolean> {
  const categoryHooks = globalHooks[category]
  const handlers = categoryHooks[hookName] as any[] | undefined

  if (!handlers || handlers.length === 0) {
    return true
  }

  for (const handler of handlers) {
    try {
      const result = await handler(data, context)
      // If handler returns false explicitly, reject
      if (result === false) {
        return false
      }
    } catch (error) {
      console.error(`Error in pre-hook ${String(hookName)}:`, error)
      return false
    }
  }

  return true
}

/**
 * Execute post-hooks for side effects
 * Non-blocking - errors are logged but don't fail the operation
 */
export async function executePostHooks<K extends keyof AllHooks, H extends keyof AllHooks[K]>(
  category: K,
  hookName: H,
  data: any,
  context: HookContext,
): Promise<void> {
  const categoryHooks = globalHooks[category]
  const handlers = categoryHooks[hookName] as any[] | undefined

  if (!handlers || handlers.length === 0) {
    return
  }

  for (const handler of handlers) {
    try {
      await handler(data, context)
    } catch (error) {
      console.warn(`Warning: Error in post-hook ${String(hookName)}:`, error)
      // Don't throw - post-hooks are non-blocking
    }
  }
}

/**
 * Execute error hooks for recovery/retry
 * Returns true if error was handled and operation should continue
 */
export async function executeErrorHooks<K extends keyof AllHooks, H extends keyof AllHooks[K]>(
  category: K,
  hookName: H,
  error: Error,
  context: HookContext,
): Promise<boolean> {
  const categoryHooks = globalHooks[category]
  const handlers = categoryHooks[hookName] as any[] | undefined

  if (!handlers || handlers.length === 0) {
    return false
  }

  for (const handler of handlers) {
    try {
      const handled = await handler(error, context)
      if (handled === true) {
        return true // Error was handled, can continue
      }
    } catch (handlerError) {
      console.error(`Error in error-hook ${String(hookName)}:`, handlerError)
    }
  }

  return false
}

/**
 * Clear all hooks (for testing)
 */
export function clearAllHooks(): void {
  globalHooks = {
    team: {},
    message: {},
    permission: {},
    plan: {},
  }
}

/**
 * Get current hooks registry (for introspection)
 */
export function getHooks(): AllHooks {
  return JSON.parse(JSON.stringify(globalHooks))
}

/**
 * Hook usage example:
 *
 * // Register a validation hook
 * registerHook('team', 'onCreate', async (config, context) => {
 *   if (!config.name.startsWith('team-')) {
 *     return false // Reject
 *   }
 *   return true // Allow
 * })
 *
 * // Register a notification hook
 * registerHook('message', 'onSend', async (message, context) => {
 *   console.log(`Message sent: ${message.id}`)
 *   // Send notification to external system
 * })
 *
 * // Register an error recovery hook
 * registerHook('team', 'onDelete', async (error, context) => {
 *   if (error.message.includes('Database')) {
 *     // Try to recover from database error
 *     return true
 *   }
 *   return false
 * })
 */
