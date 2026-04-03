export type SedInlineEdit = {
  filePath: string
  from: string
  to: string
  flags: string
}

export type SedPreview = {
  filePath: string
  changed: boolean
  replacements: number
  previewBefore: string
  previewAfter: string
}

function unescapeSedPart(value: string, delimiter: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\\' && index + 1 < value.length) {
      const next = value[index + 1]
      if (next === delimiter || next === '\\') {
        out += next
        index += 1
        continue
      }
    }
    out += char
  }
  return out
}

function parseSedExpression(expression: string): { from: string; to: string; flags: string } | null {
  if (!expression.startsWith('s')) return null
  const delimiter = expression[1]
  if (!delimiter) return null

  let index = 2
  let from = ''
  while (index < expression.length) {
    const char = expression[index]
    const previous = expression[index - 1]
    if (char === delimiter && previous !== '\\') break
    from += char
    index += 1
  }
  if (index >= expression.length) return null

  index += 1
  let to = ''
  while (index < expression.length) {
    const char = expression[index]
    const previous = expression[index - 1]
    if (char === delimiter && previous !== '\\') break
    to += char
    index += 1
  }
  if (index >= expression.length) return null

  const flags = expression.slice(index + 1).trim()
  return {
    from: unescapeSedPart(from, delimiter),
    to: unescapeSedPart(to, delimiter),
    flags,
  }
}

export function parseSedInlineEdit(command: string): SedInlineEdit | null {
  const raw = String(command || '').trim()
  if (!raw) return null

  const match = raw.match(/^sed\s+-i(?:''|\s+['"][^'"]*['"])?\s+['"]([^'"]+)['"]\s+(.+)$/u)
  if (!match) return null

  const expression = parseSedExpression(match[1])
  if (!expression) return null

  return {
    from: expression.from,
    to: expression.to,
    flags: expression.flags,
    filePath: match[2].trim(),
  }
}

export function simulateSedInlineEdit(edit: SedInlineEdit, content: string): SedPreview {
  const sourceText = String(content || '')
  const globalReplace = edit.flags.includes('g')
  const useInsensitive = edit.flags.includes('i')
  const regexFlags = `${globalReplace ? 'g' : ''}${useInsensitive ? 'i' : ''}u`

  const escapedPattern = edit.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escapedPattern, regexFlags)

  const matches = sourceText.match(pattern)
  const replacements = matches ? matches.length : 0
  const nextText = sourceText.replace(pattern, edit.to)

  return {
    filePath: edit.filePath,
    changed: sourceText !== nextText,
    replacements,
    previewBefore: sourceText.slice(0, 500),
    previewAfter: nextText.slice(0, 500),
  }
}
