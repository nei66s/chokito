import dotenv from 'dotenv'
import OpenAI from 'openai'
import fetch from 'node-fetch'
import { runTool, toolDefinitions, type PermissionMode } from './tools.js'

dotenv.config()

const OPENAI_KEY = process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_MODEL || 'gpt-5'
const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 6)
const SYSTEM_PROMPT = `
You are Chocks, a practical local coding agent.

Priorities:
- Be concrete, useful, and concise.
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

function buildSystemPrompt(context?: AgentContext) {
  const chatLabel = context?.chatId ? `Current conversation id: ${context.chatId}` : 'Current conversation id: global'
  const userLabel = context?.userId ? `Current owner id: ${context.userId}` : 'Current owner id: legacy-local'
  const accessLabel = context?.fullAccess
    ? 'Filesystem mode: full computer access enabled by the user.'
    : 'Filesystem mode: restricted to the project workspace.'
  const permissionLabel =
    context?.permissionMode === 'auto'
      ? 'Permission mode: auto. Enabled tools may run without extra approval checks.'
      : context?.permissionMode === 'read_only'
        ? 'Permission mode: read-only. Do not attempt mutating, shell, or network actions.'
        : 'Permission mode: ask. Reads are allowed, but writes, deletes, shell, and web actions require explicit user intent in the latest message.'
  return `${SYSTEM_PROMPT}\n\n${chatLabel}\n${userLabel}\n${accessLabel}\n${permissionLabel}\nWorkflow tools are scoped to the current conversation automatically.`
}

export async function runAgent(
  messages: Array<{ role: string; content: string }>,
  context?: AgentContext,
) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set in environment')

  const client = new OpenAI({ apiKey: OPENAI_KEY })
  const trace: ToolTraceEntry[] = []

  let response: any = await client.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: buildSystemPrompt(context) },
      ...messages,
    ] as any,
    tools: toolDefinitions as any,
    parallel_tool_calls: false,
  })

  for (let i = 0; i < MAX_TOOL_LOOPS; i += 1) {
    const toolCalls: any[] = (response.output || []).filter((item: any) => item.type === 'function_call')
    if (toolCalls.length === 0) return { response, trace }

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
        const result = await runTool(call.name, args, context)
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
) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set in environment')

  const trace: ToolTraceEntry[] = []
  let response: any = await createResponseStream(
    {
      model: MODEL,
      input: [
        { role: 'system', content: buildSystemPrompt(context) },
        ...messages,
      ] as any,
      tools: toolDefinitions as any,
      parallel_tool_calls: false,
    },
    callbacks,
  )

  for (let i = 0; i < MAX_TOOL_LOOPS; i += 1) {
    const toolCalls: any[] = (response.output || []).filter((item: any) => item.type === 'function_call')
    if (toolCalls.length === 0) return { response, trace }

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
        const result = await runTool(call.name, args, context)
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

  return { response, trace }
}
