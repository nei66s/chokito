/**
 * Permission Pipeline — 7-step gauntlet for tool execution.
 * 
 * Steps:
 * 1. Deny rules (block immediately)
 * 2. Ask rules (require prior approval)
 * 3. Tool.checkPermissions (built-in tool validation)
 * 4. Content-specific checks (file path, command, URL)
 * 5. Requires interaction (certain operations need user gesture)
 * 6. Safety checks (moderation, rate limits)
 * 7. Post-pipeline transforms (log, notify)
 */

import type { ToolContext } from '../tools.js'

export interface PermissionContext extends ToolContext {
  approvedRules?: string[]
}

export interface PermissionCheckResult {
  allowed: boolean
  reason?: string
  step?: number // Which step rejected
}

export interface DenyRule {
  id: string
  tool: string | string[] // '*' = all
  condition: (context: PermissionContext) => boolean
  reason: string
}

export interface AskRule {
  id: string
  tool: string | string[]
  condition: (context: PermissionContext) => boolean
  message: string
}

class PermissionPipeline {
  private denyRules: DenyRule[] = []
  private askRules: AskRule[] = []

  // Step 1: Deny rules (fail-closed)
  async step1_DenyRules(tool: string, context: PermissionContext): Promise<PermissionCheckResult> {
    for (const rule of this.denyRules) {
      if (this.toolMatches(rule.tool, tool) && rule.condition(context)) {
        return {
          allowed: false,
          reason: rule.reason,
          step: 1,
        }
      }
    }
    return { allowed: true }
  }

  // Step 2: Ask rules (requires prior approval in session)
  async step2_AskRules(tool: string, context: PermissionContext): Promise<PermissionCheckResult> {
    for (const rule of this.askRules) {
      if (this.toolMatches(rule.tool, tool) && rule.condition(context)) {
        const isApproved = context.approvedRules?.includes(rule.id)
        if (!isApproved) {
          return {
            allowed: false,
            reason: `Approval required: ${rule.message}`,
            step: 2,
          }
        }
      }
    }
    return { allowed: true }
  }

  // Step 3: Tool-specific checks
  async step3_ToolCheckPermissions(tool: string, context: PermissionContext): Promise<PermissionCheckResult> {
    // This delegates to the tool's own checkPermissions method
    // For now, always pass (tools handle their own validation)
    return { allowed: true }
  }

  // Step 4: Content-specific checks
  async step4_ContentSpecific(tool: string, input: any, context: PermissionContext): Promise<PermissionCheckResult> {
    // Example: block file operations outside project root
    if (tool === 'file_read' || tool === 'file_write') {
      const path = input?.path || input?.from_path
      if (path && typeof path === 'string') {
        if (path.includes('..') || path.startsWith('/etc') || path.startsWith('C:\\Windows')) {
          return {
            allowed: false,
            reason: 'Path outside allowed scope',
            step: 4,
          }
        }
      }
    }

    // Block certain bash commands globally
    if (tool === 'bash_exec') {
      const cmd = input?.command || ''
      if (typeof cmd === 'string' && /\b(rm\s+-rf|dd\s+if=|:()\s*{|fork\(\)|ping|curl|wget)\b/i.test(cmd)) {
        // Blacklist some dangerous patterns
        if (context.permissionMode === 'read_only') {
          return {
            allowed: false,
            reason: 'Command blocked in read-only mode',
            step: 4,
          }
        }
      }
    }

    return { allowed: true }
  }

  // Step 5: Requires interaction
  async step5_RequiresInteraction(tool: string, context: PermissionContext): Promise<PermissionCheckResult> {
    // Certain tools absolutely require user interaction (no auto-execute)
    const requiresInteraction = ['file_delete', 'bash_exec', 'web_fetch']

    if (requiresInteraction.includes(tool) && context.permissionMode === 'ask') {
      // In ask mode, always require explicit approval
      // This is enforced by the tool layer, just signal here
    }

    return { allowed: true }
  }

  // Step 6: Safety checks (moderation, rate limits)
  async step6_SafetyChecks(tool: string, input: any, context: PermissionContext): Promise<PermissionCheckResult> {
    // TODO: Add moderation, rate limiting, token budgets
    // For now, placeholder
    return { allowed: true }
  }

  // Step 7: Post-pipeline transforms
  async step7_PostPipeline(
    tool: string,
    allowed: boolean,
    context: PermissionContext,
    step?: number
  ): Promise<void> {
    // Dispatch hook event for audit/logging
    if (!allowed) {
      // Will be dispatched by caller to HookRegistry
    }
  }

  /**
   * Run full 7-step pipeline
   */
  async check(tool: string, input: any, context: PermissionContext): Promise<PermissionCheckResult> {
    let result = await this.step1_DenyRules(tool, context)
    if (!result.allowed) return result

    result = await this.step2_AskRules(tool, context)
    if (!result.allowed) return result

    result = await this.step3_ToolCheckPermissions(tool, context)
    if (!result.allowed) return result

    result = await this.step4_ContentSpecific(tool, input, context)
    if (!result.allowed) return result

    result = await this.step5_RequiresInteraction(tool, context)
    if (!result.allowed) return result

    result = await this.step6_SafetyChecks(tool, input, context)
    if (!result.allowed) return result

    return { allowed: true }
  }

  /**
   * Add a deny rule
   */
  addDenyRule(rule: DenyRule): void {
    this.denyRules.push(rule)
  }

  /**
   * Add an ask rule
   */
  addAskRule(rule: AskRule): void {
    this.askRules.push(rule)
  }

  /**
   * List all active rules
   */
  getRules(): { deny: DenyRule[]; ask: AskRule[] } {
    return {
      deny: this.denyRules,
      ask: this.askRules,
    }
  }

  /**
   * Clear rules (for testing)
   */
  clear(): void {
    this.denyRules = []
    this.askRules = []
  }

  // Helper: check if tool matches rule pattern
  private toolMatches(pattern: string | string[], tool: string): boolean {
    if (pattern === '*') return true
    if (Array.isArray(pattern)) return pattern.includes(tool)
    return pattern === tool
  }
}

// Global singleton
let globalPipeline: PermissionPipeline | null = null

export function initPermissionPipeline(): PermissionPipeline {
  if (!globalPipeline) {
    globalPipeline = new PermissionPipeline()
    // Add default deny rules
    globalPipeline.addDenyRule({
      id: 'deny_absolute_paths',
      tool: ['file_read', 'file_write', 'file_delete'],
      condition: (ctx) => {
        const path = ctx.latestUserMessage || ''
        return /^\/|^[A-Z]:\\/.test(String(path))
      },
      reason: 'Absolute paths must use relative paths within project',
    })
  }
  return globalPipeline
}

export function getPermissionPipeline(): PermissionPipeline {
  if (!globalPipeline) {
    throw new Error('Permission pipeline not initialized. Call initPermissionPipeline() first.')
  }
  return globalPipeline
}

export { PermissionPipeline }
