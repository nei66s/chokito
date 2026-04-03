import { type PluginManifest } from './manifest.js'

export type RegisterPluginOptions = {
  overwrite?: boolean
}

export class PluginRegistry {
  private manifests = new Map<string, PluginManifest>()

  register(manifest: PluginManifest, options: RegisterPluginOptions = {}) {
    const alreadyExists = this.manifests.has(manifest.id)
    if (alreadyExists && !options.overwrite) {
      throw new Error(`plugin already registered: ${manifest.id}`)
    }

    this.manifests.set(manifest.id, manifest)
    return manifest
  }

  unregister(pluginId: string) {
    return this.manifests.delete(String(pluginId || '').trim())
  }

  get(pluginId: string) {
    return this.manifests.get(String(pluginId || '').trim())
  }

  list() {
    return [...this.manifests.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  has(pluginId: string) {
    return this.manifests.has(String(pluginId || '').trim())
  }

  setAll(manifests: PluginManifest[]) {
    this.clear()
    for (const manifest of manifests) {
      this.register(manifest, { overwrite: true })
    }
  }

  setEnabled(pluginId: string, enabled: boolean) {
    const manifest = this.get(pluginId)
    if (!manifest) {
      throw new Error(`plugin not found: ${pluginId}`)
    }

    manifest.enabled = Boolean(enabled)
    this.manifests.set(manifest.id, manifest)
    return manifest
  }

  clear() {
    this.manifests.clear()
  }
}

let registrySingleton: PluginRegistry | null = null

export function initPluginRegistry() {
  if (!registrySingleton) {
    registrySingleton = new PluginRegistry()
  }
  return registrySingleton
}

export function getPluginRegistry() {
  if (!registrySingleton) {
    throw new Error('plugin registry not initialized')
  }
  return registrySingleton
}
