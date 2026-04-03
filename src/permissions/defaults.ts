/**
 * Default Permission Rules - Baseline security policies.
 */

import type { DenyRule, AskRule } from './pipeline.js'

export const DEFAULT_DENY_RULES: DenyRule[] = [
  {
    id: 'deny_system_paths',
    tool: ['file_read', 'file_write', 'file_delete', 'file_move'],
    condition: (ctx) => {
      // Block access to system-critical paths
      // (Path validation should happen in tools layer too, defense in depth)
      return false // Disabled; tools layer handles this
    },
    reason: 'System paths blocked by policy',
  },
]

export const DEFAULT_ASK_RULES: AskRule[] = [
  {
    id: 'ask_file_delete',
    tool: 'file_delete',
    condition: () => true, // Always ask
    message: 'Confirm file deletion',
  },
  {
    id: 'ask_bash_exec',
    tool: 'bash_exec',
    condition: () => true, // Always ask
    message: 'Confirm bash command execution',
  },
  {
    id: 'ask_web_fetch',
    tool: 'web_fetch',
    condition: (ctx) => {
      // Ask only if not in approved allowlist
      return !(ctx.approvedTools || []).includes('web_fetch')
    },
    message: 'Confirm external web request',
  },
  {
    id: 'ask_file_write_outside_project',
    tool: ['file_write', 'file_edit'],
    condition: (ctx) => {
      // Flag operations that might escape project root
      const input = ctx.latestUserMessage || ''
      return input.includes('../') || input.includes('..\\')
    },
    message: 'Path contains relative escape (..); confirm operation',
  },
]

/**
 * Initialize default rules into pipeline.
 */
export function initDefaultRules(pipeline: any): void {
  DEFAULT_DENY_RULES.forEach(rule => pipeline.addDenyRule(rule))
  DEFAULT_ASK_RULES.forEach(rule => pipeline.addAskRule(rule))
}
