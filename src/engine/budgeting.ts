/**
 * Token Budgeting & Cost Tracking
 * Limits tokens per conversation/user, tracks LLM costs.
 */

export interface Budget {
  userId: string
  chatId: string
  tokenLimit: number
  tokenUsed: number
  costLimit?: number // $ per chat, optional
  costUsed?: number
  createdAt: number
  expiresAt?: number // optional TTL
}

export interface TokenEstimate {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number
}

const PRICING = {
  'gpt-5': {
    input: 0.03 / 1000, // $0.03 per 1K tokens
    output: 0.06 / 1000,
  },
  'gpt-4': {
    input: 0.03 / 1000,
    output: 0.06 / 1000,
  },
  'gpt-4-turbo': {
    input: 0.01 / 1000,
    output: 0.03 / 1000,
  },
} as const

export class TokenBudget {
  private budgets = new Map<string, Budget>() // key: chatId

  createBudget(userId: string, chatId: string, tokenLimit = 100000): Budget {
    const budget: Budget = {
      userId,
      chatId,
      tokenLimit,
      tokenUsed: 0,
      createdAt: Date.now(),
    }
    this.budgets.set(chatId, budget)
    return budget
  }

  getBudget(chatId: string): Budget | null {
    return this.budgets.get(chatId) || null
  }

  recordUsage(chatId: string, inputTokens: number, outputTokens: number): void {
    const budget = this.budgets.get(chatId)
    if (!budget) return

    const total = inputTokens + outputTokens
    budget.tokenUsed += total

    if (budget.tokenUsed > budget.tokenLimit) {
      throw new Error(
        `Token budget exceeded for chat ${chatId}: ${budget.tokenUsed} > ${budget.tokenLimit}`
      )
    }
  }

  estimateCost(inputTokens: number, outputTokens: number, model = 'gpt-5'): TokenEstimate {
    const pricing = PRICING[model as keyof typeof PRICING] || PRICING['gpt-5']
    const inputCost = inputTokens * pricing.input
    const outputCost = outputTokens * pricing.output
    const total = inputTokens + outputTokens

    return {
      inputTokens,
      outputTokens,
      totalTokens: total,
      estimatedCost: inputCost + outputCost,
    }
  }

  getProgress(chatId: string) {
    const budget = this.budgets.get(chatId)
    if (!budget) return null

    return {
      tokenUsed: budget.tokenUsed,
      tokenLimit: budget.tokenLimit,
      percentageUsed: (budget.tokenUsed / budget.tokenLimit) * 100,
      remaining: budget.tokenLimit - budget.tokenUsed,
    }
  }

  clearExpired(): void {
    const now = Date.now()
    for (const [chatId, budget] of this.budgets) {
      if (budget.expiresAt && budget.expiresAt < now) {
        this.budgets.delete(chatId)
      }
    }
  }
}
