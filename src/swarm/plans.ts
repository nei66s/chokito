/**
 * Plan Mode System
 * Arquivo: src/swarm/plans.ts
 *
 * Teammates com planModeRequired=true devem:
 * 1. Criar um plano
 * 2. Submeter para aprovação do leader
 * 3. Leader aprova/rejeita
 * 4. Teammate continua ou para conforme resposta
 */

import { readMailbox, addMessage, markAsRead } from './mailbox.js'

export interface AgentPlan {
  planId: string
  agentId: string
  title: string
  description: string
  steps: PlanStep[]
  estimatedTokens?: number
  createdAt: number
}

export interface PlanStep {
  stepNumber: number
  description: string
  expectedOutcome: string
  isCompleted?: boolean
}

export interface PlanApprovalRequest {
  planId: string
  agentId: string
  plan: AgentPlan
  reason?: string
}

export interface PlanApprovalResponse {
  planId: string
  approved: boolean
  feedback?: string
  requestedChanges?: string[]
}

/**
 * Worker submete plano para aprovação do leader
 */
export async function submitPlanForApproval(
  teamName: string,
  workerName: string,
  plan: AgentPlan,
  reason?: string,
): Promise<string> {
  const request: PlanApprovalRequest = {
    planId: plan.planId,
    agentId: `${workerName}@${teamName}`,
    plan,
    reason,
  }

  await addMessage(teamName, 'team-lead', {
    type: 'plan-approval-request',
    from: workerName,
    to: 'team-lead',
    content: JSON.stringify(request),
  })

  return plan.planId
}

/**
 * Leader aprova/rejeita plano com feedback
 */
export async function respondToPlanApproval(
  teamName: string,
  workerName: string,
  planId: string,
  approved: boolean,
  feedback?: string,
  requestedChanges?: string[],
): Promise<void> {
  const response: PlanApprovalResponse = {
    planId,
    approved,
    feedback,
    requestedChanges,
  }

  await addMessage(teamName, workerName, {
    type: 'plan-approval-response',
    from: 'team-lead',
    to: workerName,
    content: JSON.stringify(response),
  })
}

/**
 * Worker poll mailbox para plan approval response
 * Timeout após 60s
 */
export async function waitForPlanApproval(
  teamName: string,
  workerName: string,
  planId: string,
  timeoutMs: number = 60000,
): Promise<PlanApprovalResponse | null> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const messages = await readMailbox(teamName, workerName)
    const response = messages.find(
      (m) =>
        m.type === 'plan-approval-response' &&
        m.from === 'team-lead' &&
        m.status !== 'read',
    )

    if (response) {
      // Mark as read
      await markAsRead(teamName, workerName, response.id)

      try {
        const parsed = JSON.parse(response.content) as PlanApprovalResponse
        if (parsed.planId === planId) {
          return parsed
        }
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
 * Leader poll for pending plan approvals
 */
export async function getPendingPlanApprovals(
  teamName: string,
): Promise<
  Array<{
    messageId: string
    workerName: string
    request: PlanApprovalRequest
  }>
> {
  const messages = await readMailbox(teamName, 'team-lead')

  const requests: Array<{
    messageId: string
    workerName: string
    request: PlanApprovalRequest
  }> = []

  for (const msg of messages) {
    if (msg.type === 'plan-approval-request' && msg.status !== 'read') {
      try {
        const request = JSON.parse(msg.content) as PlanApprovalRequest
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
 * Leader mark plan request as read (acknowledged)
 */
export async function acknowledgePlanRequest(
  teamName: string,
  messageId: string,
): Promise<void> {
  await markAsRead(teamName, 'team-lead', messageId)
}

/**
 * Generate a plan ID
 */
export function generatePlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Create a plan object
 */
export function createPlan(
  title: string,
  description: string,
  steps: PlanStep[],
  estimatedTokens?: number,
): AgentPlan {
  return {
    planId: generatePlanId(),
    agentId: '', // Will be set by worker
    title,
    description,
    steps,
    estimatedTokens,
    createdAt: Date.now(),
  }
}
