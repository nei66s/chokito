/**
 * Backend Executors för Teammate Spawning
 * Arquivo: src/swarm/backends.ts
 *
 * Abstração para executar teammates em diferentes ambientes:
 * - Tmux (panes em sessão tmux ou nova sessão)
 * - iTerm2 (native panes via it2 CLI)
 * - In-Process (query loop no mesmo processo Node.js)
 */

import { execSync, spawn } from 'child_process'
import { TeamMember, BackendType } from './constants'

/**
 * Interface abstrata para executar teammates
 */
export interface PaneBackend {
  /**
   * Spawn um teammate em um pane/processo
   * Retorna pane ID se aplicável
   */
  spawn(member: TeamMember, initialPrompt: string): Promise<string | void>

  /**
   * Envia sinal SIGTERM para teammate
   */
  kill(member: TeamMember): Promise<void>

  /**
   * Verifica se o pane/processo ainda está rodando
   */
  isRunning(member: TeamMember): Promise<boolean>
}

/**
 * Backend Tmux: cria split-pane ou nova window
 */
export class TmuxBackend implements PaneBackend {
  private sessionName: string

  constructor(sessionName?: string) {
    this.sessionName = sessionName || this.detectSession()
  }

  /**
   * Detecta sessão tmux atual ou cria nova
   */
  private detectSession(): string {
    try {
      const current = execSync('tmux display-message -p "#{session_name}"', {
        encoding: 'utf-8',
      }).trim()
      return current || 'claude-swarm'
    } catch {
      return 'claude-swarm'
    }
  }

  async spawn(member: TeamMember, initialPrompt: string): Promise<string | void> {
    const cmd = this.buildCliCommand(member)

    // Cria nova window com nome do agent
    const tmuxCmd = `tmux new-window -t ${this.sessionName} -n ${member.name} '${cmd}'`

    try {
      execSync(tmuxCmd, { stdio: 'ignore' })
      member.tmuxPaneId = `${this.sessionName}:${member.name}`
    } catch (error) {
      console.error(`Erro ao criar pane tmux para ${member.agentId}:`, error)
      throw error
    }
  }

  async kill(member: TeamMember): Promise<void> {
    if (!member.tmuxPaneId) return

    try {
      execSync(`tmux kill-window -t ${member.tmuxPaneId}`, { stdio: 'ignore' })
    } catch (error) {
      console.warn(`Erro ao matar pane tmux ${member.tmuxPaneId}:`, error)
    }
  }

  async isRunning(member: TeamMember): Promise<boolean> {
    if (!member.tmuxPaneId) return false

    try {
      execSync(`tmux list-windows -t ${member.tmuxPaneId.split(':')[0]}`, {
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }

  private buildCliCommand(member: TeamMember): string {
    // Comando CLI do agent com env vars e team info
    const envVars = [
      `CLAUDE_TEAM_NAME=${member.agentId.split('@')[1]}`,
      `CLAUDE_AGENT_ID=${member.agentId}`,
      `CLAUDE_AGENT_COLOR=${member.color || 'default'}`,
      `CLAUDE_IS_TEAMMATE=1`,
    ]

    const modelFlag = member.model ? `--model ${member.model}` : ''
    const permissionFlag = member.mode ? `--permission-mode ${member.mode}` : ''
    const cwdFlag = `--cwd ${member.cwd}`

    return `${envVars.join(' ')} node claude.js ${cwdFlag} ${modelFlag} ${permissionFlag}`
  }
}

/**
 * Backend iTerm2: native panes via it2 CLI
 */
export class ITermBackend implements PaneBackend {
  async spawn(member: TeamMember, initialPrompt: string): Promise<string | void> {
    const cmd = this.buildCliCommand(member)

    // it2 open permite criar nova janela/pane e executar comando
    const it2Cmd = `it2 \$it split-pane-right -c "${member.cwd}" "${cmd}"`

    try {
      execSync(it2Cmd, { encoding: 'utf-8' })
    } catch (error) {
      console.error(`Erro ao criar pane iTerm2 para ${member.agentId}:`, error)
      throw error
    }
  }

  async kill(member: TeamMember): Promise<void> {
    // iTerm2 native termination via it2 API
    try {
      execSync(`it2 \$it kill-pane`, { stdio: 'ignore' })
    } catch (error) {
      console.warn(`Erro ao matar pane iTerm2:`, error)
    }
  }

  async isRunning(member: TeamMember): Promise<boolean> {
    // iTerm2 panes sempre considerados running se criados
    return true
  }

  private buildCliCommand(member: TeamMember): string {
    const envVars = [
      `CLAUDE_TEAM_NAME=${member.agentId.split('@')[1]}`,
      `CLAUDE_AGENT_ID=${member.agentId}`,
      `CLAUDE_AGENT_COLOR=${member.color || 'default'}`,
      `CLAUDE_IS_TEAMMATE=1`,
    ]

    const modelFlag = member.model ? `--model ${member.model}` : ''
    const permissionFlag = member.mode ? `--permission-mode ${member.mode}` : ''
    const cwdFlag = `--cwd ${member.cwd}`

    return `${envVars.join(' ')} node claude.js ${cwdFlag} ${modelFlag} ${permissionFlag}`
  }
}

/**
 * Backend In-Process: query loop no mesmo processo (fallback)
 */
export class InProcessBackend implements PaneBackend {
  private spawnedProcesses: Map<string, NodeJS.Timer> = new Map()

  async spawn(member: TeamMember, initialPrompt: string): Promise<string | void> {
    // Simula teammate como query loop background
    // Em produção, seria um isolamento de contexto com separate message queue

    const loopId = `loop-${member.agentId}`

    // Marca como active
    member.isActive = true

    console.log(`[IN-PROCESS] Iniciando query loop para ${member.agentId}`)
    console.log(`Prompt inicial: ${initialPrompt.substring(0, 50)}...`)
  }

  async kill(member: TeamMember): Promise<void> {
    const loopId = `loop-${member.agentId}`

    if (this.spawnedProcesses.has(loopId)) {
      const timer = this.spawnedProcesses.get(loopId)
      if (timer) {
        clearInterval(timer as any)
      }
      this.spawnedProcesses.delete(loopId)
    }

    member.isActive = false
    console.log(`[IN-PROCESS] Encerrado query loop para ${member.agentId}`)
  }

  async isRunning(member: TeamMember): Promise<boolean> {
    const loopId = `loop-${member.agentId}`
    return this.spawnedProcesses.has(loopId)
  }
}

/**
 * Detecta backend disponível (priority: tmux > iTerm2 > in-process)
 */
export async function detectBackend(): Promise<BackendType> {
  // Verifica tmux
  try {
    execSync('tmux -V', { stdio: 'ignore' })
    return 'tmux'
  } catch {
    // Não tem tmux
  }

  // Verifica iTerm2
  try {
    execSync('it2 --version', { stdio: 'ignore' })
    return 'iterm2'
  } catch {
    // Não tem it2
  }

  // Fallback para in-process
  return 'in-process'
}

/**
 * Factory para criar backend baseado no tipo
 */
export function createBackend(type: BackendType): PaneBackend {
  switch (type) {
    case 'tmux':
      return new TmuxBackend()
    case 'iterm2':
      return new ITermBackend()
    case 'in-process':
      return new InProcessBackend()
    default:
      throw new Error(`Backend desconhecido: ${type}`)
  }
}
