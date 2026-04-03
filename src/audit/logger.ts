/**
 * Audit Logger — Records sensitive operations for compliance/debugging.
 */

export interface AuditEntry {
  id: string
  timestamp: string
  userId?: string
  chatId?: string
  action: string // 'tool_execute', 'permission_denied', 'permission_approved', etc.
  tool?: string
  input?: Record<string, any>
  result?: string | boolean
  error?: string
  metadata?: Record<string, any>
}

// In-memory storage; could be persisted to DB
const auditLog: AuditEntry[] = []
let nextId = 1

export class AuditLogger {
  /**
   * Log an audit entry
   */
  static log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      id: `audit_${nextId++}`,
      timestamp: new Date().toISOString(),
      ...entry,
    }
    auditLog.push(full)
    
    // Keep only last 10000 entries (prevent unbounded growth)
    if (auditLog.length > 10000) {
      auditLog.splice(0, auditLog.length - 10000)
    }

    return full
  }

  /**
   * Log tool execution
   */
  static logToolExecution(
    tool: string,
    input: any,
    result: any,
    userId?: string,
    chatId?: string
  ): AuditEntry {
    return this.log({
      action: 'tool_execute',
      tool,
      input,
      result: typeof result === 'string' ? result : result?.ok ? 'ok' : 'error',
      userId,
      chatId,
    })
  }

  /**
   * Log permission denial
   */
  static logPermissionDenied(
    tool: string,
    reason: string,
    userId?: string,
    chatId?: string
  ): AuditEntry {
    return this.log({
      action: 'permission_denied',
      tool,
      error: reason,
      userId,
      chatId,
    })
  }

  /**
   * Log permission approval
   */
  static logPermissionApproved(
    tool: string,
    ruleId: string,
    userId?: string,
    chatId?: string
  ): AuditEntry {
    return this.log({
      action: 'permission_approved',
      tool,
      metadata: { ruleId },
      userId,
      chatId,
    })
  }

  /**
   * Get recent audit entries
   */
  static getRecent(limit = 100, filter?: { userId?: string; chatId?: string; action?: string }): AuditEntry[] {
    let results = auditLog.slice(-limit)

    if (filter) {
      results = results.filter(entry => {
        if (filter.userId && entry.userId !== filter.userId) return false
        if (filter.chatId && entry.chatId !== filter.chatId) return false
        if (filter.action && entry.action !== filter.action) return false
        return true
      })
    }

    return results.reverse() // newest first
  }

  /**
   * Get stats (for monitoring)
   */
  static getStats(): { total: number; byAction: Record<string, number> } {
    const byAction: Record<string, number> = {}
    auditLog.forEach(entry => {
      byAction[entry.action] = (byAction[entry.action] || 0) + 1
    })
    return { total: auditLog.length, byAction }
  }

  /**
   * Clear all entries (testing only)
   */
  static clear(): void {
    auditLog.length = 0
    nextId = 1
  }
}

// Also export raw log for direct access
export { auditLog }
