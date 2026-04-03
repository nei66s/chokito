/**
 * Swarm System Constants
 * Tipos, nomes hardcoded, env vars para Agent Swarms (Fase 7)
 */

export const TEAM_LEAD_NAME = 'team-lead'
export const SWARM_BASE_DIR = process.env.CLAUDE_TEAMS_DIR || '~/.claude/teams'
export const SWARM_CONFIG_FILE = 'config.json'
export const SWARM_INBOXES_DIR = 'inboxes'

/**
 * Backend types para teammate execution
 */
export type BackendType = 'tmux' | 'iterm2' | 'in-process'

export type MailboxMessageType =
  | 'direct-message'
  | 'broadcast'
  | 'idle-notification'
  | 'permission-request'
  | 'permission-response'
  | 'plan-approval-request'
  | 'plan-approval-response'
  | 'shutdown-request'
  | 'shutdown-response'

export interface MailboxMessage {
  id: string
  type: MailboxMessageType
  from: string
  to: string | '*' // '*' para broadcast
  timestamp: number
  content: string
  status?: 'pending' | 'read' | 'acknowledged'
  metadata?: Record<string, unknown>
}

/**
 * Estrutura de arquivo de team (config.json)
 */
export interface TeamMember {
  agentId: string // "researcher@my-project"
  name: string // "researcher"
  agentType?: string
  model?: string
  prompt?: string
  color?: string // Unique color para UI
  planModeRequired?: boolean
  tmuxPaneId?: string
  cwd: string
  worktreePath?: string
  subscriptions: string[] // Lista de eventos/topics inscritos
  backendType: BackendType
  isActive: boolean
  mode?: 'default' | 'auto' | 'plan'
}

export interface TeamConfig {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string // "team-lead@my-project"
  leadSessionId?: string
  teamAllowedPaths?: Array<{
    path: string
    allowRead: boolean
    allowWrite: boolean
  }>
  members: TeamMember[]
}

/**
 * Env vars para CLI de teammates
 */
export const TEAMMATE_ENV_VARS = {
  TEAM_NAME: 'CLAUDE_TEAM_NAME',
  AGENT_ID: 'CLAUDE_AGENT_ID',
  AGENT_COLOR: 'CLAUDE_AGENT_COLOR',
  IS_TEAMMATE: 'CLAUDE_IS_TEAMMATE',
  PARENT_SESSION_ID: 'CLAUDE_PARENT_SESSION_ID',
}
