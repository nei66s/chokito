// Worker Pool: Manages specialized agent workers
// Each worker is a specialized agent (e.g., CodeExpert, DataAnalyst, SecuritySpecialist)

export interface Worker {
  id: string;
  name: string;
  specialty: WorkerSpecialty;
  isAvailable: boolean;
  currentTask: string | null;
  skillset: string[];
  process: (message: string, conversationId: string) => Promise<string>;
}

export type WorkerSpecialty =
  | 'code-expert'
  | 'data-analyst'
  | 'security-specialist'
  | 'performance-optimizer'
  | 'documentation-writer'
  | 'general-assistant';

export class WorkerPool {
  private workers: Map<string, Worker> = new Map();
  private maxWorkers: number;
  private specialties: Map<WorkerSpecialty, string[]> = new Map();

  constructor(maxWorkers: number) {
    this.maxWorkers = maxWorkers;
    this.initializeDefaultWorkers();
  }

  private initializeDefaultWorkers(): void {
    const createWorkerProcessor = (specialty: WorkerSpecialty) => {
      return async (message: string, conversationId: string): Promise<string> => {
        // Placeholder: will integrate with actual LLM in server.ts
        // For now, return a structured response based on specialty
        return `[${specialty}] Processing: ${message.substring(0, 50)}...`;
      };
    };

    const defaultWorkers: Worker[] = [
      {
        id: 'worker-code',
        name: 'Code Expert',
        specialty: 'code-expert',
        isAvailable: true,
        currentTask: null,
        skillset: ['typescript', 'javascript', 'debugging', 'refactoring'],
        process: createWorkerProcessor('code-expert'),
      },
      {
        id: 'worker-data',
        name: 'Data Analyst',
        specialty: 'data-analyst',
        isAvailable: true,
        currentTask: null,
        skillset: ['sql', 'statistics', 'visualization', 'data-validation'],
        process: createWorkerProcessor('data-analyst'),
      },
      {
        id: 'worker-security',
        name: 'Security Specialist',
        specialty: 'security-specialist',
        isAvailable: true,
        currentTask: null,
        skillset: ['secure-coding', 'vulnerability-detection', 'compliance', 'encryption'],
        process: createWorkerProcessor('security-specialist'),
      },
      {
        id: 'worker-perf',
        name: 'Performance Optimizer',
        specialty: 'performance-optimizer',
        isAvailable: true,
        currentTask: null,
        skillset: ['profiling', 'optimization', 'benchmarking', 'memory-management'],
        process: createWorkerProcessor('performance-optimizer'),
      },
      {
        id: 'worker-docs',
        name: 'Documentation Writer',
        specialty: 'documentation-writer',
        isAvailable: true,
        currentTask: null,
        skillset: ['technical-writing', 'api-docs', 'guides', 'examples'],
        process: createWorkerProcessor('documentation-writer'),
      },
      {
        id: 'worker-general',
        name: 'General Assistant',
        specialty: 'general-assistant',
        isAvailable: true,
        currentTask: null,
        skillset: ['general-knowledge', 'task-coordination', 'fallback-handling'],
        process: createWorkerProcessor('general-assistant'),
      },
    ];

    for (const worker of defaultWorkers) {
      this.workers.set(worker.id, worker);
      const specialtyWorkers = this.specialties.get(worker.specialty) || [];
      specialtyWorkers.push(worker.id);
      this.specialties.set(worker.specialty, specialtyWorkers);
    }
  }

  /**
   * Acquire an available worker for a task
   * Returns null if no workers available
   */
  acquireWorker(preferredSpecialty?: WorkerSpecialty): Worker | null {
    if (preferredSpecialty) {
      const workerIds = this.specialties.get(preferredSpecialty) || [];
      for (const workerId of workerIds) {
        const worker = this.workers.get(workerId);
        if (worker && worker.isAvailable) {
          worker.isAvailable = false;
          return worker;
        }
      }
    }

    // Fallback: return any available worker
    for (const worker of this.workers.values()) {
      if (worker.isAvailable) {
        worker.isAvailable = false;
        return worker;
      }
    }

    return null;
  }

  /**
   * Release worker back to pool
   */
  releaseWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.isAvailable = true;
      worker.currentTask = null;
      return true;
    }
    return false;
  }

  /**
   * Assign a task to a worker
   */
  assignTask(workerId: string, taskName: string): boolean {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentTask = taskName;
      return true;
    }
    return false;
  }

  /**
   * Get metrics about worker pool
   */
  getAvailableWorkerCount(): number {
    return Array.from(this.workers.values()).filter((w) => w.isAvailable).length;
  }

  getAllWorkers(): Worker[] {
    return Array.from(this.workers.values());
  }

  getWorkersBySpecialty(specialty: WorkerSpecialty): Worker[] {
    const workerIds = this.specialties.get(specialty) || [];
    return workerIds.map((id) => this.workers.get(id)!).filter(Boolean);
  }

  getPoolStats() {
    const total = this.workers.size;
    const available = this.getAvailableWorkerCount();
    const busy = total - available;

    return {
      total,
      available,
      busy,
      utilization: (busy / total) * 100,
      workersBySpecialty: Object.fromEntries(
        Array.from(this.specialties.entries()).map(([specialty, workerIds]) => [
          specialty,
          workerIds.length,
        ]),
      ),
    };
  }
}

export default WorkerPool;
