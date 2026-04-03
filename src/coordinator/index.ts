// Coordinator: Multi-agent orchestration
// Dispatches complex tasks to specialized worker agents

import { WorkerPool } from './workers.js';
import { MessageRouter } from './routing.js';
import { TaskDecomposer } from './tasks.js';
import { createLLMWorkers, type WorkerLLMContext } from './llm-workers.js';
import { RetryOrchestrator, type RetryConfig } from './fallback.js';

export interface CoordinatorConfig {
  maxWorkers: number;
  taskDecompositionTokenLimit: number;
  routingStrategy: 'round-robin' | 'least-busy' | 'skill-match';
  retryConfig?: RetryConfig;
}

export interface CoordinatedTask {
  id: string;
  userMessage: string;
  decomperatedSubtasks: Subtask[];
  synthesis: string | null;
  completedAt: Date | null;
}

export interface Subtask {
  id: string;
  description: string;
  assignedWorkerId: string | null;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  result: string | null;
  error: string | null;
}

export class Coordinator {
  private workerPool: WorkerPool;
  private router: MessageRouter;
  private decomposer: TaskDecomposer;
  private retryOrchestrator: RetryOrchestrator;
  private activeCoordinatedTasks: Map<string, CoordinatedTask> = new Map();
  private config: CoordinatorConfig;
  private llmEnabled: boolean = false;

  constructor(config: CoordinatorConfig) {
    this.config = config;
    this.workerPool = new WorkerPool(config.maxWorkers);
    this.router = new MessageRouter(config.routingStrategy);
    this.decomposer = new TaskDecomposer(config.taskDecompositionTokenLimit);
      this.retryOrchestrator = new RetryOrchestrator(this.workerPool);
  }

  /**
   * Enable LLM context for all workers
   * Call this after creating the Coordinator to activate real LLM processing
   */
  enableLLMContext(context: WorkerLLMContext): void {
    const allWorkers = this.workerPool.getAllWorkers();
    const llmWorkers = createLLMWorkers(allWorkers, context);

    // Update worker pool with LLM-enabled workers
    for (const worker of llmWorkers) {
      // Update the worker in the pool by replacing its process method
      const existingWorker = this.workerPool.getAllWorkers().find(w => w.id === worker.id);
      if (existingWorker) {
        existingWorker.process = worker.process;
      }
    }

    this.llmEnabled = true;
    console.log('[Coordinator] LLM context enabled for all workers');
  }

  isLLMEnabled(): boolean {
    return this.llmEnabled;
  }

  /**
   * Orchestrate a complex user request across worker agents
   * 1. Decompose into subtasks
   * 2. Route to appropriate workers
   * 3. Wait for results
   * 4. Synthesize final response
   */
  async orchestrateTask(userMessage: string, conversationId: string): Promise<string> {
    const taskId = this.generateTaskId();
    console.log(`[Coordinator] Starting task ${taskId}:`, userMessage);

    // Step 1: Decompose task into subtasks
    const subtasks = await this.decomposer.decompose(userMessage);
    console.log(`[Coordinator] Decomposed into ${subtasks.length} subtasks`);

    const coordinatedTask: CoordinatedTask = {
      id: taskId,
      userMessage,
      decomperatedSubtasks: subtasks.map((desc, idx) => ({
        id: `${taskId}-subtask-${idx}`,
        description: desc,
        assignedWorkerId: null,
        status: 'pending',
        result: null,
        error: null,
      })),
      synthesis: null,
      completedAt: null,
    };

    this.activeCoordinatedTasks.set(taskId, coordinatedTask);

    try {
      // Step 2 & 3: Assign and execute subtasks
      const subtaskResults = await this.executeSubtasks(
        coordinatedTask.decomperatedSubtasks,
        conversationId,
      );

      // Step 4: Synthesize results
      const synthesis = await this.decomposer.synthesize(userMessage, subtaskResults);

      coordinatedTask.synthesis = synthesis;
      coordinatedTask.completedAt = new Date();

      console.log(`[Coordinator] Task ${taskId} completed`);
      return synthesis;
    } catch (error) {
      console.error(`[Coordinator] Task ${taskId} failed:`, error);
      throw new Error(`Coordination failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async executeSubtasks(
    subtasks: Subtask[],
    conversationId: string,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    const executionPromises = subtasks.map(async (subtask) => {
      try {
        subtask.status = 'in-progress';

        // Detect skills from subtask description for smart worker assignment
        const subtaskSkills = this.decomposer.detectSkills(subtask.description);
        const specialties = this.decomposer.mapSkillsToSpecialties(subtaskSkills);
        const preferredSpecialty = specialties[0] as any || undefined;

          // Execute with fallback and retry logic
          const fallbackResult = await this.retryOrchestrator.executeWithFallback(
            subtask.description,
            preferredSpecialty,
            this.config.retryConfig
          );

          if (fallbackResult.success && fallbackResult.result) {
            // Route through message router for context
            const worker = fallbackResult.lastWorker;
            if (worker) {
              subtask.assignedWorkerId = worker.id;
            }
            subtask.result = fallbackResult.result;
            subtask.status = 'completed';
            results.set(subtask.id, fallbackResult.result);
            console.log(
              `[Coordinator] Subtask ${subtask.id} completed ` +
              `(attempts: ${fallbackResult.attemptsUsed}, fallbacks: ${fallbackResult.workersTriedCount})`
            );
          } else {
            throw new Error(fallbackResult.error || 'Unknown fallback error');
          }
      } catch (error) {
        subtask.status = 'failed';
        subtask.error = error instanceof Error ? error.message : String(error);
        console.error(`[Coordinator] Subtask ${subtask.id} failed:`, subtask.error);
      }
    });

    await Promise.all(executionPromises);
    return results;
  }

  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  getCoordinatedTask(taskId: string): CoordinatedTask | undefined {
    return this.activeCoordinatedTasks.get(taskId);
  }

  getLastCoordinatedTask(): CoordinatedTask | undefined {
    let lastTask: CoordinatedTask | undefined;
    let lastTime = 0;

    for (const task of this.activeCoordinatedTasks.values()) {
      const taskTime = parseInt(task.id.split('-')[1] || '0');
      if (taskTime > lastTime) {
        lastTime = taskTime;
        lastTask = task;
      }
    }

    return lastTask;
  }

  getAllCoordinatedTasks(): CoordinatedTask[] {
    return Array.from(this.activeCoordinatedTasks.values());
  }

  getCoordinatorStats() {
    return {
      activeTasks: this.activeCoordinatedTasks.size,
      availableWorkers: this.workerPool.getAvailableWorkerCount(),
      totalWorkers: this.config.maxWorkers,
    };
  }

    getRetryStats() {
      return this.retryOrchestrator.getStats();
    }
}

export default Coordinator;
