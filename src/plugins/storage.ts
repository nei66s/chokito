import { query } from '../db.js'
import { validatePluginManifest, type PluginManifest } from './manifest.js'
import { type PluginRegistry } from './registry.js'

type PluginManifestRow = {
  plugin_id: string
  manifest_json: unknown
  enabled: boolean
}

export async function initPluginStorage() {
  await query(`
    CREATE TABLE IF NOT EXISTS plugin_manifests (
      plugin_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      manifest_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_manifests_enabled ON plugin_manifests (enabled);
  `)
}

export async function upsertPluginManifest(manifest: PluginManifest) {
  await query(
    `
      INSERT INTO plugin_manifests (plugin_id, enabled, manifest_json, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW(), NOW())
      ON CONFLICT (plugin_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          manifest_json = EXCLUDED.manifest_json,
          updated_at = NOW()
    `,
    [manifest.id, manifest.enabled, JSON.stringify(manifest)]
  )
}

export async function deletePluginManifest(pluginId: string) {
  await query('DELETE FROM plugin_manifests WHERE plugin_id = $1', [String(pluginId || '').trim()])
}

export async function setPluginEnabled(pluginId: string, enabled: boolean) {
  await query(
    `
      UPDATE plugin_manifests
      SET enabled = $2,
          manifest_json = jsonb_set(manifest_json, '{enabled}', to_jsonb($2::boolean), true),
          updated_at = NOW()
      WHERE plugin_id = $1
    `,
    [String(pluginId || '').trim(), Boolean(enabled)]
  )
}

export async function listStoredPluginManifests() {
  const result = await query<PluginManifestRow>(
    `
      SELECT plugin_id, manifest_json, enabled
      FROM plugin_manifests
      ORDER BY plugin_id ASC
    `
  )

  const manifests: PluginManifest[] = []
  for (const row of result.rows) {
    const parsed = validatePluginManifest(row.manifest_json)
    parsed.enabled = Boolean(row.enabled)
    manifests.push(parsed)
  }

  return manifests
}

export async function hydrateRegistryFromStorage(registry: PluginRegistry) {
  const manifests = await listStoredPluginManifests()
  for (const manifest of manifests) {
    registry.register(manifest, { overwrite: true })
  }
  return manifests.length
}
