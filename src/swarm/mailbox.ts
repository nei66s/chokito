/**
 * File-Based Mailbox System with Lockfile Concurrency
 * Arquivo: src/swarm/mailbox.ts
 *
 * Cada agent tem seu próprio inbox JSON em ~/.claude/teams/{teamName}/inboxes/{agentName}.json
 * Mensagens são persistidas como JSONL com lockfile para evitar race conditions
 */

import fs from 'fs'
import path from 'path'
import lockfile from 'proper-lockfile'
import { MailboxMessage, SWARM_BASE_DIR, SWARM_INBOXES_DIR } from './constants.js'
import { persistMailboxMessage, markMessageAsReadInDb } from './persistence.js'

/**
 * Resolve caminho da mailbox de um agent
 * ~/.claude/teams/{teamName}/inboxes/{agentName}.json
 */
export function getMailboxPath(teamName: string, agentName: string): string {
  const baseDir = SWARM_BASE_DIR.replace('~', process.env.HOME || process.env.USERPROFILE || '.')
  const teamDir = path.join(baseDir, teamName)
  return path.join(teamDir, SWARM_INBOXES_DIR, `${agentName}.json`)
}

/**
 * Lê todas as mensagens da mailbox de um agent
 * Com lock para evitar race conditions
 */
export async function readMailbox(
  teamName: string,
  agentName: string,
): Promise<MailboxMessage[]> {
  const mailboxPath = getMailboxPath(teamName, agentName)

  // Se não existir, retorna array vazio
  if (!fs.existsSync(mailboxPath)) {
    return []
  }

  try {
    const content = fs.readFileSync(mailboxPath, 'utf-8')
    if (!content.trim()) return []

    return JSON.parse(content) as MailboxMessage[]
  } catch (error) {
    console.error(`Erro ao ler mailbox ${mailboxPath}:`, error)
    return []
  }
}

/**
 * Escreve mensagens na mailbox de um agent
 * Usa lockfile para concorrência
 */
export async function writeMailbox(
  teamName: string,
  agentName: string,
  messages: MailboxMessage[],
): Promise<void> {
  const mailboxPath = getMailboxPath(teamName, agentName)
  const baseDir = path.dirname(mailboxPath)

  // Cria diretório se não existir
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  // Create empty file if it doesn't exist (needed for lockfile on Windows)
  if (!fs.existsSync(mailboxPath)) {
    fs.writeFileSync(mailboxPath, JSON.stringify([], null, 2))
  }

  let release: (() => Promise<void>) | undefined
  try {
    // Adquire lock com retry exponencial
    release = await lockfile.lock(mailboxPath, {
      retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    })

    // Escreve arquivo
    fs.writeFileSync(mailboxPath, JSON.stringify(messages, null, 2))
  } finally {
    // Libera lock
    if (release) {
      await release()
    }
  }
}

/**
 * Adiciona uma mensagem à mailbox de um agent
 */
export async function addMessage(
  teamName: string,
  recipientName: string,
  message: Omit<MailboxMessage, 'id' | 'timestamp'>,
): Promise<MailboxMessage> {
  const mailboxPath = getMailboxPath(teamName, recipientName)
  const baseDir = path.dirname(mailboxPath)

  // Cria diretório se não existir
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  // Create empty file if it doesn't exist (needed for lockfile on Windows)
  if (!fs.existsSync(mailboxPath)) {
    fs.writeFileSync(mailboxPath, JSON.stringify([], null, 2))
  }

  let release: (() => Promise<void>) | undefined

  try {
    // Adquire lock
    release = await lockfile.lock(mailboxPath, {
      retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    })

    // Lê mensagens existentes
    let messages: MailboxMessage[] = []
    if (fs.existsSync(mailboxPath)) {
      const content = fs.readFileSync(mailboxPath, 'utf-8')
      if (content.trim()) {
        messages = JSON.parse(content)
      }
    }

    // Adiciona nova mensagem
    const newMessage: MailboxMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      status: 'pending',
    }

    messages.push(newMessage)

    // Escreve de volta
    fs.writeFileSync(mailboxPath, JSON.stringify(messages, null, 2))

    // Persist to database as well
    try {
      await persistMailboxMessage(teamName, newMessage)
    } catch (error) {
      console.warn(`Aviso: Erro ao persistir mensagem no DB:`, error)
      // Não falha a operação se DB falhar - arquivo local já foi salvo
    }

    return newMessage
  } finally {
    // Libera lock
    if (release) {
      await release()
    }
  }
}

/**
 * Marca uma mensagem como read
 */
export async function markAsRead(
  teamName: string,
  agentName: string,
  messageId: string,
): Promise<void> {
  const mailboxPath = getMailboxPath(teamName, agentName)

  let release: (() => Promise<void>) | undefined

  try {
    release = await lockfile.lock(mailboxPath, {
      retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    })

    let messages: MailboxMessage[] = []
    if (fs.existsSync(mailboxPath)) {
      const content = fs.readFileSync(mailboxPath, 'utf-8')
      if (content.trim()) {
        messages = JSON.parse(content)
      }
    }

    const msg = messages.find((m) => m.id === messageId)
    if (msg) {
      msg.status = 'read'
    }

    fs.writeFileSync(mailboxPath, JSON.stringify(messages, null, 2))

    // Update database as well
    try {
      await markMessageAsReadInDb(messageId)
    } catch (error) {
      console.warn(`Aviso: Erro ao atualizar mensagem no DB:`, error)
      // Não falha a operação se DB falhar - arquivo local já foi atualizado
    }
  } finally {
    if (release) {
      await release()
    }
  }
}

/**
 * Envia mensagem direta para agent
 */
export async function sendDirectMessage(
  teamName: string,
  senderName: string,
  recipientName: string,
  content: string,
): Promise<MailboxMessage> {
  return addMessage(teamName, recipientName, {
    type: 'direct-message',
    from: senderName,
    to: recipientName,
    content,
  })
}

/**
 * Broadcast para todos os agents do time (menos sender)
 */
export async function broadcastMessage(
  teamName: string,
  senderName: string,
  teamMembers: string[],
  content: string,
): Promise<MailboxMessage[]> {
  const results: MailboxMessage[] = []

  for (const member of teamMembers) {
    if (member !== senderName) {
      const msg = await addMessage(teamName, member, {
        type: 'broadcast',
        from: senderName,
        to: '*',
        content,
      })
      results.push(msg)
    }
  }

  return results
}

/**
 * Envia shutdown request
 */
export async function sendShutdownRequest(
  teamName: string,
  targetName: string,
): Promise<MailboxMessage> {
  return addMessage(teamName, targetName, {
    type: 'shutdown-request',
    from: 'team-lead',
    to: targetName,
    content: 'Shutting down gracefully',
  })
}
