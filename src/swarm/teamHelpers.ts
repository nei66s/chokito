/**
 * Team Helpers: CRUD, Cleanup, Worktree Management
 * Arquivo: src/swarm/teamHelpers.ts
 */

import fs from 'fs'
import path from 'path'
import { TeamConfig, TeamMember, TEAM_LEAD_NAME, SWARM_BASE_DIR, SWARM_CONFIG_FILE } from './constants'
import { persistTeamConfig, deleteTeamFromDb } from './persistence'
import { registerHook, executePreHooks, executePostHooks } from './hooks'

/**
 * Resolve caminho do diretório do time
 */
export function getTeamDir(teamName: string): string {
  const baseDir = SWARM_BASE_DIR.replace('~', process.env.HOME || process.env.USERPROFILE || '.')
  return path.join(baseDir, teamName)
}

/**
 * Resolve caminho do config.json do time
 */
export function getTeamConfigPath(teamName: string): string {
  return path.join(getTeamDir(teamName), SWARM_CONFIG_FILE)
}

/**
 * Carrega config do time do disco
 */
export async function loadTeamConfig(teamName: string): Promise<TeamConfig | null> {
  const configPath = getTeamConfigPath(teamName)

  if (!fs.existsSync(configPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(content) as TeamConfig
  } catch (error) {
    console.error(`Erro ao carregar config do time ${teamName}:`, error)
    return null
  }
}

/**
 * Salva config do time no disco
 */
export async function saveTeamConfig(config: TeamConfig): Promise<void> {
  const teamDir = getTeamDir(config.name)
  const configPath = getTeamConfigPath(config.name)

  // Cria diretório se não existir
  if (!fs.existsSync(teamDir)) {
    fs.mkdirSync(teamDir, { recursive: true })
  }

  // Cria diretório de inboxes
  const inboxesDir = path.join(teamDir, 'inboxes')
  if (!fs.existsSync(inboxesDir)) {
    fs.mkdirSync(inboxesDir, { recursive: true })

    // Cria mailbox vazia para leader
    const leadMailbox = path.join(inboxesDir, `${TEAM_LEAD_NAME}.json`)
    fs.writeFileSync(leadMailbox, JSON.stringify([], null, 2))
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  // Persist to database as well
  try {
    await persistTeamConfig(config)
  } catch (error) {
    console.warn(`Aviso: Erro ao persistir config do time no DB:`, error)
    // Não falha a operação se DB falhar - arquivo local já foi salvo
  }
}

/**
 * Cria novo time
 * Retorna o config criado
 */
export async function createTeam(name: string, description?: string): Promise<TeamConfig> {
  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadAgentId: `${TEAM_LEAD_NAME}@${name}`,
    members: [],
  }

  // Execute pre-hooks for validation
  const context = { timestamp: Date.now() }
  const allowed = await executePreHooks('team', 'onCreate', config, context)
  if (!allowed) {
    throw new Error(`Team creation rejected by pre-hook`)
  }

  await saveTeamConfig(config)

  // Execute post-hooks for side effects
  await executePostHooks('team', 'onCreate', config, context)

  return config
}

/**
 * Lista todos os times
 */
export async function listTeams(): Promise<string[]> {
  const baseDir = SWARM_BASE_DIR.replace('~', process.env.HOME || process.env.USERPROFILE || '.')

  if (!fs.existsSync(baseDir)) {
    return []
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(getTeamConfigPath(name)))
}

/**
 * Adiciona member ao time
 */
export async function addTeamMember(teamName: string, member: TeamMember): Promise<void> {
  const config = await loadTeamConfig(teamName)
  if (!config) {
    throw new Error(`Time ${teamName} não encontrado`)
  }

  // Verifica se já existe
  if (config.members.some((m) => m.agentId === member.agentId)) {
    throw new Error(`Agent ${member.agentId} já existe neste time`)
  }

  config.members.push(member)
  await saveTeamConfig(config)

  // Cria mailbox para o novo member
  const teamDir = getTeamDir(teamName)
  const mailboxPath = path.join(teamDir, 'inboxes', `${member.name}.json`)
  fs.writeFileSync(mailboxPath, JSON.stringify([], null, 2))
}

/**
 * Remove member do time
 */
export async function removeTeamMember(teamName: string, agentId: string): Promise<void> {
  const config = await loadTeamConfig(teamName)
  if (!config) {
    throw new Error(`Time ${teamName} não encontrado`)
  }

  const member = config.members.find((m) => m.agentId === agentId)
  if (!member) {
    throw new Error(`Agent ${agentId} não encontrado neste time`)
  }

  config.members = config.members.filter((m) => m.agentId !== agentId)
  await saveTeamConfig(config)

  // Remove mailbox
  const teamDir = getTeamDir(teamName)
  const mailboxPath = path.join(teamDir, 'inboxes', `${member.name}.json`)
  if (fs.existsSync(mailboxPath)) {
    fs.unlinkSync(mailboxPath)
  }

  // Limpa worktree se existir
  if (member.worktreePath && fs.existsSync(member.worktreePath)) {
    try {
      fs.rmSync(member.worktreePath, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Erro ao remover worktree ${member.worktreePath}:`, error)
    }
  }
}

/**
 * Delete entire team
 */
export async function deleteTeam(teamName: string): Promise<void> {
  const teamDir = getTeamDir(teamName)

  // Execute pre-hooks
  const context = { timestamp: Date.now() }
  const allowed = await executePreHooks('team', 'onDelete', teamName, context)
  if (!allowed) {
    throw new Error(`Team deletion rejected by pre-hook`)
  }

  if (fs.existsSync(teamDir)) {
    fs.rmSync(teamDir, { recursive: true, force: true })
  }

  // Remove do database
  try {
    await deleteTeamFromDb(teamName)
  } catch (error) {
    console.warn(`Aviso: Erro ao deletar time do DB:`, error)
  }

  // Remove todos os worktrees dos members
  const config = await loadTeamConfig(teamName)
  if (config) {
    for (const member of config.members) {
      if (member.worktreePath && fs.existsSync(member.worktreePath)) {
        try {
          fs.rmSync(member.worktreePath, { recursive: true, force: true })
        } catch (error) {
          console.warn(`Erro ao remover worktree ${member.worktreePath}:`, error)
        }
      }
    }
  }

  // Execute post-hooks
  await executePostHooks('team', 'onDelete', teamName, context)
}

/**
 * Gera nome único para team (evita colisões)
 * Se 'my-project' existe, tenta 'my-project-2', 'my-project-3', etc
 */
export async function generateUniqueName(baseName: string): Promise<string> {
  const teams = await listTeams()

  if (!teams.includes(baseName)) {
    return baseName
  }

  let counter = 2
  while (teams.includes(`${baseName}-${counter}`)) {
    counter++
  }

  return `${baseName}-${counter}`
}

/**
 * Gera nome único para teammate dentro de um time
 */
export async function generateUniqueMemberName(teamName: string, baseName: string): Promise<string> {
  const config = await loadTeamConfig(teamName)
  if (!config) {
    throw new Error(`Time ${teamName} não encontrado`)
  }

  const members = config.members.map((m) => m.name)

  if (!members.includes(baseName)) {
    return baseName
  }

  let counter = 2
  while (members.includes(`${baseName}-${counter}`)) {
    counter++
  }

  return `${baseName}-${counter}`
}

/**
 * Valida se time existe
 */
export async function teamExists(teamName: string): Promise<boolean> {
  return (await loadTeamConfig(teamName)) !== null
}

/**
 * Gets all active (isActive=true) members of a team
 */
export async function getActiveMembers(teamName: string): Promise<TeamMember[]> {
  const config = await loadTeamConfig(teamName)
  if (!config) {
    return []
  }

  return config.members.filter((m) => m.isActive)
}
