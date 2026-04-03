export type PluginCapabilityType = 'tool' | 'hook' | 'skill' | 'agent'

export type PluginCapability = {
  type: PluginCapabilityType
  name: string
  entry: string
  description?: string
}

export type PluginManifest = {
  id: string
  name: string
  version: string
  enabled: boolean
  description?: string
  author?: string
  dependencies: string[]
  capabilities: PluginCapability[]
  source?: string
  configSchema?: Record<string, unknown>
}

const VALID_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i
const VALID_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function toText(value: unknown) {
  return String(value ?? '').trim()
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map((item) => toText(item)).filter(Boolean)
}

function parseCapabilityType(value: unknown): PluginCapabilityType {
  const raw = toText(value).toLowerCase()
  if (raw === 'tool' || raw === 'hook' || raw === 'skill' || raw === 'agent') {
    return raw
  }
  throw new Error(`invalid capability type: ${String(value)}`)
}

function parseCapabilities(value: unknown): PluginCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('capabilities must be a non-empty array')
  }

  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`capabilities[${index}] must be an object`)
    }

    const candidate = item as Record<string, unknown>
    const type = parseCapabilityType(candidate.type)
    const name = toText(candidate.name)
    const entry = toText(candidate.entry)
    const description = toText(candidate.description)

    if (!name) throw new Error(`capabilities[${index}].name is required`)
    if (!entry) throw new Error(`capabilities[${index}].entry is required`)

    return {
      type,
      name,
      entry,
      ...(description ? { description } : {}),
    }
  })
}

export function validatePluginManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('manifest must be an object')
  }

  const candidate = input as Record<string, unknown>
  const id = toText(candidate.id)
  const name = toText(candidate.name)
  const version = toText(candidate.version)
  const enabledRaw = candidate.enabled
  const description = toText(candidate.description)
  const author = toText(candidate.author)
  const source = toText(candidate.source)

  if (!id) throw new Error('manifest.id is required')
  if (!VALID_ID.test(id)) throw new Error('manifest.id has invalid format')

  if (!name) throw new Error('manifest.name is required')
  if (!version) throw new Error('manifest.version is required')
  if (!VALID_SEMVER.test(version)) throw new Error('manifest.version must follow semver')

  const enabled =
    typeof enabledRaw === 'boolean'
      ? enabledRaw
      : String(enabledRaw ?? '').trim().toLowerCase() === 'true'

  const dependencies = asStringArray(candidate.dependencies)
  const capabilities = parseCapabilities(candidate.capabilities)

  const parsed: PluginManifest = {
    id,
    name,
    version,
    enabled,
    dependencies,
    capabilities,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(source ? { source } : {}),
  }

  if (candidate.configSchema && typeof candidate.configSchema === 'object') {
    parsed.configSchema = candidate.configSchema as Record<string, unknown>
  }

  return parsed
}
