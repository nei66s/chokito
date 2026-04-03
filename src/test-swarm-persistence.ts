#!/usr/bin/env npx tsx
/**
 * Session 3 Persistence Tests
 * arquivo: src/test-swarm-persistence.ts
 *
 * Verifica que:
 * 1. Equipas são persistidas ao banco de dados
 * 2. Mensagens são persistidas ao banco de dados
 * 3. Carregamento a partir do DB funciona
 * 4. Dual persistence (arquivo + DB) é bem-sucedido
 */

import http from 'http'
import {
  persistTeamConfig,
  loadTeamConfigFromDb,
  deleteTeamFromDb,
  persistMailboxMessage,
  loadMailboxMessagesFromDb,
  getMailboxMessageCountFromDb,
} from './swarm/persistence.js'
import { createTeam, deleteTeam, addTeamMember, loadTeamConfig } from './swarm/teamHelpers.js'
import { addMessage } from './swarm/mailbox.js'

const BASE_URL = 'http://localhost:3000'

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

async function fetch_(url: string, options?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options?.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    }

    const req = http.request(reqOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
          })
        } catch (e) {
          resolve({ status: res.statusCode, body: data })
        }
      })
    })

    req.on('error', reject)
    if (options?.body) req.write(JSON.stringify(options.body))
    req.end()
  })
}

async function testPersistenceIntegration() {
  console.log('\n=== Fase 7 Session 3: Persistence Integration Tests ===\n')

  try {
    // Test 1: Create team via API and verify it's in the database
    console.log('\n[1] Testing team creation persistence...')
    let response = await fetch_(`${BASE_URL}/api/swarm/teams`, {
      method: 'POST',
      body: {
        name: 'persistence-test-team',
        description: 'Test team for persistence layer',
      },
    })

    let testPassed = response.status === 200
    logTest('Create team via API', testPassed)

    if (testPassed) {
      // Verify persistence directly from DB
      const dbConfig = await loadTeamConfigFromDb('persistence-test-team')
      logTest('Team found in database after creation', dbConfig !== null && dbConfig.name === 'persistence-test-team')

      // Verify file system persistence
      const fsConfig = await loadTeamConfig('persistence-test-team')
      logTest('Team found on filesystem', fsConfig !== null && fsConfig.name === 'persistence-test-team')
    }

    // Test 2: Add member and verify persistence
    console.log('\n[2] Testing member addition and message persistence...')
    response = await fetch_(`${BASE_URL}/api/swarm/teams/persistence-test-team/spawn`, {
      method: 'POST',
      body: {
        name: 'agent-tester',
        role: 'assistant',
        cwd: process.cwd(),
        initialPrompt: 'You are a test assistant',
      },
    })

    testPassed = response.status === 200
    logTest('Spawn member via API', testPassed)

    // Test 3: Send message and verify persistence
    console.log('\n[3] Testing message persistence...')
    response = await fetch_(`${BASE_URL}/api/swarm/teams/persistence-test-team/send-message`, {
      method: 'POST',
      body: {
        from: 'agent-tester',
        to: 'leader',
        type: 'direct-message',
        content: 'Testing persistence: Hello from database test!',
      },
    })

    testPassed = response.status === 200 && response.body?.messageId
    logTest('Send message via API', testPassed)

    if (testPassed) {
      const messageId = response.body.messageId

      // Verify message in database
      const dbMessages = await loadMailboxMessagesFromDb('persistence-test-team', 'leader')
      logTest('Message found in database', dbMessages.length > 0 && dbMessages.some((m) => m.id === messageId))

      // Verify message count in DB
      const count = await getMailboxMessageCountFromDb('persistence-test-team', 'leader')
      logTest('Message count matches', count > 0)
    }

    // Test 4: Read mailbox and verify persistence
    console.log('\n[4] Testing mailbox read and status updates...')
    response = await fetch_(`${BASE_URL}/api/swarm/teams/persistence-test-team/mailbox/leader`)

    testPassed = response.status === 200 && Array.isArray(response.body?.messages)
    logTest('Read mailbox via API', testPassed)

    if (testPassed && response.body.messages.length > 0) {
      const firstMsg = response.body.messages[0]
      logTest('Mailbox contains persisted message', firstMsg.content.includes('persistence'))
    }

    // Test 5: Cleanup - delete team and verify DB cleanup
    console.log('\n[5] Testing cleanup and database cascading deletes...')
    response = await fetch_(`${BASE_URL}/api/swarm/teams/persistence-test-team/shutdown`, {
      method: 'POST',
    })

    testPassed = response.status === 200
    logTest('Shutdown team via API', testPassed)

    // Verify deletion from DB
    const dbConfig = await loadTeamConfigFromDb('persistence-test-team')
    logTest('Team removed from database after deletion', dbConfig === null)

    // Summary
    console.log('\n=== Test Results ===')
    const passed = results.filter((r) => r.passed).length
    const total = results.length
    console.log(`\nPassed: ${passed}/${total}`)

    if (passed === total) {
      console.log('\n✅ All persistence tests passed!')
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
testPersistenceIntegration()
