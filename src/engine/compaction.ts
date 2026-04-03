/**
 * Conversation Compaction / Auto-Resume
 * Summarizes old messages to reduce token usage in long conversations.
 */

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface CompactionResult {
  originalMessages: number
  compactedMessages: number
  tokensSaved: number
  summary: string
}

export class ConversationCompactor {
  private summaryThreshold = 10 // compact after N messages
  private keepRecent = 5 // always keep last N messages
  private summarizeTokenLimit = 15000 // rough limit for summary generation

  async compactConversation(messages: Message[]): Promise<CompactionResult> {
    if (messages.length <= this.summaryThreshold) {
      return {
        originalMessages: messages.length,
        compactedMessages: messages.length,
        tokensSaved: 0,
        summary: '',
      }
    }

    const recent = messages.slice(-this.keepRecent)
    const toSummarize = messages.slice(0, -this.keepRecent)

    // Estimate tokens (rough: ~1 token per 4 chars)
    const oldTokens = toSummarize.reduce((sum, m) => sum + this.estimateTokens(m.content), 0)
    const recentTokens = recent.reduce((sum, m) => sum + this.estimateTokens(m.content), 0)

    // Only compact if it saves significant tokens
    if (oldTokens < 2000) {
      return {
        originalMessages: messages.length,
        compactedMessages: messages.length,
        tokensSaved: 0,
        summary: '',
      }
    }

    const summary = this.generateSummary(toSummarize)

    return {
      originalMessages: messages.length,
      compactedMessages: recent.length + 1, // +1 for system summary
      tokensSaved: oldTokens - this.estimateTokens(summary),
      summary,
    }
  }

  private generateSummary(messages: Message[]): string {
    const parts = []

    // Extract key exchanges
    for (const msg of messages) {
      if (msg.role === 'user') {
        const preview = msg.content.substring(0, 100)
        parts.push(`- User asked: ${preview}${msg.content.length > 100 ? '...' : ''}`)
      } else if (msg.role === 'assistant' && msg.content.length > 20) {
        const preview = msg.content.substring(0, 100)
        parts.push(`  Agent responded: ${preview}${msg.content.length > 100 ? '...' : ''}`)
      }
    }

    return (
      `[Earlier conversation summary]\n` +
      parts.slice(0, 20).join('\n') +
      `\n[End summary]\n`
    )
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4)
  }

  buildCompactedContext(messages: Message[], summary?: string): Message[] {
    if (!summary) return messages

    const recent = messages.slice(-this.keepRecent)
    const compacted: Message[] = []

    if (summary) {
      compacted.push({
        role: 'system',
        content: summary,
        timestamp: messages[0].timestamp,
      })
    }

    compacted.push(...recent)
    return compacted
  }
}
