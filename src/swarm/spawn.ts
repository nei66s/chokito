/**
 * Teammate Spawning Logic
 * Arquivo: src/swarm/spawn.ts
 *
 * Orquestra full flow de spawn: detecção de backend, criação de member,
 * inicialização de mailbox, envio de prompt inicial
 */

import { TeamMember, BackendType, TEAM_LEAD_NAME } from './constants'
import * as teamHelpers from './teamHelpers'
import * as mailbox from './mailbox'
import { createBackend, detectBackend } from './backends'

export interface SpawnOptions {
  name: string
  teamName: string
  description?: string
  model?: string
  color?: string
  permissionMode?: 'default' | 'auto' | 'plan'
  planModeRequired?: boolean
  backendType?: BackendType
  cwd: string
  initialPrompt: string
}

/**
 * Spawn um novo teammate
 */
export async function spawnTeammate(options: SpawnOptions): Promise<TeamMember> {
  // 1. Resolve nome único
  const uniqueName = await teamHelpers.generateUniqueMemberName(options.teamName, options.name)

  // 2. Detecta backend se não especificado
  const backendType = options.backendType || (await detectBackend())

  // 3. Cria member entry
  const member: TeamMember = {
    agentId: `${uniqueName}@${options.teamName}`,
    name: uniqueName,
    model: options.model,
    color: options.color,
    planModeRequired: options.planModeRequired,
    cwd: options.cwd,
    subscriptions: [],
    backendType,
    isActive: true,
    mode: options.permissionMode,
  }

  // 4. Adiciona ao time
  await teamHelpers.addTeamMember(options.teamName, member)

  // 5. Cria backend executor
  const backend = createBackend(backendType)

  // 6. Spawn teammate
  try {
    await backend.spawn(member, options.initialPrompt)
  } catch (error) {
    // Remove do time se spawn falhar
    await teamHelpers.removeTeamMember(options.teamName, member.agentId)
    throw error
  }

  // 7. Envia prompt inicial para mailbox
  await mailbox.addMessage(options.teamName, uniqueName, {
    type: 'direct-message',
    from: TEAM_LEAD_NAME,
    to: uniqueName,
    content: options.initialPrompt,
  })

  return member
}

/**
 * Shutdown gracioso de um teammate
 */
export async function shutdownTeammate(teamName: string, agentId: string): Promise<void> {
  const config = await teamHelpers.loadTeamConfig(teamName)
  if (!config) {
    throw new Error(`Time ${teamName} não encontrado`)
  }

  const member = config.members.find((m) => m.agentId === agentId)
  if (!member) {
    throw new Error(`Agent ${agentId} não encontrado`)
  }

  // 1. Envia shutdown request para mailbox do teammate
  await mailbox.sendShutdownRequest(teamName, member.name)

  // 2. Aguarda resposta ou timeout
  let attempts = 0
  const maxAttempts = 10 // 5 segundos com retry de 500ms

  while (attempts < maxAttempts) {
    const messages = await mailbox.readMailbox(teamName, TEAM_LEAD_NAME)
    const response = messages.find(
      (m) => m.type === 'shutdown-response' && m.from === member.name,
    )

    if (response) {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
    attempts++
  }

  // 3. Kill forcefully se não responder
  const backend = createBackend(member.backendType)
  await backend.kill(member)

  // 4. Remove do time
  await teamHelpers.removeTeamMember(teamName, agentId)
}

/**
 * Shutdown entire team
 */
export async function shutdownTeam(teamName: string): Promise<void> {
  const config = await teamHelpers.loadTeamConfig(teamName)
  if (!config) {
    throw new Error(`Time ${teamName} não encontrado`)
  }

  // Shutdown todos os members (exceto leader)
  for (const member of config.members) {
    if (member.name !== TEAM_LEAD_NAME && member.isActive) {
      try {
        await shutdownTeammate(teamName, member.agentId)
      } catch (error) {
        console.warn(`Erro ao encerrar ${member.agentId}:`, error)
      }
    }
  }

  // Delete team directory
  await teamHelpers.deleteTeam(teamName)
}

/**
 * Verifica se teammate ainda está rodando
 */
export async function isTeammateRunning(teamName: string, agentId: string): Promise<boolean> {
  const config = await teamHelpers.loadTeamConfig(teamName)
  if (!config) {
    return false
  }

  const member = config.members.find((m) => m.agentId === agentId)
  if (!member) {
    return false
  }

  const backend = createBackend(member.backendType)
  return await backend.isRunning(member)
}
