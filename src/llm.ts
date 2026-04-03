import dotenv from 'dotenv'
import OpenAI from 'openai'
import fetch from 'node-fetch'
import { runTool, toolDefinitions, type PermissionMode } from './tools.js'
import {
  LRUCache,
  TokenBudget,
  ConversationCompactor,
  StreamingContext,
  StreamLogger,
  trackingStream,
  type Message as CompactionMessage,
} from './engine/index.js'
import { contextAssembler, type SystemInjection } from './engine/contextAssembly.js'
import { recordTokenCost } from './db.js'
import { coordinator } from './server.js'

dotenv.config()

const OPENAI_KEY = process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_MODEL || 'gpt-5'
const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 6)

// === Engine Instances ===
export const fileCache = new LRUCache(10 * 1024 * 1024, 1000 * 60 * 30) // 10MB, 30min
export const tokenBudget = new TokenBudget()
export const compactor = new ConversationCompactor()
const SYSTEM_PROMPT = `
You are Chocks, a practical local coding agent.

Personality:
- You have a playful "kiança" vibe: curious, friendly, and cheeky.
- Use high informal slang on purpose, but keep answers understandable.
- Use moderate emojis (up to 2 per response) and only when they help tone.
- Use short humor, puns, and light meme references.
- Optional running gag: "Betinha namoradinha dele" as a rare, harmless joke.
- Keep technical accuracy first, then style.
- Even in critical topics, keep playful tone but make instructions unambiguous.
- Never use humor that hides risk, steps, constraints, or final answer.
- Mirror the user's language (Portuguese/English) by default.
- Keep factual meaning strictly correct at all times.
- You may misspell words intentionally for flavor, but never change facts.
- For direct factual questions, state the correct fact first, then playful wording.
- Never distort numbers, units, names, commands, file paths, API fields, or code.

Family canon facts (must stay consistent):
- Betinha is central in this family lore.
- Chocks's sogro: Valdinei.
- Chocks's sogrinha: Rafaela.
- Betinha's siblings: Pimpim, Bento, Kitty.
- Isa is Pimpim's girlfriend.
- Fabinho is Kitty's boyfriend.
- Friends around the circle: Repeteco, Jorginho, and Tunico (Jorginho's son).
- Never contradict these relationships when chatting.

Priorities:
- Be concrete, useful, and concise.
- Keep default responses short (up to 4 lines) unless the user asks for detail.
- If a request is ambiguous, ask one concise clarifying question before acting.
- Prefer clean formatting: short lines, simple bullets, and clear spacing.
- Avoid dense inline enumerations like "1) ... 2) ... 3) ..." in a single paragraph.
- When asking for continuation/context, end with exactly one direct question.
- Prefer real actions over decorative explanations.
- Use tools when they materially help.
- When a user asks to delete, edit, read, or inspect files inside the workspace, prefer the matching file tools over manual instructions.

Workflow behavior:
- For simple requests, answer directly without creating a workflow.
- For non-trivial tasks with multiple steps, create a short workflow plan before or at the start of execution.
- Use workflow_replace with 3 to 7 steps.
- Keep exactly one step in_progress when work is active.
- Update step status with workflow_update_step as you progress.
- Use workflow_get to inspect the current plan before changing it when needed.
- Clear the workflow with workflow_clear when the task is fully complete or clearly abandoned.

Planning style:
- Focus on execution, not ceremony.
- Step text should be user-facing and specific.
- Do not create a plan for casual chat or a one-shot factual answer.
`.trim()

type ToolTraceEntry =
  | { type: 'tool_call'; name: string; call_id: string; arguments: string }
  | { type: 'tool_output'; call_id: string; output: string }

type AgentContext = {
  chatId?: string
  userId?: string
  displayName?: string
  fullAccess?: boolean
  permissionMode?: PermissionMode
  latestUserMessage?: string
  approvedTools?: string[]
}

type DynamicToolDefinition = {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

type ToolExecutor = (tool: string, input: any, context?: AgentContext) => Promise<any>

type AgentRuntimeOptions = {
  extraToolDefinitions?: DynamicToolDefinition[]
  executeTool?: ToolExecutor
}

function buildContextInjections(context?: AgentContext): SystemInjection[] {
  const injections: SystemInjection[] = []

  injections.push({
    label: 'chat-id',
    text: context?.chatId ? `Current conversation id: ${context.chatId}` : 'Current conversation id: global',
  })
  injections.push({
    label: 'user-id',
    text: context?.userId ? `Current owner id: ${context.userId}` : 'Current owner id: legacy-local',
  })
  injections.push({
    label: 'fs-mode',
    text: context?.fullAccess
      ? 'Filesystem mode: full computer access enabled by the user.'
      : 'Filesystem mode: restricted to the project workspace.',
  })
  injections.push({
    label: 'permission-mode',
    text:
      context?.permissionMode === 'auto'
        ? 'Permission mode: auto. Enabled tools may run without extra approval checks.'
        : context?.permissionMode === 'read_only'
          ? 'Permission mode: read-only. Do not attempt mutating, shell, or network actions.'
          : 'Permission mode: ask. Reads are allowed, but writes, deletes, shell, and web actions require explicit user intent in the latest message.',
  })
  injections.push({
    label: 'workflow-scope',
    text: 'Workflow tools are scoped to the current conversation automatically.',
  })

  return injections
}

/**
 * Ensure budget exists for this chat, create if needed
 */
function ensureBudget(context?: AgentContext): string {
  const chatId = context?.chatId || 'global'
  if (!tokenBudget.getBudget(chatId)) {
    tokenBudget.createBudget(context?.userId || 'legacy', chatId)
  }
  return chatId
}

/**
 * Record token usage and cost to database (async, non-blocking)
 */
async function logTokenCost(chatId: string, response: any): Promise<void> {
  if (!chatId || !response?.usage) return

  try {
    const inputTokens = response.usage.input_tokens || 0
    const outputTokens = response.usage.output_tokens || 0
    const estimate = tokenBudget.estimateCost(inputTokens, outputTokens, MODEL)

    await recordTokenCost(chatId, inputTokens, outputTokens, estimate.estimatedCost, MODEL)
  } catch (err) {
    // Silently log to avoid breaking the agent
    console.error(`Failed to record token cost for ${chatId}:`, String(err))
  }
}



export async function runAgent(
  messages: Array<{ role: string; content: string }>,
  context?: AgentContext,
  runtime?: AgentRuntimeOptions,
) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set in environment')

  const chatId = ensureBudget(context)
  const allTools = [...toolDefinitions, ...(runtime?.extraToolDefinitions || [])]
  const assembled = await contextAssembler.assembleContext({
    baseSystemPrompt: SYSTEM_PROMPT,
    injections: buildContextInjections(context),
    messages: messages as any,
    tools: allTools,
    permissionMode: context?.permissionMode,
    approvedTools: context?.approvedTools,
    compactor,
  })
  const client = new OpenAI({ apiKey: OPENAI_KEY })
  const trace: ToolTraceEntry[] = []
  const executeTool = runtime?.executeTool || runTool

  // Enable LLM context for coordinator workers if not already enabled
  if (!coordinator.isLLMEnabled()) {
    coordinator.enableLLMContext({
      openaiClient: client,
      model: MODEL,
    })
  }

  let response: any = await client.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: assembled.systemPrompt },
      ...assembled.messages,
    ] as any,
    tools: assembled.tools as any,
    parallel_tool_calls: false,
  })

  // Track tokens if response includes usage
  if (response.usage) {
    try {
      tokenBudget.recordUsage(chatId, response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0)
    } catch (err) {
      console.warn(`Token budget warning: ${String(err)}`)
    }
  }

  for (let i = 0; i < MAX_TOOL_LOOPS; i += 1) {
    const toolCalls: any[] = (response.output || []).filter((item: any) => item.type === 'function_call')
    if (toolCalls.length === 0) {
      // Log cost before returning
      await logTokenCost(chatId, response)
      return { response, trace }
    }

    const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = []
    for (const call of toolCalls) {
      trace.push({
        type: 'tool_call',
        name: call.name,
        call_id: call.call_id,
        arguments: call.arguments || '',
      })
      let args: any = {}
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch (err) {
        const output = JSON.stringify({ ok: false, error: `invalid JSON arguments: ${String(err)}` })
        trace.push({ type: 'tool_output', call_id: call.call_id, output })
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        })
        continue
      }

      try {
        const result = await executeTool(call.name, args, context)
        const output = JSON.stringify(result)
        trace.push({ type: 'tool_output', call_id: call.call_id, output })
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        })
      } catch (err) {
        const output = JSON.stringify({ ok: false, error: String(err) })
        trace.push({ type: 'tool_output', call_id: call.call_id, output })
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        })
      }
    }

    response = await client.responses.create({
      model: MODEL,
      previous_response_id: response.id,
      input: toolOutputs as any,
    })
  }

  // Log cost before returning
  await logTokenCost(chatId, response)
  return { response, trace }
}

type StreamCallbacks = {
  onTextDelta?: (delta: string) => void
  onTrace?: (entry: ToolTraceEntry) => void
}

async function createResponseStream(
  body: Record<string, unknown>,
  callbacks: StreamCallbacks,
) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set in environment')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
  })

  if (!response.ok || !response.body) {
    const text = await response.text()
    throw new Error(`Responses stream failed: ${response.status} ${text}`)
  }

  let buffer = ''
  let completedResponse: any = null

  for await (const chunk of response.body as any) {
    buffer += chunk.toString()

    while (buffer.includes('\n\n')) {
      const boundary = buffer.indexOf('\n\n')
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      const lines = rawEvent.split('\n')
      const dataLines = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
      if (dataLines.length === 0) continue

      const data = dataLines.join('\n')
      if (data === '[DONE]') continue

      let payload: any
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }

      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        callbacks.onTextDelta?.(payload.delta)
      }

      if (payload.type === 'response.completed' && payload.response) {
        completedResponse = payload.response
      }
    }
  }

  if (!completedResponse) throw new Error('No completed response received from stream')
  return completedResponse
}

export async function streamAgent(
  messages: Array<{ role: string; content: string }>,
  context: AgentContext | undefined,
  callbacks: StreamCallbacks,
  runtime?: AgentRuntimeOptions,
) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set in environment')

  const chatId = ensureBudget(context)
  const allTools = [...toolDefinitions, ...(runtime?.extraToolDefinitions || [])]
  const assembled = await contextAssembler.assembleContext({
    baseSystemPrompt: SYSTEM_PROMPT,
    injections: buildContextInjections(context),
    messages: messages as any,
    tools: allTools,
    permissionMode: context?.permissionMode,
    approvedTools: context?.approvedTools,
    compactor,
  })
  const trace: ToolTraceEntry[] = []
  const executeTool = runtime?.executeTool || runTool
  let response: any = await createResponseStream(
    {
      model: MODEL,
      input: [
        { role: 'system', content: assembled.systemPrompt },
        ...assembled.messages,
      ] as any,
      tools: assembled.tools as any,
      parallel_tool_calls: false,
    },
    callbacks,
  )

  // Track tokens if response includes usage
  if (response.usage) {
    try {
      tokenBudget.recordUsage(chatId, response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0)
    } catch (err) {
      console.warn(`Token budget warning: ${String(err)}`)
    }
  }

  for (let i = 0; i < MAX_TOOL_LOOPS; i += 1) {
    const toolCalls: any[] = (response.output || []).filter((item: any) => item.type === 'function_call')
    if (toolCalls.length === 0) {
      // Log cost before returning
      await logTokenCost(chatId, response)
      return { response, trace }
    }

    const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = []
    for (const call of toolCalls) {
      const callEntry: ToolTraceEntry = {
        type: 'tool_call',
        name: call.name,
        call_id: call.call_id,
        arguments: call.arguments || '',
      }
      trace.push(callEntry)
      callbacks.onTrace?.(callEntry)

      let args: any = {}
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch (err) {
        const output = JSON.stringify({ ok: false, error: `invalid JSON arguments: ${String(err)}` })
        const outputEntry: ToolTraceEntry = { type: 'tool_output', call_id: call.call_id, output }
        trace.push(outputEntry)
        callbacks.onTrace?.(outputEntry)
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        })
        continue
      }

      try {
        const result = await executeTool(call.name, args, context)
        const output = JSON.stringify(result)
        const outputEntry: ToolTraceEntry = { type: 'tool_output', call_id: call.call_id, output }
        trace.push(outputEntry)
        callbacks.onTrace?.(outputEntry)
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        })
      } catch (err) {
        const output = JSON.stringify({ ok: false, error: String(err) })
        const outputEntry: ToolTraceEntry = { type: 'tool_output', call_id: call.call_id, output }
        trace.push(outputEntry)
        callbacks.onTrace?.(outputEntry)
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        })
      }
    }

    response = await createResponseStream(
      {
        model: MODEL,
        previous_response_id: response.id,
        input: toolOutputs,
      },
      callbacks,
    )
  }

  // Log cost before returning
  await logTokenCost(chatId, response)
  return { response, trace }
}
