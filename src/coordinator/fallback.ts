/**
 * Fallback & Retry Logic for Coordinator
 * Implements exponential backoff, worker fallback chains, and graceful degradation
 */

import { Worker, WorkerPool } from './workers';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

export interface FallbackResult {
  success: boolean;
  result?: string;
  error?: string;
  attemptsUsed: number;
  workersTriedCount: number;
  lastWorker?: Worker;
  retryHistory: RetryAttempt[];
}

export interface RetryAttempt {
  attempt: number;
  workerId: string;
  workerSpecialty: string;
  error: string;
  delayMs: number;
  timestamp: Date;
}

export class RetryOrchestrator {
  private defaultConfig: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
  };

  constructor(private pool: WorkerPool) {}

  async executeWithFallback(
    message: string,
    preferredSpecialty?: string,
    config: Partial<RetryConfig> = {}
  ): Promise<FallbackResult> {
    const cfg = { ...this.defaultConfig, ...config };
    const history: RetryAttempt[] = [];
    let attempt = 0;
    let lastError = '';

    // Step 1: Try preferred specialty multiple times
    if (preferredSpecialty) {
      const result = await this.retryWithSpecialty(message, preferredSpecialty, cfg, history);
      if (result.success) return result;
      lastError = result.error || 'Unknown error';
      attempt = result.attemptsUsed;
    }

    // Step 2: Try fallback specialties
    const fallbackSpecialties = this.getAdjacentSpecialties(preferredSpecialty);
    for (const specialty of fallbackSpecialties) {
      const result = await this.retryWithSpecialty(message, specialty, { ...cfg, maxRetries: 1 }, history);
      if (result.success) return result;
      lastError = result.error || 'Unknown error';
    }

    // Step 3: Try general-assistant
    const generalResult = await this.retryWithSpecialty(message, 'general-assistant', { ...cfg, maxRetries: 1 }, history);
    if (generalResult.success) return generalResult;

    // All attempts exhausted
    return {
      success: false,
      error: `All fallback chains exhausted. Last error: ${lastError}`,
      attemptsUsed: attempt,
      workersTriedCount: history.length,
      retryHistory: history,
    };
  }

  private async retryWithSpecialty(
    message: string,
    specialty: string,
    config: RetryConfig,
    history: RetryAttempt[]
  ): Promise<FallbackResult> {
    let lastError = '';
    let lastWorker: Worker | undefined;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        // Acquire worker
        const worker = this.pool.acquireWorker(specialty as any);
        if (!worker) {
          lastError = `No available workers for specialty: ${specialty}`;
          continue;
        }

        lastWorker = worker;

        // Execute task
        try {
          const result = await worker.process(message, `${specialty}-${Date.now()}`);
          this.pool.releaseWorker(worker.id);
          return {
            success: true,
            result,
            attemptsUsed: attempt + 1,
            workersTriedCount: history.length,
            lastWorker,
            retryHistory: history,
          };
        } catch (err) {
          this.pool.releaseWorker(worker.id);
          lastError = String(err);
          throw err;
        }
      } catch (err) {
        lastError = String(err);
        const delayMs = this.calculateBackoffDelay(attempt, config);
        history.push({
          attempt: attempt + 1,
          workerId: lastWorker?.id || 'unknown',
          workerSpecialty: specialty,
          error: lastError,
          delayMs,
          timestamp: new Date(),
        });
        if (attempt < config.maxRetries) {
          await this.delay(delayMs);
        }
      }
    }

    return {
      success: false,
      error: lastError,
      attemptsUsed: config.maxRetries + 1,
      workersTriedCount: history.length,
      lastWorker,
      retryHistory: history,
    };
  }

  private getAdjacentSpecialties(preferred?: string): string[] {
    const map: Record<string, string[]> = {
      'code-expert': ['security-specialist', 'performance-optimizer'],
      'security-specialist': ['code-expert', 'data-analyst'],
      'performance-optimizer': ['code-expert', 'data-analyst'],
      'data-analyst': ['security-specialist', 'documentation-writer'],
      'documentation-writer': ['code-expert', 'general-assistant'],
    };
    if (!preferred) {
      return ['code-expert', 'security-specialist', 'performance-optimizer', 'data-analyst', 'documentation-writer'];
    }
    return map[preferred] || ['code-expert', 'data-analyst', 'general-assistant'];
  }

  private calculateBackoffDelay(attempt: number, config: RetryConfig): number {
    if (attempt === 0) return 0;
    const exponentialDelay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
    const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
    return Math.ceil(Math.max(0, cappedDelay + jitter));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      config: this.defaultConfig,
      poolStats: this.pool.getPoolStats(),
    };
  }
}

export class BatchRetryExecutor {
  constructor(private retryOrchestrator: RetryOrchestrator, private config: RetryConfig) {}

  async executeBatchWithFallback(
    subtasks: Array<{ id: string; message: string; preferredSpecialty?: string }>
  ): Promise<Map<string, FallbackResult>> {
    const results = new Map<string, FallbackResult>();
    const promises = subtasks.map(async (task) => {
      const result = await this.retryOrchestrator.executeWithFallback(task.message, task.preferredSpecialty, this.config);
      results.set(task.id, result);
    });
    await Promise.all(promises);
    return results;
  }
}
