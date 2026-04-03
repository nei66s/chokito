import type { BashClassification } from './classifier.js'

export type BashHistoryEntry = {
  id: string
  timestamp: string
  command: string
  cwd: string
  classification: BashClassification
  sandbox: 'bubblewrap' | 'seatbelt' | 'none'
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  replayOf?: string
}

const MAX_HISTORY = Math.max(100, Number(process.env.BASH_HISTORY_LIMIT || 1000))
const history: BashHistoryEntry[] = []
let nextId = 1

export function recordBashHistory(entry: Omit<BashHistoryEntry, 'id' | 'timestamp'>): BashHistoryEntry {
  const fullEntry: BashHistoryEntry = {
    id: `bash_${nextId++}`,
    timestamp: new Date().toISOString(),
    ...entry,
  }

  history.push(fullEntry)
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY)
  }

  return fullEntry
}

export function getBashHistoryById(id: string): BashHistoryEntry | null {
  const wantedId = String(id || '').trim()
  if (!wantedId) return null
  return history.find((entry) => entry.id === wantedId) || null
}

export function listBashHistory(limit = 50): BashHistoryEntry[] {
  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 500))
  return history.slice(-safeLimit).reverse()
}
