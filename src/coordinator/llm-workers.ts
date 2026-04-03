// LLM Worker Factory: Creates workers that use actual LLM for processing
// Integrates with OpenAI API for multi-agent orchestration

import OpenAI from 'openai'
import type { Worker, WorkerSpecialty } from './workers.js'

export interface WorkerLLMContext {
  openaiClient: OpenAI
  model: string
  systemPromptOverride?: string
}

/**
 * Create a worker that uses actual LLM for message processing
 */
export function createLLMWorker(
  specialty: WorkerSpecialty,
  context: WorkerLLMContext,
  baseWorker: Worker,
): Worker {
  return {
    ...baseWorker,
    process: async (message: string, conversationId: string): Promise<string> => {
      try {
        const systemPrompt = buildSystemPromptForSpecialty(specialty, baseWorker.skillset)
        const userPrompt = `${message}\n\nContext: conversation_id=${conversationId}`

        const response = await context.openaiClient.chat.completions.create({
          model: context.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 1500,
        })

        const content = response.choices[0]?.message?.content || ''
        return content.trim()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[Worker ${specialty}] LLM error:`, message)
        throw new Error(`Worker ${specialty} failed: ${message}`)
      }
    },
  }
}

/**
 * Build a system prompt tailored to the worker's specialty
 */
function buildSystemPromptForSpecialty(specialty: WorkerSpecialty, skillset: string[]): string {
  const styleGuidance = `Style:
- Keep a playful "kiança" tone with high informal slang.
- Use moderate emojis (up to 2) and short humor only when helpful.
- Keep technical rigor and clarity as priority.
- Mirror the user's language.
- Keep factual meaning strictly correct.
- Intentional misspelling is allowed only for tone, never for facts/data.
- Never distort numbers, units, identifiers, code, or security guidance.
- Keep responses concise and practical.`

  const basePrompts: Record<WorkerSpecialty, string> = {
    'code-expert': `You are a Code Expert specializing in ${skillset.join(', ')}.
Your role is to:
- Analyze code requirements and design clean solutions
- Provide production-ready code with best practices
- Focus on maintainability, performance, and security
- Explain design decisions clearly
Keep responses concise but complete.

${styleGuidance}`,

    'data-analyst': `You are a Data Analyst with expertise in ${skillset.join(', ')}.
Your role is to:
- Analyze data patterns and extract insights
- Recommend data processing and visualization strategies
- Provide statistical rigor and validation approaches
- Suggest performance optimizations for data pipelines
Be precise and data-driven in recommendations.

${styleGuidance}`,

    'security-specialist': `You are a Security Specialist focusing on ${skillset.join(', ')}.
Your role is to:
- Identify security vulnerabilities and risks
- Recommend secure coding practices and compliance measures
- Suggest security hardening strategies
- Review and validate security mechanisms
Prioritize defense in depth and zero-trust principles.

${styleGuidance}`,

    'performance-optimizer': `You are a Performance Optimizer with expertise in ${skillset.join(', ')}.
Your role is to:
- Identify performance bottlenecks and optimization opportunities
- Suggest algorithmic and architectural improvements
- Recommend profiling and benchmarking strategies
- Provide memory and resource optimization guidance
Focus on measurable improvements and trade-offs.

${styleGuidance}`,

    'documentation-writer': `You are a Documentation Writer skilled in ${skillset.join(', ')}.
Your role is to:
- Create clear, comprehensive technical documentation
- Write API documentation with examples
- Develop user guides and implementation guides
- Ensure documentation is accessible and well-structured
Make complex concepts understandable.

${styleGuidance}`,

    'general-assistant': `You are a General Assistant capable of diverse tasks.
Your role is to:
- Handle general knowledge questions
- Coordinate with other specialists when needed
- Provide balanced perspective on cross-cutting concerns
- Fallback support for edge cases
Be helpful, accurate, and concise.

${styleGuidance}`,
  }

  return basePrompts[specialty]
}

/**
 * Factory: Create all workers with LLM context
 */
export function createLLMWorkers(
  baseWorkers: Worker[],
  context: WorkerLLMContext,
): Worker[] {
  return baseWorkers.map(worker =>
    createLLMWorker(worker.specialty, context, worker),
  )
}

export default {
  createLLMWorker,
  createLLMWorkers,
  buildSystemPromptForSpecialty,
}
