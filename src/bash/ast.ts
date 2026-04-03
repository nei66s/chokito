export type BashOperator = 'pipe' | 'and' | 'or' | 'sequence'

export type BashSegment = {
  command: string
  args: string[]
}

export type BashCommandAst = {
  raw: string
  tokens: string[]
  segments: BashSegment[]
  operators: BashOperator[]
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (char === '\\' && !inSingle && index + 1 < command.length) {
      current += command[index + 1]
      index += 1
      continue
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }

    if (!inSingle && !inDouble) {
      const nextChar = command[index + 1] || ''
      const twoChars = `${char}${nextChar}`

      if (twoChars === '&&' || twoChars === '||') {
        if (current.trim()) tokens.push(current.trim())
        tokens.push(twoChars)
        current = ''
        index += 1
        continue
      }

      if (char === '|' || char === ';') {
        if (current.trim()) tokens.push(current.trim())
        tokens.push(char)
        current = ''
        continue
      }

      if (/\s/u.test(char)) {
        if (current.trim()) {
          tokens.push(current.trim())
          current = ''
        }
        continue
      }
    }

    current += char
  }

  if (current.trim()) tokens.push(current.trim())
  return tokens
}

function toOperator(token: string): BashOperator | null {
  if (token === '|') return 'pipe'
  if (token === '&&') return 'and'
  if (token === '||') return 'or'
  if (token === ';') return 'sequence'
  return null
}

export function parseBashCommand(command: string): BashCommandAst {
  const raw = String(command || '')
  const tokens = tokenize(raw)
  const segments: BashSegment[] = []
  const operators: BashOperator[] = []

  let currentSegmentTokens: string[] = []
  for (const token of tokens) {
    const operator = toOperator(token)
    if (operator) {
      if (currentSegmentTokens.length > 0) {
        const [commandName, ...args] = currentSegmentTokens
        segments.push({ command: commandName, args })
        currentSegmentTokens = []
      }
      operators.push(operator)
      continue
    }

    currentSegmentTokens.push(token)
  }

  if (currentSegmentTokens.length > 0) {
    const [commandName, ...args] = currentSegmentTokens
    segments.push({ command: commandName, args })
  }

  return {
    raw,
    tokens,
    segments,
    operators,
  }
}
