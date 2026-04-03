/**
 * Context Assembly — 10th architectural component
 *
 * Centralizes the construction of the full context window sent to the LLM:
 *   1. System prompt assembly (base + dynamic injections)
 *   2. Tool filtering (by permission mode + approved list)
 *   3. Token-aware message truncation (hard cap before API call)
 *   4. File context injection (via LRUCache)
 *   5. Compaction integration
 *
 * Single entry point: assembleContext() → { systemPrompt, messages, tools }
 */

import type { LRUCache } from './cache.js'
import type { ConversationCompactor, Message as CompactionMessage } from './compaction.js'
import type { TokenBudget } from './budgeting.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface SystemInjection {
  /** Short label for debugging (e.g. "permission-mode", "chat-id") */
  label: string
  /** The text line to append to the system prompt */
  text: string
}

export interface AssemblyOptions {
  baseSystemPrompt: string
  injections?: SystemInjection[]
  messages: ContextMessage[]
  tools: unknown[]
  permissionMode?: 'ask' | 'auto' | 'read_only'
  approvedTools?: string[]
  chatId?: string
  /** Max tokens for the messages portion (rough estimate). Default: 32_000 */
  maxMessageTokens?: number
  /** File paths whose content should be injected as a user-side context block */
  fileContextPaths?: string[]
  cache?: LRUCache
  compactor?: ConversationCompactor
  budget?: TokenBudget
}

export interface AssembledContext {
  systemPrompt: string
  messages: ContextMessage[]
  tools: unknown[]
  meta: AssemblyMeta
}

export interface AssemblyMeta {
  originalMessageCount: number
  finalMessageCount: number
  compactionApplied: boolean
  truncationApplied: boolean
  fileContextInjected: number   // number of files injected
  toolCount: number
  estimatedTokens: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~1 token per 4 characters (GPT-style)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateMessageTokens(messages: ContextMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) // +4 for role overhead
}

// ── ContextAssembler class ────────────────────────────────────────────────────

export class ContextAssembler {
  // ── 1. System Prompt Assembly ─────────────────────────────────────────────

  assembleSystemPrompt(base: string, injections: SystemInjection[] = []): string {
    if (injections.length === 0) return base

    const injectedLines = injections.map(i => i.text).join('\n')
    return `${base}\n\n${injectedLines}`
  }

  // ── 2. Tool Filtering ─────────────────────────────────────────────────────

  /**
   * Filter tool definitions based on permission mode and approved-tools list.
   *
   * - read_only  → only tools whose name starts with "read_", "get_", "list_", or "search_"
   * - approvedTools  → when non-empty, restrict to that explicit set (union with mode filter)
   * - auto / ask → no restriction beyond approvedTools
   */
  filterTools(
    allTools: unknown[],
    permissionMode?: 'ask' | 'auto' | 'read_only',
    approvedTools?: string[],
  ): unknown[] {
    const READ_ONLY_PREFIXES = ['read_', 'get_', 'list_', 'search_', 'file_read', 'bash_read']

    let filtered = allTools

    if (permissionMode === 'read_only') {
      filtered = filtered.filter(t => {
        const name: string = (t as any)?.name ?? (t as any)?.function?.name ?? ''
        return READ_ONLY_PREFIXES.some(p => name.startsWith(p))
      })
    }

    if (approvedTools && approvedTools.length > 0) {
      const approvedSet = new Set(approvedTools)
      filtered = filtered.filter(t => {
        const name: string = (t as any)?.name ?? (t as any)?.function?.name ?? ''
        return approvedSet.has(name)
      })
    }

    return filtered
  }

  // ── 3. Token-aware Truncation ─────────────────────────────────────────────

  /**
   * Hard-cap the messages array to `maxTokens` by dropping oldest messages
   * (never drops the first message if it is a user bootstrap message).
   */
  truncateToWindow(messages: ContextMessage[], maxTokens: number): { messages: ContextMessage[]; truncated: boolean } {
    let total = estimateMessageTokens(messages)
    if (total <= maxTokens) return { messages, truncated: false }

    // Keep the last messages; drop from index 0 upward
    const result = [...messages]
    while (result.length > 1 && estimateMessageTokens(result) > maxTokens) {
      result.shift()
    }

    return { messages: result, truncated: true }
  }

  // ── 4. File Context Injection ─────────────────────────────────────────────

  /**
   * For each path, attempt a cache hit. On miss, we skip (caller controls
   * whether to pre-populate cache). Returns an injection block string.
   */
  buildFileContextBlock(paths: string[], cache: LRUCache): string {
    const blocks: string[] = []

    for (const p of paths) {
      const hit = cache.get(p)
      if (hit) {
        blocks.push(`<file path="${p}">\n${hit}\n</file>`)
      }
    }

    if (blocks.length === 0) return ''
    return `[Injected file context]\n${blocks.join('\n\n')}\n[End file context]`
  }

  // ── 5. Main entry point ───────────────────────────────────────────────────

  async assembleContext(opts: AssemblyOptions): Promise<AssembledContext> {
    const {
      baseSystemPrompt,
      injections = [],
      messages,
      tools,
      permissionMode,
      approvedTools,
      maxMessageTokens = 32_000,
      fileContextPaths = [],
      cache,
      compactor,
    } = opts

    const meta: AssemblyMeta = {
      originalMessageCount: messages.length,
      finalMessageCount: 0,
      compactionApplied: false,
      truncationApplied: false,
      fileContextInjected: 0,
      toolCount: 0,
      estimatedTokens: 0,
    }

    // 1. System prompt
    const systemPrompt = this.assembleSystemPrompt(baseSystemPrompt, injections)

    // 2. Tool filtering
    const filteredTools = this.filterTools(tools, permissionMode, approvedTools)
    meta.toolCount = filteredTools.length

    // 3. File context injection (prepend as a user message if any hits)
    let workingMessages = [...messages]

    if (fileContextPaths.length > 0 && cache) {
      const block = this.buildFileContextBlock(fileContextPaths, cache)
      if (block) {
        meta.fileContextInjected = fileContextPaths.filter(p => cache.get(p) !== null).length
        // Inject as a synthetic user message at the start (after any existing system bootstrap)
        workingMessages = [{ role: 'user', content: block }, ...workingMessages]
      }
    }

    // 4. Compaction (reduce old messages into summary)
    if (compactor && workingMessages.length > 10) {
      const compactionInput: CompactionMessage[] = workingMessages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        timestamp: Date.now(),
      }))

      const result = await compactor.compactConversation(compactionInput)
      if (result.tokensSaved > 0) {
        const compacted = compactor.buildCompactedContext(compactionInput, result.summary)
        workingMessages = compacted.map(m => ({ role: m.role as ContextMessage['role'], content: m.content }))
        meta.compactionApplied = true
      }
    }

    // 5. Hard truncation (fallback if compaction wasn't enough)
    const { messages: truncatedMessages, truncated } = this.truncateToWindow(workingMessages, maxMessageTokens)
    if (truncated) meta.truncationApplied = true
    workingMessages = truncatedMessages

    meta.finalMessageCount = workingMessages.length
    meta.estimatedTokens = estimateMessageTokens(workingMessages) + estimateTokens(systemPrompt)

    return {
      systemPrompt,
      messages: workingMessages,
      tools: filteredTools,
      meta,
    }
  }
}

// Singleton for use across the app
export const contextAssembler = new ContextAssembler()
