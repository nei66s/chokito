/**
 * Swarm System Core
 * Arquivo: src/swarm/index.ts
 *
 * Exporta público API para team management, teammate spawning, mailbox operations,
 * permission delegation, e plan mode
 */

// Re-export all public interfaces and functions
export * from './constants.js'
export * from './teamHelpers.js'
export * from './mailbox.js'
export * from './spawn.js'
export * from './backends.js'
export * from './permissions.js'
export * from './plans.js'
export * from './persistence.js'
export * from './hooks.js'
export * from './sessionPersistence.js'
