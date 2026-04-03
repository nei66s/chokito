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
  `)

  await pool.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES app_users(id) ON DELETE CASCADE;
    ALTER TABLE agent_todos ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES app_users(id) ON DELETE CASCADE;
  `)

  await pool.query(`
    INSERT INTO app_users (id, display_name, created_at, updated_at)
    VALUES ('legacy-local', 'Local legacy', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING;
  `)

  await pool.query(`
    UPDATE conversations
    SET owner_id = 'legacy-local'
    WHERE owner_id IS NULL;

    UPDATE agent_todos
    SET owner_id = 'legacy-local'
    WHERE owner_id IS NULL;
  `)

  await pool.query(`
    ALTER TABLE conversations ALTER COLUMN owner_id SET NOT NULL;
    ALTER TABLE agent_todos ALTER COLUMN owner_id SET NOT NULL;
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON message_attachments (message_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_conversation_id ON workflow_steps (conversation_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_conversations_owner_id ON conversations (owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_todos_owner_id ON agent_todos (owner_id, id ASC);
  `)
}
