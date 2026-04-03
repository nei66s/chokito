// Task Decomposer: Breaks down complex tasks into subtasks
// And synthesizes results back into coherent responses

export interface DecompositionResult {
  subtasks: string[];
  reasoning: string;
  detectedSkills?: string[];
  suggestedSpecialties?: string[];
}

export interface SynthesisResult {
  response: string;
  sourceCitations: Map<string, string>;
  confidence: number;
}

export class TaskDecomposer {
  private tokenLimit: number;

  constructor(tokenLimit: number = 2000) {
    this.tokenLimit = tokenLimit;
  }

  /**
   * Decompose a complex user message into independent subtasks
   * Each subtask can be handled by a specialized worker
   */
  async decompose(userMessage: string): Promise<string[]> {
    const keywords = this.extractKeywords(userMessage);
    const detectedSkills = this.detectSkills(userMessage);
    const subtasks = this.generateSubtasks(userMessage, keywords, detectedSkills);

    return subtasks;
  }

  /**
   * Detect technical skills from message
   */
  detectSkills(message: string): string[] {
    const lowerMsg = message.toLowerCase();
    const skillKeywords: Record<string, string[]> = {
      'typescript': ['typescript', 'ts', '@types'],
      'javascript': ['javascript', 'js', 'node', 'npm', 'package.json'],
      'security': ['security', 'vulnerability', 'secure', 'encrypt', 'auth', 'permission'],
      'performance': ['optimize', 'performance', 'profil', 'benchmark', 'latency', 'throughput'],
      'database': ['database', 'sql', 'postgres', 'mysql', 'mongodb', 'query', 'schema'],
      'testing': ['test', 'unit test', 'jest', 'mocha', 'cypress', 'e2e'],
      'api': ['api', 'rest', 'endpoint', 'graphql', 'openapi', 'swagger'],
      'documentation': ['document', 'readme', 'spec', 'guide', 'tutorial', 'example'],
      'refactoring': ['refactor', 'cleanup', 'improve', 'modernize', 'simplify']
    };

    const detectedSkills: string[] = [];
    for (const [skill, keywords] of Object.entries(skillKeywords)) {
      if (keywords.some(kw => lowerMsg.includes(kw))) {
        detectedSkills.push(skill);
      }
    }

    return detectedSkills;
  }

  /**
   * Map detected skills to worker specialties
   */
  mapSkillsToSpecialties(skills: string[]): string[] {
    const skillToSpecialty: Record<string, string> = {
      'typescript': 'code-expert',
      'javascript': 'code-expert',
      'testing': 'code-expert',
      'refactoring': 'code-expert',
      'api': 'code-expert',
      'security': 'security-specialist',
      'performance': 'performance-optimizer',
      'database': 'data-analyst',
      'documentation': 'documentation-writer',
    };

    const specialties = new Set<string>();
    for (const skill of skills) {
      const specialty = skillToSpecialty[skill];
      if (specialty) {
        specialties.add(specialty);
      }
    }

    return Array.from(specialties);
  }

  /**
   * Synthesize results from multiple workers into a single response
   */
  async synthesize(userMessage: string, workerResults: Map<string, string>): Promise<string> {
    if (workerResults.size === 0) {
      return 'No results returned from workers.';
    }

    // Combine results with logical structure
    const synthesisPrompt = this.buildSynthesisPrompt(userMessage, workerResults);
    const synthesis = this.combineSynthesis(synthesisPrompt, workerResults);

    return synthesis;
  }

  /**
   * Extract key concepts from the user message
   */
  private extractKeywords(message: string): string[] {
    // Simple keyword extraction
    const commonStopwords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'from',
    ]);

    const words = message
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3 && !commonStopwords.has(word));

    return Array.from(new Set(words)).slice(0, 5);
  }

  /**
   * Generate subtasks based on message analysis
   */
  private generateSubtasks(userMessage: string, keywords: string[], detectedSkills: string[]): string[] {
    const subtasks: string[] = [];

    // Heuristic: detect task types
    if (
      userMessage.toLowerCase().includes('code') ||
      userMessage.toLowerCase().includes('implement')
    ) {
      subtasks.push('Analyze code requirements and design solution');
      subtasks.push('Implement the code');
    }

    if (
      userMessage.toLowerCase().includes('security') ||
      userMessage.toLowerCase().includes('secure')
    ) {
      subtasks.push('Evaluate security implications');
      subtasks.push('Recommend security best practices');
    }

    if (
      userMessage.toLowerCase().includes('performance') ||
      userMessage.toLowerCase().includes('optimize')
    ) {
      subtasks.push('Identify performance bottlenecks');
      subtasks.push('Propose optimization strategies');
    }

    if (
      userMessage.toLowerCase().includes('document') ||
      userMessage.toLowerCase().includes('explain')
    ) {
      subtasks.push('Document findings and explanations');
    }

    // If no specific subtasks, create a general analysis task
    if (subtasks.length === 0) {
      subtasks.push(`Analyze: ${userMessage}`);
    }

    return subtasks;
  }

  /**
   * Build a synthesis prompt from worker results
   */
  private buildSynthesisPrompt(
    originalMessage: string,
    workerResults: Map<string, string>,
  ): string {
    const resultsText = Array.from(workerResults.entries())
      .map(([workerId, result]) => `From [${workerId}]: ${result}`)
      .join('\n\n');

    return `Original request: ${originalMessage}\n\nWorker results:\n${resultsText}\n\nSynthesize into a coherent, comprehensive response.`;
  }

  /**
   * Combine multiple worker results into a single response
   */
  private combineSynthesis(synthesisPrompt: string, workerResults: Map<string, string>): string {
    // Simple concatenation with headers
    // In production: use Claude for actual synthesis

    const synthesis: string[] = [];

    for (const [workerId, result] of workerResults.entries()) {
      synthesis.push(`## Analysis from ${workerId}`);
      synthesis.push(result);
      synthesis.push('');
    }

    return synthesis.join('\n');
  }

  /**
   * Estimate token usage for a task
   */
  estimateTokens(task: string): number {
    // Rough estimate: ~4 characters per token
    // In production: use actual tokenizer
    return Math.ceil(task.length / 4);
  }

  /**
   * Check if task exceeds token limit
   */
  exceedsTokenLimit(task: string): boolean {
    return this.estimateTokens(task) > this.tokenLimit;
  }

  /**
   * Get decomposer configuration
   */
  getConfig() {
    return {
      tokenLimit: this.tokenLimit,
      strategy: 'heuristic-based',
    };
  }
}

export default TaskDecomposer;
