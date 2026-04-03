import fs from 'fs/promises'
import path from 'path'
import fg from 'fast-glob'
import { validatePluginManifest, type PluginManifest } from './manifest.js'

export type PluginLoadSuccess = {
  filePath: string
  manifest: PluginManifest
}

export type PluginLoadFailure = {
  filePath: string
  error: string
}

export type PluginLoadReport = {
  loaded: PluginLoadSuccess[]
  failed: PluginLoadFailure[]
}

export async function discoverPluginManifestFiles(rootDir: string) {
  const normalizedRoot = path.resolve(rootDir)
  const files = await fg('**/plugin.json', {
    cwd: normalizedRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  })

  return files.map((filePath) => path.resolve(filePath))
}

export async function loadManifestFile(filePath: string): Promise<PluginManifest> {
  const absolutePath = path.resolve(filePath)
  const raw = await fs.readFile(absolutePath, 'utf8')
  const json = JSON.parse(raw) as unknown
  const manifest = validatePluginManifest(json)
  if (!manifest.source) {
    manifest.source = absolutePath
  }
  return manifest
}

export async function loadPluginsFromDirectory(rootDir: string): Promise<PluginLoadReport> {
  const loaded: PluginLoadSuccess[] = []
  const failed: PluginLoadFailure[] = []

  const files = await discoverPluginManifestFiles(rootDir)

  for (const filePath of files) {
    try {
      const manifest = await loadManifestFile(filePath)
      loaded.push({ filePath, manifest })
    } catch (error) {
      failed.push({ filePath, error: String(error) })
    }
  }

  return { loaded, failed }
}
