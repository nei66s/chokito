/**
 * Session Persistence Layer
 * Arquivo: src/swarm/sessionPersistence.ts
 *
 * Save and restore agent conversation sessions with history and recovery
 */

import { query } from '../db.js'

/**
 * Session record structure
 */
export interface SessionRecord {
  id: string
  teamName: string
  agentName: string
  title: string
  description?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  status: 'active' | 'paused' | 'ended'
  metadata?: Record<string, any>
}

/**
 * Conversation message in session
 */
export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  tokens?: number
}

/**
 * Create a new session
 */
export async function createSession(
  teamName: string,
  agentName: string,
  title: string,
  description?: string,
): Promise<SessionRecord> {
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  await query(
    `INSERT INTO swarm_sessions (id, team_name, agent_name, title, description, created_at, updated_at, message_count, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [sessionId, teamName, agentName, title, description || null, new Date(), new Date(), 0, 'active'],
  )

  return {
    id: sessionId,
    teamName,
    agentName,
    title,
    description,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    status: 'active',
  }
}

/**
 * Get session by ID
 */
export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  const result = await query('SELECT * FROM swarm_sessions WHERE id = $1', [sessionId])

  if (result.rows.length === 0) {
    return null
  }

  const row = result.rows[0]
  return {
    id: row.id,
    teamName: row.team_name,
    agentName: row.agent_name,
    title: row.title,
    description: row.description,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    messageCount: row.message_count,
    status: row.status,
    metadata: row.metadata_json,
  }
}

/**
 * List all sessions for an agent
 */
export async function listSessions(
  teamName: string,
  agentName: string,
  status?: 'active' | 'paused' | 'ended',
): Promise<SessionRecord[]> {
  let sql = `SELECT * FROM swarm_sessions WHERE team_name = $1 AND agent_name = $2`
  const params: any[] = [teamName, agentName]

  if (status) {
    sql += ` AND status = $3`
    params.push(status)
  }

  sql += ` ORDER BY updated_at DESC`

  const result = await query(sql, params)

  return result.rows.map((row) => ({
    id: row.id,
    teamName: row.team_name,
    agentName: row.agent_name,
    title: row.title,
    description: row.description,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    messageCount: row.message_count,
    status: row.status,
    metadata: row.metadata_json,
  }))
}

/**
 * Add message to session
 */
export async function addSessionMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  tokens?: number,
): Promise<SessionMessage> {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  await query(
    `INSERT INTO swarm_session_messages (id, session_id, role, content, timestamp, tokens)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [messageId, sessionId, role, content, new Date(), tokens || 0],
  )

  // Update session message count and timestamp
  await query(
    `UPDATE swarm_sessions 
     SET message_count = message_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [sessionId],
  )

  return {
    id: messageId,
    sessionId,
    role,
    content,
    timestamp: Date.now(),
    tokens,
  }
}

/**
 * Get all messages in a session
 */
export async function getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  const result = await query(
    `SELECT * FROM swarm_session_messages WHERE session_id = $1 ORDER BY timestamp ASC`,
    [sessionId],
  )

  return result.rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    timestamp: new Date(row.timestamp).getTime(),
    tokens: row.tokens,
  }))
}

/**
 * Update session status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: 'active' | 'paused' | 'ended',
): Promise<void> {
  await query(`UPDATE swarm_sessions SET status = $1, updated_at = NOW() WHERE id = $2`, [status, sessionId])
}

/**
 * Delete session and all messages
 */
export async function deleteSession(sessionId: string): Promise<void> {
  // Delete messages first (FK constraint)
  await query(`DELETE FROM swarm_session_messages WHERE session_id = $1`, [sessionId])
  // Delete session
  await query(`DELETE FROM swarm_sessions WHERE id = $1`, [sessionId])
}

/**
 * Export session as JSON (for backup/sharing)
 */
export async function exportSession(sessionId: string): Promise<{ session: SessionRecord; messages: SessionMessage[] } | null> {
  const session = await getSession(sessionId)
  if (!session) {
    return null
  }

  const messages = await getSessionMessages(sessionId)

  return {
    session,
    messages,
  }
}

/**
 * Query sessions by date range
 */
export async function getSessionsByDateRange(
  teamName: string,
  agentName: string,
  startDate: number,
  endDate: number,
): Promise<SessionRecord[]> {
  const result = await query(
    `SELECT * FROM swarm_sessions 
     WHERE team_name = $1 AND agent_name = $2 
     AND created_at BETWEEN $3 AND $4
     ORDER BY created_at DESC`,
    [teamName, agentName, new Date(startDate), new Date(endDate)],
  )

  return result.rows.map((row) => ({
    id: row.id,
    teamName: row.team_name,
    agentName: row.agent_name,
    title: row.title,
    description: row.description,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    messageCount: row.message_count,
    status: row.status,
    metadata: row.metadata_json,
  }))
}

/**
 * Get session statistics
 */
export async function getSessionStats(teamName: string, agentName: string): Promise<{
  totalSessions: number
  activeSessions: number
  totalMessages: number
  averageMessagesPerSession: number
}> {
  const result = await query(
    `SELECT 
       COUNT(DISTINCT id) as total_sessions,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_sessions,
       SUM(message_count) as total_messages
     FROM swarm_sessions
     WHERE team_name = $1 AND agent_name = $2`,
    [teamName, agentName],
  )

  const row = result.rows[0]
  const totalSessions = parseInt(row.total_sessions || '0', 10)
  const activeSessions = parseInt(row.active_sessions || '0', 10)
  const totalMessages = parseInt(row.total_messages || '0', 10)

  return {
    totalSessions,
    activeSessions,
    totalMessages,
    averageMessagesPerSession: totalSessions > 0 ? Math.round(totalMessages / totalSessions) : 0,
  }
}

/**
 * Search sessions by title or content
 */
export async function searchSessions(
  teamName: string,
  agentName: string,
  query_text: string,
): Promise<SessionRecord[]> {
  const result = await query(
    `SELECT DISTINCT s.* FROM swarm_sessions s
     LEFT JOIN swarm_session_messages m ON s.id = m.session_id
     WHERE s.team_name = $1 AND s.agent_name = $2
     AND (s.title ILIKE $3 OR s.description ILIKE $3 OR m.content ILIKE $3)
     ORDER BY s.updated_at DESC`,
    [teamName, agentName, `%${query_text}%`],
  )

  return result.rows.map((row) => ({
    id: row.id,
    teamName: row.team_name,
    agentName: row.agent_name,
    title: row.title,
    description: row.description,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    messageCount: row.message_count,
    status: row.status,
    metadata: row.metadata_json,
  }))
}
