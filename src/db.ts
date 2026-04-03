import dotenv from 'dotenv'
import pg, { type QueryResultRow } from 'pg'

dotenv.config()

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL not set in environment')
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
})

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: any[] = []) {
  return pool.query<T>(text, params)
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      content TEXT NOT NULL DEFAULT '',
      trace_json JSONB,
      streaming BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (conversation_id, sort_order)
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id BIGSERIAL PRIMARY KEY,
      message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE (message_id, sort_order)
    );

    CREATE TABLE IF NOT EXISTS workflow_plans (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      goal TEXT NOT NULL,
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES workflow_plans(conversation_id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
      sort_order INTEGER NOT NULL,
      UNIQUE (conversation_id, step_id),
      UNIQUE (conversation_id, sort_order)
    );

    CREATE TABLE IF NOT EXISTS agent_todos (
      id BIGSERIAL PRIMARY KEY,
      owner_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS token_costs (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd NUMERIC(10, 6) NOT NULL,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coordinator_tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message TEXT NOT NULL,
      synthesis TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS coordinated_subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES coordinator_tasks(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      assigned_worker_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
      result TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS swarm_teams (
      name TEXT PRIMARY KEY,
      lead_agent_id TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      config_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swarm_messages (
      id TEXT PRIMARY KEY,
      team_name TEXT NOT NULL REFERENCES swarm_teams(name) ON DELETE CASCADE,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('direct-message', 'broadcast', 'idle-notification', 'permission-request', 'permission-response', 'plan-approval-request', 'plan-approval-response', 'shutdown-request', 'shutdown-response')),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'acknowledged')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata_json JSONB
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_swarm_teams_created_at ON swarm_teams (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swarm_messages_team_name ON swarm_messages (team_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swarm_messages_to_agent ON swarm_messages (team_name, to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_swarm_messages_from_agent ON swarm_messages (team_name, from_agent);
  `)

  // Session persistence tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS swarm_sessions (
      id TEXT PRIMARY KEY,
      team_name TEXT NOT NULL REFERENCES swarm_teams(name) ON DELETE CASCADE,
      agent_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
      metadata_json JSONB
    );

    CREATE TABLE IF NOT EXISTS swarm_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES swarm_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tokens INTEGER DEFAULT 0
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_swarm_sessions_team_agent ON swarm_sessions (team_name, agent_name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swarm_sessions_status ON swarm_sessions (status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swarm_session_messages_session ON swarm_session_messages (session_id, timestamp ASC);
  `)
}

/**
 * Record token usage and cost for a conversation
 */
export async function recordTokenCost(
  conversationId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  model: string,
) {
  return query(
    `INSERT INTO token_costs (conversation_id, input_tokens, output_tokens, cost_usd, model, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [conversationId, inputTokens, outputTokens, costUsd, model],
  )
}

/**
 * Get cost summary for a conversation
 */
export async function getConversationCosts(conversationId: string) {
  const result = await query(
    `SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(cost_usd) as total_cost
     FROM token_costs WHERE conversation_id = $1`,
    [conversationId],
  )
  if (result.rows.length === 0) return { total_input: 0, total_output: 0, total_cost: 0 }
  const row = result.rows[0] as any
  return {
    total_input: row.total_input ?? 0,
    total_output: row.total_output ?? 0,
    total_cost: Number(row.total_cost ?? 0),
  }
}

/**
 * Save a coordinator task to database
 */
export async function saveCoordinatorTask(
  taskId: string,
  conversationId: string,
  userMessage: string,
  synthesis?: string | null,
  status: string = 'completed',
) {
  return query(
    `INSERT INTO coordinator_tasks (id, conversation_id, user_message, synthesis, status, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET synthesis = $4, status = $5, completed_at = NOW()`,
    [taskId, conversationId, userMessage, synthesis || null, status],
  )
}

/**
 * Save coordinated subtasks
 */
export async function saveCoordinatedSubtask(
  subtaskId: string,
  taskId: string,
  description: string,
  assignedWorkerId: string | null,
  status: string = 'completed',
  result?: string | null,
  errorMessage?: string | null,
) {
  return query(
    `INSERT INTO coordinated_subtasks (id, task_id, description, assigned_worker_id, status, result, error_message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET status = $5, result = $6, error_message = $7, completed_at = NOW()`,
    [subtaskId, taskId, description, assignedWorkerId || null, status, result || null, errorMessage || null],
  )
}

/**
 * Get coordinator task history
 */
export async function getCoordinatorTasks(conversationId: string) {
  const result = await query(
    `SELECT id, user_message, synthesis, status, created_at, completed_at
     FROM coordinator_tasks
     WHERE conversation_id = $1
     ORDER BY created_at DESC`,
    [conversationId],
  )
  return result.rows
}

/**
 * Get subtasks for a coordinator task
 */
export async function getCoordinatedSubtasks(taskId: string) {
  const result = await query(
    `SELECT id, description, assigned_worker_id, status, result, error_message, created_at, completed_at
     FROM coordinated_subtasks
     WHERE task_id = $1
     ORDER BY created_at ASC`,
    [taskId],
  )
  return result.rows
}
