#!/usr/bin/env npx tsx
/**
 * Debug Spawn and Message Tests
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
    console.log('\n=== Debugging Spawn and Message ===\n')

    // Create team first
    console.log('--- Create Team ---')
    let result = await makeRequest('POST', '/api/swarm/teams', {
      name: 'debug-spawn-team',
      description: 'Debug spawn',
    })
    console.log()

    // Spawn member
    console.log('--- Spawn Member ---')
    result = await makeRequest('POST', '/api/swarm/teams/debug-spawn-team/spawn', {
      name: 'agent-tester',
      role: 'assistant',
    })
    console.log()

    // Send message
    console.log('--- Send Message ---')
    result = await makeRequest('POST', '/api/swarm/teams/debug-spawn-team/send-message', {
      from: 'agent-tester',
      to: 'leader',
      type: 'direct-message',
      content: 'Test message',
    })
    console.log()

    // Cleanup
    console.log('--- Shutdown ---')
    result = await makeRequest('POST', '/api/swarm/teams/debug-spawn-team/shutdown')
    console.log()
  } catch (error) {
    console.error('\n❌ Error:', error)
    process.exit(1)
  }
}

test()
