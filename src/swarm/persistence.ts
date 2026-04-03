/**
 * Swarm Persistence Layer
 * Arquivo: src/swarm/persistence.ts
 *
 * Integração com banco de dados PostgreSQL para persist teams e messages
 */

import { query } from '../db.js'
import { TeamConfig, MailboxMessage } from './constants.js'

/**
 * Persist team config ao banco de dados
 */
export async function persistTeamConfig(config: TeamConfig): Promise<void> {
  await query(
    `INSERT INTO swarm_teams (name, lead_agent_id, description, config_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE 
     SET config_json = $4, updated_at = $6`,
    [
      config.name,
      config.leadAgentId,
      config.description || null,
      JSON.stringify(config),
      new Date(config.createdAt),
      new Date(),
    ],
  )
}

/**
 * Load team config do banco de dados
 */
export async function loadTeamConfigFromDb(teamName: string): Promise<TeamConfig | null> {
  const result = await query(
    `SELECT config_json FROM swarm_teams WHERE name = $1`,
    [teamName],
  )

  if (result.rows.length === 0) {
    return null
  }

  return result.rows[0].config_json as TeamConfig
}

/**
 * Delete team from database
 */
export async function deleteTeamFromDb(teamName: string): Promise<void> {
  await query(`DELETE FROM swarm_teams WHERE name = $1`, [teamName])
}

/**
 * List all teams from database
 */
export async function listTeamsFromDb(): Promise<string[]> {
  const result = await query(`SELECT name FROM swarm_teams ORDER BY created_at DESC`)
  return result.rows.map((row) => row.name as string)
}

/**
 * Persist mailbox message ao banco de dados
 */
export async function persistMailboxMessage(
  teamName: string,
  message: MailboxMessage,
): Promise<void> {
  await query(
    `INSERT INTO swarm_messages (id, team_name, from_agent, to_agent, type, content, status, created_at, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE 
     SET status = $7`,
    [
      message.id,
      teamName,
      message.from,
      message.to,
      message.type,
      message.content,
      message.status || 'pending',
      new Date(message.timestamp),
      JSON.stringify(message.metadata || {}),
    ],
  )
}

/**
 * Load mailbox messages para um agent
 */
export async function loadMailboxMessagesFromDb(
  teamName: string,
  agentName: string,
): Promise<MailboxMessage[]> {
  const result = await query(
    `SELECT id, team_name, from_agent as "from", to_agent as "to", type, content, status, created_at as timestamp, metadata_json as metadata
     FROM swarm_messages 
     WHERE team_name = $1 AND to_agent = $2
     ORDER BY created_at ASC`,
    [teamName, agentName],
  )

  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    from: row.from,
    to: row.to,
    timestamp: new Date(row.timestamp).getTime(),
    content: row.content,
    status: row.status as 'pending' | 'read' | 'acknowledged' | undefined,
    metadata: row.metadata,
  }))
}

/**
 * Mark message as read in database
 */
export async function markMessageAsReadInDb(messageId: string): Promise<void> {
  await query(`UPDATE swarm_messages SET status = 'read' WHERE id = $1`, [messageId])
}

/**
 * Get mailbox message count for an agent
 */
export async function getMailboxMessageCountFromDb(
  teamName: string,
  agentName: string,
  status?: 'pending' | 'read' | 'acknowledged',
): Promise<number> {
  let sql = `SELECT COUNT(*) as count FROM swarm_messages WHERE team_name = $1 AND to_agent = $2`
  const params: any[] = [teamName, agentName]

  if (status) {
    sql += ` AND status = $3`
    params.push(status)
  }

  const result = await query(sql, params)
  return parseInt(result.rows[0].count as string, 10)
}

/**
 * Get message history for team
 */
export async function getTeamMessageHistoryFromDb(
  teamName: string,
  limit: number = 100,
  offset: number = 0,
): Promise<Array<MailboxMessage & { toAgent: string }>> {
  const result = await query(
    `SELECT id, from_agent as "from", to_agent as "toAgent", type, content, status, created_at as timestamp, metadata_json as metadata
     FROM swarm_messages 
     WHERE team_name = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [teamName, limit, offset],
  )

  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    from: row.from,
    to: row.toAgent,
    timestamp: new Date(row.timestamp).getTime(),
    content: row.content,
    status: row.status as 'pending' | 'read' | 'acknowledged' | undefined,
    metadata: row.metadata,
    toAgent: row.toAgent,
  }))
}

/**
 * Delete old messages (cleanup)
 */
export async function deleteOldMessagesFromDb(
  teamName: string,
  daysOld: number = 30,
): Promise<number> {
  const result = await query(
    `DELETE FROM swarm_messages 
     WHERE team_name = $1 AND created_at < NOW() - INTERVAL '${daysOld} days'`,
    [teamName],
  )
  return result.rowCount || 0
}
