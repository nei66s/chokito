/**
 * Enhanced Streaming for Claude API
 * Supports token tracking, cost estimation, and graceful cancellation.
 */

export interface StreamEvent {
  type: 'start' | 'token' | 'stop' | 'error' | 'cost'
  token?: string
  tokenCount?: number
  inputTokens?: number
  outputTokens?: number
  totalCost?: number
  error?: string
}

export class StreamingContext {
  inputTokens = 0
  outputTokens = 0
  totalTokens = 0
  totalCost = 0
  chunks: string[] = []
  startTime = Date.now()
  cancelled = false

  addChunk(token: string): void {
    if (this.cancelled) return
    this.chunks.push(token)
    this.outputTokens += 1 // rough estimate
  }

  getFullContent(): string {
    return this.chunks.join('')
  }

  getDuration(): number {
    return Date.now() - this.startTime
  }

  cancel(): void {
    this.cancelled = true
  }

  stats() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      totalCost: this.totalCost,
      durationMs: this.getDuration(),
      tokenPerSecond: this.totalTokens / (this.getDuration() / 1000),
    }
  }
}

export class StreamLogger {
  private events: StreamEvent[] = []

  log(event: StreamEvent): void {
    this.events.push({
      ...event,
      type: event.type,
    })
  }

  getEvents(): StreamEvent[] {
    return [...this.events]
  }

  clear(): void {
    this.events = []
  }

  summary() {
    return {
      totalEvents: this.events.length,
      tokenEvents: this.events.filter(e => e.type === 'token').length,
      costEvents: this.events.filter(e => e.type === 'cost').length,
      errors: this.events.filter(e => e.type === 'error'),
    }
  }
}

/**
 * Wraps an AsyncIterator from OpenAI streaming and tracks context
 */
export async function* trackingStream(
  stream: AsyncIterable<any>,
  context: StreamingContext,
  logger: StreamLogger
): AsyncGenerator<string, void, unknown> {
  logger.log({ type: 'start' })

  try {
    for await (const event of stream) {
      if (context.cancelled) break

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const token = event.delta.text
        context.addChunk(token)
        logger.log({ type: 'token', token })
        yield token
      }

      if (event.type === 'message_stop') {
        logger.log({
          type: 'stop',
          outputTokens: context.outputTokens,
          inputTokens: context.inputTokens,
        })
      }

      if (event.type === 'message_delta' && event.usage) {
        context.inputTokens = event.usage.input_tokens || 0
        context.outputTokens = event.usage.output_tokens || 0
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.log({ type: 'error', error: errorMsg })
    throw error
  }
}
