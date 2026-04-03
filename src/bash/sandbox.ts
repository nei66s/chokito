import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

type SandboxMode = 'bubblewrap' | 'seatbelt' | 'none'

export type SandboxExecutionInput = {
  command: string
  cwd: string
  timeoutMs?: number
}

export type SandboxExecutionResult = {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  sandbox: SandboxMode
}

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

async function runRaw(command: string, cwd: string, timeoutMs: number): Promise<SandboxExecutionResult> {
  const startedAt = Date.now()
  const { stdout, stderr } = await execAsync(command, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  })

  return {
    stdout,
    stderr,
    exitCode: 0,
    durationMs: Date.now() - startedAt,
    sandbox: 'none',
  }
}

function buildBubblewrapCommand(command: string, cwd: string): string {
  return [
    'bwrap',
    '--unshare-all',
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--bind', shQuote(cwd), shQuote(cwd),
    '--chdir', shQuote(cwd),
    '/bin/sh',
    '-lc',
    shQuote(command),
  ].join(' ')
}

function buildSeatbeltCommand(command: string, cwd: string): string {
  const profile = `(version 1)(deny default)(allow process*)(allow file-read*)(allow file-write* (subpath \"${cwd.replace(/\\/g, '\\\\').replace(/\"/g, '\\\"')}\"))`
  return `sandbox-exec -p ${shQuote(profile)} /bin/sh -lc ${shQuote(command)}`
}

function shouldUseStrictSandbox(): boolean {
  return String(process.env.CHOKITO_SANDBOX_STRICT || '').toLowerCase() === 'true'
}

export async function runWithSandbox(input: SandboxExecutionInput): Promise<SandboxExecutionResult> {
  const timeoutMs = Math.max(1000, Number(input.timeoutMs || 15000))
  const strict = shouldUseStrictSandbox()

  try {
    if (process.platform === 'linux') {
      try {
        const startedAt = Date.now()
        const { stdout, stderr } = await execAsync(buildBubblewrapCommand(input.command, input.cwd), {
          cwd: input.cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
          shell: '/bin/sh',
        })
        return {
          stdout,
          stderr,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          sandbox: 'bubblewrap',
        }
      } catch (error: any) {
        if (strict) {
          throw new Error(`sandbox unavailable (bubblewrap): ${String(error?.message || error)}`)
        }
      }
    }

    if (process.platform === 'darwin') {
      try {
        const startedAt = Date.now()
        const { stdout, stderr } = await execAsync(buildSeatbeltCommand(input.command, input.cwd), {
          cwd: input.cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
          shell: '/bin/sh',
        })
        return {
          stdout,
          stderr,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          sandbox: 'seatbelt',
        }
      } catch (error: any) {
        if (strict) {
          throw new Error(`sandbox unavailable (seatbelt): ${String(error?.message || error)}`)
        }
      }
    }

    const raw = await runRaw(input.command, input.cwd, timeoutMs)
    return {
      ...raw,
      stderr: strict ? raw.stderr : `${raw.stderr ? `${raw.stderr}\n` : ''}[sandbox] fallback=none on ${process.platform}`,
    }
  } catch (error: any) {
    const durationMs = typeof error?.durationMs === 'number' ? error.durationMs : 0
    const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error?.message || 'command failed')
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    const exitCode = typeof error?.code === 'number' ? error.code : 1
    const failure = new Error(stderr || 'command failed') as Error & {
      stdout?: string
      stderr?: string
      exitCode?: number
      durationMs?: number
    }
    failure.stdout = stdout
    failure.stderr = stderr
    failure.exitCode = exitCode
    failure.durationMs = durationMs
    throw failure
  }
}
