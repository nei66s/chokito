#!/usr/bin/env npx tsx
/**
 * Hook System Tests
 * arquivo: src/test-swarm-hooks.ts
 *
 * Tests for lifecycle hooks: registration, execution, validation, recovery
 */

import {
  registerHook,
  unregisterHook,
  executePreHooks,
  executePostHooks,
  executeErrorHooks,
  clearAllHooks,
  getHooks,
} from './swarm/hooks.js'
import { TeamConfig } from './swarm/constants.js'

interface TestResult {
  test: string
  passed: boolean
  error?: string
}

const results: TestResult[] = []

function logTest(test: string, passed: boolean, error?: string) {
  const status = passed ? '✅' : '❌'
  console.log(`${status} ${test}`)
  if (error) console.log(`   Error: ${error}`)
  results.push({ test, passed, error })
}

async function testHookSystem() {
  console.log('\n=== Fase 8: Hook System Tests ===\n')

  try {
    // Test 1: Register and retrieve hooks
    console.log('[1] Testing hook registration...')
    clearAllHooks()

    let preHookCalled = false
    const preHook = async (config: TeamConfig) => {
      preHookCalled = true
      return config.name.length > 0
    }

    registerHook('team', 'onCreate', preHook)
    const hooks = getHooks()
    logTest('Hook registered successfully', (hooks.team.onCreate?.length ?? 0) === 1)

    // Test 2: Execute pre-hooks with validation
    console.log('\n[2] Testing pre-hook validation...')
    const validConfig: TeamConfig = {
      name: 'test-team',
      description: 'Test',
      createdAt: Date.now(),
      leadAgentId: 'leader@test-team',
      members: [],
    }

    preHookCalled = false
    const validResult = await executePreHooks('team', 'onCreate', validConfig, { timestamp: Date.now() })
    logTest('Pre-hook allows valid team', validResult && preHookCalled)

    // Test 3: Pre-hook rejection
    console.log('\n[3] Testing pre-hook rejection...')
    const rejectHook = async () => false
    clearAllHooks()
    registerHook('team', 'onCreate', rejectHook)

    const rejectResult = await executePreHooks('team', 'onCreate', validConfig, { timestamp: Date.now() })
    logTest('Pre-hook rejects operation', !rejectResult)

    // Test 4: Post-hooks execute after operation
    console.log('\n[4] Testing post-hook side effects...')
    clearAllHooks()

    let postHookExecuted = false
    const notifications: string[] = []

    const postHook = async (config: TeamConfig) => {
      postHookExecuted = true
      notifications.push(`Team created: ${config.name}`)
    }

    registerHook('team', 'onCreate', postHook)
    await executePostHooks('team', 'onCreate', validConfig, { timestamp: Date.now() })

    logTest('Post-hook executes successfully', postHookExecuted && notifications.length === 1)

    // Test 5: Post-hooks don't break on error
    console.log('\n[5] Testing post-hook error resilience...')
    clearAllHooks()

    const errorHook = async () => {
      throw new Error('Hook error')
    }
    const safeHook = async () => {
      notifications.push('Safe hook executed')
    }

    registerHook('team', 'onCreate', errorHook)
    registerHook('team', 'onCreate', safeHook)

    const initialNotifications = notifications.length
    await executePostHooks('team', 'onCreate', validConfig, { timestamp: Date.now() })

    logTest('Post-hooks continue after error', notifications.length === initialNotifications + 1)

    // Test 6: Multiple hooks execute in order
    console.log('\n[6] Testing multiple hook execution order...')
    clearAllHooks()

    const callOrder: number[] = []

    registerHook('team', 'onCreate', async () => {
      callOrder.push(1)
      return true
    })
    registerHook('team', 'onCreate', async () => {
      callOrder.push(2)
      return true
    })
    registerHook('team', 'onCreate', async () => {
      callOrder.push(3)
      return true
    })

    await executePreHooks('team', 'onCreate', validConfig, { timestamp: Date.now() })
    logTest('Hooks execute in registration order', callOrder.length === 3 && callOrder[0] === 1 && callOrder[2] === 3)

    // Test 7: Unregister hooks
    console.log('\n[7] Testing hook unregistration...')
    clearAllHooks()

    const hookToRemove = async () => true
    registerHook('team', 'onCreate', hookToRemove)
    let beforeCount = (getHooks().team.onCreate || []).length
    logTest('Hook registered', beforeCount === 1)

    unregisterHook('team', 'onCreate', hookToRemove)
    let afterCount = (getHooks().team.onCreate || []).length
    logTest('Hook unregistered', afterCount === 0)

    // Test 8: Error hooks for recovery
    console.log('\n[8] Testing error hooks...')
    clearAllHooks()

    const recoveryHook = async (error: Error) => {
      if (error.message.includes('Database')) {
        console.log('Attempting database error recovery...')
        return true // Handled
      }
      return false // Not handled
    }

    registerHook('team', 'onDelete', recoveryHook)

    const dbError = new Error('Database connection failed')
    const handledResult = await executeErrorHooks('team', 'onDelete', dbError, { timestamp: Date.now() })
    logTest('Error hook recovers from database error', handledResult === true)

    const otherError = new Error('Unknown error')
    const unhandledResult = await executeErrorHooks('team', 'onDelete', otherError, { timestamp: Date.now() })
    logTest('Error hook ignores non-database errors', unhandledResult === false)

    // Test 9: Hooks with metadata
    console.log('\n[9] Testing hook context and metadata...')
    clearAllHooks()

    let contextReceived: any = null
    const metadataHook = async (data: any, context: any) => {
      contextReceived = context
      return true
    }

    registerHook('team', 'onCreate', metadataHook)
    const metadata = { source: 'api', userId: 'user123' }
    await executePreHooks('team', 'onCreate', validConfig, { timestamp: Date.now(), metadata })

    logTest('Hook receives context metadata', contextReceived?.metadata?.source === 'api')

    // Summary
    console.log('\n=== Test Results ===')
    const passed = results.filter((r) => r.passed).length
    const total = results.length
    console.log(`\nPassed: ${passed}/${total}`)

    if (passed === total) {
      console.log('\n✅ All hook tests passed!')
      process.exit(0)
    } else {
      console.log('\n❌ Some tests failed')
      process.exit(1)
    }
  } catch (error) {
    console.error('Fatal error during testing:', error)
    process.exit(1)
  }
}

// Run tests
testHookSystem()
