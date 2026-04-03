import { parseBashCommand } from './ast.js'

export type BashRisk = 'safe' | 'review' | 'blocked'

export type BashClassification = {
  risk: BashRisk
  reason: string
  tags: string[]
  primaryCommand: string | null
}

const SAFE_COMMANDS = new Set([
  'echo',
  'pwd',
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'grep',
  'find',
  'git',
  'whoami',
])

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string; tag: string }> = [
  { pattern: /\brm\s+-rf\b/iu, reason: 'destructive recursive delete', tag: 'destructive' },
  { pattern: /\bdel\s+\/f\b/iu, reason: 'forced file deletion', tag: 'destructive' },
  { pattern: /\bformat\b/iu, reason: 'disk format operation', tag: 'destructive' },
  { pattern: /\bmkfs(\.[a-z0-9_]+)?\b/iu, reason: 'filesystem formatting', tag: 'destructive' },
  { pattern: /\bdd\s+if=/iu, reason: 'raw disk write/read command', tag: 'destructive' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*;\s*\}/u, reason: 'fork bomb pattern', tag: 'forkbomb' },
  { pattern: /\b(shutdown|reboot|poweroff)\b/iu, reason: 'system power command', tag: 'system' },
]

const REVIEW_PATTERNS: Array<{ pattern: RegExp; reason: string; tag: string }> = [
  { pattern: /(^|\s)(>|>>)(\s|$)/u, reason: 'redirects command output to files', tag: 'write' },
  { pattern: /\b(curl|wget|Invoke-WebRequest)\b/iu, reason: 'network command detected', tag: 'network' },
  { pattern: /\b(sed\s+-i|perl\s+-pi)\b/iu, reason: 'inline file editing command', tag: 'edit' },
]

export function classifyBashCommand(command: string): BashClassification {
  const raw = String(command || '').trim()
  if (!raw) {
    return {
      risk: 'blocked',
      reason: 'empty command',
      tags: ['invalid'],
      primaryCommand: null,
    }
  }

  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(raw)) {
      return {
        risk: 'blocked',
        reason: blocked.reason,
        tags: [blocked.tag],
        primaryCommand: parseBashCommand(raw).segments[0]?.command || null,
      }
    }
  }

  const ast = parseBashCommand(raw)
  const primaryCommand = ast.segments[0]?.command || null

  const reviewTags: string[] = []
  for (const reviewRule of REVIEW_PATTERNS) {
    if (reviewRule.pattern.test(raw)) {
      reviewTags.push(reviewRule.tag)
    }
  }

  if (ast.operators.length > 0) {
    reviewTags.push('operator-chain')
  }

  if (reviewTags.length > 0) {
    return {
      risk: 'review',
      reason: 'command requires additional review',
      tags: Array.from(new Set(reviewTags)),
      primaryCommand,
    }
  }

  if (primaryCommand && SAFE_COMMANDS.has(primaryCommand)) {
    return {
      risk: 'safe',
      reason: 'safe command allowlist match',
      tags: ['allowlist'],
      primaryCommand,
    }
  }

  return {
    risk: 'review',
    reason: 'command not in safe allowlist',
    tags: ['unknown'],
    primaryCommand,
  }
}
