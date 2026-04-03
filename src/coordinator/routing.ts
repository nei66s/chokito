// Message Router: Routes messages to workers based on skill match and availability
// Strategies: round-robin, least-busy, skill-match

import type { Worker, WorkerSpecialty } from './workers';

export interface RoutingContext {
  message: string;
  workerSpecialty?: WorkerSpecialty;
  requiredSkills?: string[];
  priority?: 'low' | 'normal' | 'high';
}

export interface RoutedMessage {
  id: string;
  originalMessage: string;
  contextualPrompt: string;
  targetWorker: Worker;
  createdAt: Date;
}

export class MessageRouter {
  private strategy: 'round-robin' | 'least-busy' | 'skill-match';
  private roundRobinIndex: number = 0;
  private routingHistory: RoutedMessage[] = [];

  constructor(strategy: 'round-robin' | 'least-busy' | 'skill-match' = 'skill-match') {
    this.strategy = strategy;
  }

  /**
   * Route a message to the best worker based on strategy
   */
  routeMessage(message: string, availableWorker: Worker, context?: RoutingContext): RoutedMessage {
    // Build contextual prompt based on worker specialty
    const contextualPrompt = this.buildContextualPrompt(message, availableWorker);

    const routedMessage: RoutedMessage = {
      id: `routed-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      originalMessage: message,
      contextualPrompt,
      targetWorker: availableWorker,
      createdAt: new Date(),
    };

    this.routingHistory.push(routedMessage);
    return routedMessage;
  }

  /**
   * Build a contextual prompt tailored to the worker's specialty
   * This enhances the message with role-specific instructions
   */
  private buildContextualPrompt(message: string, worker: Worker): string {
      const styleGuidance = 'Use playful kiança tone with high informal slang, moderate emojis (up to 2), and clear technical answers. Keep factual meaning strictly correct; tone can vary but facts cannot.';

    const specialtyPrompts: Record<WorkerSpecialty, string> = {
      'code-expert': `You are a Code Expert specializing in ${worker.skillset.join(', ')}. 
Provide clean, maintainable code solutions with explanations.
  Focus on best practices, design patterns, and code quality.
  ${styleGuidance}`,

      'data-analyst': `You are a Data Analyst with expertise in ${worker.skillset.join(', ')}.
  Provide insights through data analysis, visualization recommendations, and statistical rigor.
  ${styleGuidance}`,

      'security-specialist': `You are a Security Specialist focusing on ${worker.skillset.join(', ')}.
  Identify vulnerabilities, recommend security best practices, and ensure compliance.
  ${styleGuidance}`,

      'performance-optimizer': `You are a Performance Optimizer with skills in ${worker.skillset.join(', ')}.
  Identify bottlenecks, suggest optimizations, and provide benchmarking guidance.
  ${styleGuidance}`,

      'documentation-writer': `You are a Documentation Writer skilled in ${worker.skillset.join(', ')}.
  Create clear, comprehensive, and well-structured documentation.
  ${styleGuidance}`,

      'general-assistant': `You are a General Assistant capable of handling diverse tasks.
  Coordinate with other specialists when needed and provide thoughtful responses.
  ${styleGuidance}`,
    };

    const rolePrompt = specialtyPrompts[worker.specialty];
    return `${rolePrompt}\n\nTask: ${message}`;
  }

  /**
   * Select worker based on routing strategy
   */
  selectWorkerByStrategy(
    availableWorkers: Worker[],
    strategy?: 'round-robin' | 'least-busy' | 'skill-match',
  ): Worker | null {
    if (availableWorkers.length === 0) return null;

    const selectedStrategy = strategy || this.strategy;

    switch (selectedStrategy) {
      case 'round-robin':
        return this.selectByRoundRobin(availableWorkers);

      case 'least-busy':
        return this.selectByLeastBusy(availableWorkers);

      case 'skill-match':
      default:
        // Default: return first available (skill matching would need context)
        return availableWorkers[0];
    }
  }

  private selectByRoundRobin(workers: Worker[]): Worker {
    const selected = workers[this.roundRobinIndex % workers.length];
    this.roundRobinIndex++;
    return selected;
  }

  private selectByLeastBusy(workers: Worker[]): Worker {
    // Simplified: return first available (all have isAvailable = true)
    // In production: track task queue depth per worker
    return workers[0];
  }

  /**
   * Get routing analytics
   */
  getRoutingStats() {
    const routingBySpecialty = new Map<WorkerSpecialty, number>();

    for (const routed of this.routingHistory) {
      const count = routingBySpecialty.get(routed.targetWorker.specialty) || 0;
      routingBySpecialty.set(routed.targetWorker.specialty, count + 1);
    }

    return {
      totalRouted: this.routingHistory.length,
      routingBySpecialty: Object.fromEntries(routingBySpecialty),
      currentStrategy: this.strategy,
    };
  }
}

export default MessageRouter;
