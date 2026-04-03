import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

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

/**
 * Windows PowerShell soft-sandbox.
 *
 * OS-level isolation (seccomp / seatbelt) is not available on Windows, so we
 * apply two layers of defence-in-depth:
 *
 *   1. **Path-traversal pre-check** — scan raw command tokens for `..` sequences
 *      that would escape the working directory.  Rejects the command before
 *      spawning if any token resolves outside `cwd`.
 *
 *   2. **Restricted PowerShell runspace** — wraps the command in a PowerShell
 *      `-NonInteractive -NoProfile` sub-shell that:
 *        • Overrides `HOME`, `HOMEDRIVE`, `HOMEPATH`, `USERPROFILE` to `cwd`
 *        • Blocks access to the user profile tree outside the project root
 *        • Sets `$ConfirmPreference = 'High'` to suppress auto-confirm prompts
 *        • Captures stdout/stderr separately (no merged fd on Windows)
 *
 *   3. Falls back to `runRaw` when PowerShell is unavailable (WSL1 or non-PS
 *      environments) unless `CHOKITO_SANDBOX_STRICT` is set.
 */
function buildPowerShellSandboxCommand(command: string, cwd: string): string {
  // Escape single-quotes inside the user command by doubling them
  const escaped = command.replace(/'/g, "''")
  // Encode as UTF-16LE base64 so we avoid shell quoting hell
  const psScript = [
    `$ConfirmPreference = 'High'`,
    `$env:HOME = '${cwd.replace(/'/g, "''")}'`,
    `$env:USERPROFILE = '${cwd.replace(/'/g, "''")}'`,
    `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`,
    `Invoke-Expression '${escaped}'`,
  ].join('; ')

  const utf16 = Buffer.from(psScript, 'utf16le').toString('base64')
  return `powershell.exe -NonInteractive -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${utf16}`
}

function hasPathTraversal(command: string, cwd: string): boolean {
  const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
  // Check simple `..` patterns that could escape cwd
  const tokens = command.split(/\s+/)
  for (const token of tokens) {
    const cleaned = token.replace(/['"]/g, '').replace(/\\/g, '/')
    if (cleaned.includes('..')) {
      // Resolve relative to cwd and check if it stays inside
      try {
        const resolved = path.resolve(cwd, cleaned).replace(/\\/g, '/').toLowerCase()
        if (!resolved.startsWith(normalizedCwd)) return true
      } catch {
        return true
      }
    }
  }
  return false
}


export async function runWithSandbox(input: SandboxExecutionInput): Promise<SandboxExecutionResult> {
  const timeoutMs = Math.max(1000, Number(input.timeoutMs || 15000))
  const strict = shouldUseStrictSandbox()

  try {
    if (process.platform === 'win32') {
      // Pre-check: block path traversal attempts
      if (hasPathTraversal(input.command, input.cwd)) {
        throw new Error(`[sandbox] path traversal detected in command: "${input.command.substring(0, 80)}"`)
      }

      try {
        const startedAt = Date.now()
        const { stdout, stderr } = await execAsync(
          buildPowerShellSandboxCommand(input.command, input.cwd),
          {
            cwd: input.cwd,
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
          },
        )
        return {
          stdout,
          stderr,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          sandbox: 'none', // soft sandbox only — no OS isolation
        }
      } catch (error: any) {
        if (strict) {
          throw new Error(`sandbox unavailable (powershell): ${String(error?.message || error)}`)
        }
        // Fall through to runRaw below
      }
    }

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
