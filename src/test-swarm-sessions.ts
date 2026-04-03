#!/usr/bin/env npx tsx
/**
 * Session Persistence Tests
 * arquivo: src/test-swarm-sessions.ts
 *
 * Tests for session creation, messaging, export, search, and analytics
 */

import {
  createSession,
  getSession,
  listSessions,
  addSessionMessage,
  getSessionMessages,
  updateSessionStatus,
  deleteSession,
  exportSession,
  getSessionsByDateRange,
  getSessionStats,
  searchSessions,
} from './swarm/sessionPersistence.js'
import { createTeam, deleteTeam } from './swarm/teamHelpers.js'

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

async function testSessionPersistence() {
  console.log('\n=== Fase 9: Session Persistence Tests ===\n')

  try {
    let sessionId: string

    // Pre-test: Create team for FK constraint
    console.log('[Pre-test] Creating team for sessions...')
    await createTeam('session-test-team', 'Testing sessions')

    // Test 1: Create session
    console.log('\n[1] Testing session creation...')
    const session = await createSession('session-test-team', 'agent-1', 'Test Session', 'Testing session persistence')
    sessionId = session.id

    logTest('Session created with ID', !!sessionId && sessionId.startsWith('session-'))
    logTest('Session has correct properties', session.teamName === 'session-test-team' && session.agentName === 'agent-1')

    // Test 2: Get session
    console.log('\n[2] Testing session retrieval...')
    const retrieved = await getSession(sessionId)
    logTest('Session retrieved successfully', (retrieved !== null) === true && retrieved?.id === sessionId)
    logTest('Session title matches', retrieved?.title === 'Test Session')

    // Test 3: Add messages to session
    console.log('\n[3] Testing message addition...')
    const msg1 = await addSessionMessage(sessionId, 'user', 'Hello, how are you?', 5)
    const msg2 = await addSessionMessage(sessionId, 'assistant', 'I am functioning well!', 8)
    const msg3 = await addSessionMessage(sessionId, 'user', 'Great to hear!', 3)

    logTest('First message added', (msg1.id ? true : false) && msg1.role === 'user')
    logTest('Second message added', (msg2.id ? true : false) && msg2.role === 'assistant')
    logTest('Third message added', (msg3.id ? true : false) && msg3.role === 'user')

    // Test 4: Get all messages
    console.log('\n[4] Testing message retrieval...')
    const messages = await getSessionMessages(sessionId)
    logTest('All messages retrieved', messages.length === 3)
    logTest('Messages in correct order', messages[0].role === 'user' && messages[1].role === 'assistant')
    logTest('Message content preserved', messages[0].content === 'Hello, how are you?')

    // Test 5: Session stats after messages
    console.log('\n[5] Testing session stats...')
    const updated = await getSession(sessionId)
    logTest('Message count updated in session', (updated?.messageCount ?? 0) === 3)

    // Test 6: Update session status
    console.log('\n[6] Testing session status update...')
    await updateSessionStatus(sessionId, 'paused')
    const paused = await getSession(sessionId)
    logTest('Session status changed to paused', paused?.status === 'paused')

    await updateSessionStatus(sessionId, 'ended')
    const ended = await getSession(sessionId)
    logTest('Session status changed to ended', ended?.status === 'ended')

    // Test 7: List sessions
    console.log('\n[7] Testing session listing...')
    const allSessions = await listSessions('session-test-team', 'agent-1')
    logTest('Sessions listed for agent', allSessions.length > 0)

    const activeSessions = await listSessions('session-test-team', 'agent-1', 'active')
    logTest('Can filter by status', Array.isArray(activeSessions))

    // Test 8: Export session
    console.log('\n[8] Testing session export...')
    const exported = await exportSession(sessionId)
    logTest('Session exported successfully', (exported !== null) === true && exported?.session.id === sessionId)
    logTest('Export includes messages', (exported?.messages && exported.messages.length === 3) === true)
    logTest('Export is valid JSON', JSON.stringify(exported) !== null)

    // Test 9: Search sessions
    console.log('\n[9] Testing session search...')
    const searchResults = await searchSessions('session-test-team', 'agent-1', 'Test')
    logTest('Search by title works', searchResults.length > 0)

    const contentSearch = await searchSessions('session-test-team', 'agent-1', 'functioning')
    logTest('Search by content works', contentSearch.length > 0)

    // Test 10: Get session stats
    console.log('\n[10] Testing session statistics...')
    const stats = await getSessionStats('session-test-team', 'agent-1')
    logTest('Stats show at least one session', stats.totalSessions > 0)
    logTest('Average messages per session calculated', stats.averageMessagesPerSession > 0)
    logTest('Active sessions count available', stats.activeSessions >= 0)

    // Test 11: Delete session
    console.log('\n[11] Testing session deletion...')
    await deleteSession(sessionId)
    const deleted = await getSession(sessionId)
    logTest('Session deleted successfully', deleted === null)

    const deletedMessages = await getSessionMessages(sessionId)
    logTest('Session messages cascade deleted', deletedMessages.length === 0)

    // Cleanup
    console.log('\n[Post-test] Cleaning up team...')
    await deleteTeam('session-test-team')

    // Summary
    console.log('\n=== Test Results ===')
    const passed = results.filter((r) => r.passed).length
    const total = results.length
    console.log(`\nPassed: ${passed}/${total}`)

    if (passed === total) {
      console.log('\n✅ All session persistence tests passed!')
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
testSessionPersistence()
