/**
 * Hook Events — Core system events that tools and features can hook into.
 * Total: 20 event types covering full lifecycle.
 */

export type HookEventType =
  // Session lifecycle
  | 'SessionStart'
  | 'SessionEnd'
  
  // Tool execution
  | 'PreToolUse'
  | 'PostToolUse'
  | 'ToolError'
  
  // Permissions
  | 'PermissionDenied'
  | 'PermissionAsked'
  | 'PermissionApproved'
  | 'PermissionRevoked'
  
  // Messages
  | 'MessageReceived'
  | 'MessageProcessed'
  | 'MessageSent'
  
  // File operations
  | 'FileRead'
  | 'FileWrite'
  | 'FileDelete'
  | 'FileMove'
  
  // Workflow
  | 'WorkflowCreated'
  | 'WorkflowUpdated'
  | 'WorkflowCompleted'
  
  // Security/Audit
  | 'SecurityAlert'

// Hook handler signature
export type HookHandler = (payload: HookPayload) => Promise<void> | void

// Payload sent to hook handlers
export interface HookPayload {
  type: HookEventType
  timestamp: string
  userId?: string
  chatId?: string
  data?: Record<string, any>
}

// Hook registration
export interface Hook {
  id: string
  event: HookEventType
  handler: HookHandler
  priority?: number // 0-100, higher = earlier execution
  disabled?: boolean
}

// Hook filter for querying
export interface HookFilter {
  event?: HookEventType
  userId?: string
  disabled?: boolean
}
