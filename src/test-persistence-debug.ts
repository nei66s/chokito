#!/usr/bin/env npx tsx
/**
 * Debug Persistence Test
 * arquivo: src/test-persistence-debug.tsSimple debugging test for persistence layer
 */

import http from 'http'

const BASE_URL = 'http://localhost:3000'

async function makeRequest(method: string, path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }

    console.log(`[${method}] ${path}`)

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}`)
        try {
          const parsed = JSON.parse(data)
          console.log(`Response:`, JSON.stringify(parsed, null, 2))
          resolve({ status: res.statusCode, body: parsed })
        } catch (e) {
          console.log(`Response (raw):`, data)
          resolve({ status: res.statusCode, body: data })
        }
      })
    })

    req.on('error', (error) => {
      console.error('Request error:', error.message)
      reject(error)
    })

    if (body) {
      const jsonBody = JSON.stringify(body)
      console.log(`Body:`, JSON.stringify(body, null, 2))
      req.write(jsonBody)
    }

    req.end()
  })
}

async function test() {
  try {
    console.log('\n=== Testing Persistence Layer ===\n')

    // Test 1: Create team
    console.log('--- Test 1: Create Team ---')
    let result = await makeRequest('POST', '/api/swarm/teams', {
      name: 'debug-test-team',
      description: 'Debug test',
    })
    console.log()

    // Test 2: List teams
    console.log('--- Test 2: List Teams ---')
    result = await makeRequest('GET', '/api/swarm/teams')
    console.log()

    // Test 3: Shutdown
    console.log('--- Test 3: Shutdown Team ---')
    result = await makeRequest('POST', '/api/swarm/teams/debug-test-team/shutdown')
    console.log()

    console.log('\n✅ Debug test complete')
  } catch (error) {
    console.error('\n❌ Error:', error)
    process.exit(1)
  }
}

test()
