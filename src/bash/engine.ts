import { parseBashCommand } from './ast.js'
import { classifyBashCommand, type BashClassification } from './classifier.js'
import { runWithSandbox, type SandboxExecutionResult } from './sandbox.js'
import { getBashHistoryById, listBashHistory, recordBashHistory, type BashHistoryEntry } from './history.js'
import { parseSedInlineEdit, simulateSedInlineEdit, type SedPreview } from './sedParser.js'
import fs from 'fs/promises'
import path from 'path'

export type BashEngineInput = {
  command: string
  cwd: string
  timeoutMs?: number
  replayOf?: string
}

export type BashEngineResult = {
  classification: BashClassification
  ast: ReturnType<typeof parseBashCommand>
  execution: SandboxExecutionResult
  historyEntry: BashHistoryEntry
}

export async function executeBashCommand(input: BashEngineInput): Promise<BashEngineResult> {
  const command = String(input.command || '').trim()
  if (!command) throw new Error('empty command')

  const ast = parseBashCommand(command)
  const classification = classifyBashCommand(command)

  if (classification.risk === 'blocked') {
    throw new Error(`command blocked: ${classification.reason}`)
  }

  const execution = await runWithSandbox({
    command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
  })

  const historyEntry = recordBashHistory({
    command,
    cwd: input.cwd,
    classification,
    sandbox: execution.sandbox,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    stdout: execution.stdout,
    stderr: execution.stderr,
    replayOf: input.replayOf,
  })

  return {
    classification,
    ast,
    execution,
    historyEntry,
  }
}

export function getBashExecutionHistory(limit = 50): BashHistoryEntry[] {
  return listBashHistory(limit)
}

export async function replayBashCommand(id: string, cwdOverride?: string): Promise<BashEngineResult> {
  const source = getBashHistoryById(id)
  if (!source) throw new Error('bash history entry not found')

  const cwd = cwdOverride ? path.resolve(cwdOverride) : source.cwd
  const replayResult = await executeBashCommand({
    command: source.command,
    cwd,
    replayOf: source.id,
  })

  return replayResult
}

export async function previewSedInlineCommand(command: string, cwd: string): Promise<SedPreview> {
  const edit = parseSedInlineEdit(command)
  if (!edit) {
    throw new Error('command is not a supported sed -i substitution')
  }

  const targetPath = path.isAbsolute(edit.filePath)
    ? path.resolve(edit.filePath)
    : path.resolve(cwd, edit.filePath)

  const original = await fs.readFile(targetPath, 'utf8')
  return simulateSedInlineEdit({ ...edit, filePath: targetPath }, original)
}
