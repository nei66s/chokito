/**
 * Permission Delegation System
 * Arquivo: src/swarm/permissions.ts
 *
 * Workers delegam permission requests ao leader via mailbox.
 * Leader aprova/rejeita e responde com permission_response.
 * Integra com permission pipeline existente (src/permissions/index.ts)
 */

import { readMailbox, addMessage, markAsRead } from './mailbox.js'
import { TeamConfig } from './constants.js'

export interface PermissionRequest {
  toolName: string
  args: Record<string, unknown>
  reason?: string
  requestId: string
}

export interface PermissionResponse {
  approved: boolean
  reason?: string
  requestId: string
}

/**
 * Worker envia permission request ao leader
 */
export async function sendPermissionRequest(
  teamName: string,
  workerName: string,
  toolName: string,
  args: Record<string, unknown>,
  reason?: string,
): Promise<string> {
  const requestId = `perm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  await addMessage(teamName, 'team-lead', {
    type: 'permission-request',
    from: workerName,
    to: 'team-lead',
    content: JSON.stringify({
      toolName,
      args,
      reason,
      requestId,
    } as PermissionRequest),
  })

  return requestId
}

/**
 * Leader aprova/rejeita permission request
 */
export async function respondToPermissionRequest(
  teamName: string,
  workerName: string,
  approved: boolean,
  requestId: string,
  reason?: string,
): Promise<void> {
  await addMessage(teamName, workerName, {
    type: 'permission-response',
    from: 'team-lead',
    to: workerName,
    content: JSON.stringify({
      approved,
      reason,
      requestId,
    } as PermissionResponse),
  })
}

/**
 * Worker poll mailbox por permission response
 * Timeout após 30s
 */
export async function waitForPermissionResponse(
  teamName: string,
  workerName: string,
  requestId: string,
  timeoutMs: number = 30000,
): Promise<PermissionResponse | null> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const messages = await readMailbox(teamName, workerName)
    const response = messages.find(
      (m) =>
        m.type === 'permission-response' &&
        m.from === 'team-lead' &&
        m.status !== 'read',
    )

    if (response) {
      // Mark as read
      await markAsRead(teamName, workerName, response.id)

      try {
        return JSON.parse(response.content) as PermissionResponse
      } catch {
        return null
      }
    }

    // Wait 500ms before polling again
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return null // Timeout
}

/**
 * Leader poll for pending permission requests
 */
export async function getPendingPermissionRequests(
  teamName: string,
): Promise<
  Array<{
    messageId: string
    workerName: string
    request: PermissionRequest
  }>
> {
  const messages = await readMailbox(teamName, 'team-lead')

  const requests: Array<{
    messageId: string
    workerName: string
    request: PermissionRequest
  }> = []

  for (const msg of messages) {
    if (msg.type === 'permission-request' && msg.status !== 'read') {
      try {
        const request = JSON.parse(msg.content) as PermissionRequest
        requests.push({
          messageId: msg.id,
          workerName: msg.from,
          request,
        })
      } catch {
        // Invalid JSON, skip
      }
    }
  }

  return requests
}

/**
 * Leader mark permission request as read (acknowledged)
 */
export async function acknowledgePermissionRequest(
  teamName: string,
  messageId: string,
): Promise<void> {
  await markAsRead(teamName, 'team-lead', messageId)
}
