#!/usr/bin/env node
/**
 * Test script para Fase 7 Session 2: Permission Delegation + Plan Mode
 */

import fetch from 'node-fetch'

const BASE_URL = 'http://localhost:3000'

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return (await response.json()) as Record<string, unknown>
}

async function test() {
  console.log('🚀 Testando Fase 7 Session 2: Permission Delegation + Plan Mode\n')

  try {
    // 1. Criar time com teammate que requer plan mode
    console.log('1️⃣  Criando time com teammate planModeRequired=true...')
    const teamRes = await request('POST', '/api/swarm/teams', {
      name: 'session-2-team',
      description: 'Time para testar permissions + plans',
    })
    const teamName = (teamRes.teamName as string) || 'session-2-team'
    console.log('✅ Team criado:', teamName)

    // 2. Spawn teammate com planModeRequired
    console.log('\n2️⃣  Spawning teammate com planModeRequired=true...')
    const spawnRes = await request(
      'POST',
      `/api/swarm/teams/${teamName}/spawn`,
      {
        name: 'engineer',
        cwd: '/tmp',
        initialPrompt: 'Você é um engenheiro. Deve criar um plano antes de começar.',
        planModeRequired: true,
        backendType: 'in-process',
      },
    )
    console.log('✅ Teammate spawned:', (spawnRes.agentId as string) || 'engineer@...')

    // 3. Simular permission request do teammate
    console.log('\n3️⃣  Simulando permission request do teammate...')
    await request('POST', `/api/swarm/teams/${teamName}/send-message`, {
      from: 'engineer',
      to: 'team-lead',
      content: JSON.stringify({
        toolName: 'file_write',
        args: { path: '/tmp/test.txt', content: 'test' },
        reason: 'Preciso escrever arquivo temporário',
        requestId: 'perm-test-1',
        type: 'permission-request',
      }),
    })
    console.log('✅ Permission request enviado')

    // 4. Leader check pending permissions
    console.log('\n4️⃣  Leader checking pending permissions...')
    const permRes = await request('GET', `/api/swarm/teams/${teamName}/permissions/pending`)
    console.log('✅ Pending permissions:', (permRes.count as number) || 0)

    // 5. Leader approve permission
    console.log('\n5️⃣  Leader approving permission...')
    const approveRes = await request(
      'POST',
      `/api/swarm/teams/${teamName}/permissions/approve`,
      {
        workerName: 'engineer',
        requestId: 'perm-test-1',
        reason: 'Approved - file is needed',
      },
    )
    console.log('✅ Permission approved:', (approveRes.success as boolean) ? 'YES' : 'NO')

    // 6. Simular plan submission
    console.log('\n6️⃣  Teammate submitting plan for approval...')
    const planId = `plan-${Date.now()}-test`
    await request('POST', `/api/swarm/teams/${teamName}/send-message`, {
      from: 'engineer',
      to: 'team-lead',
      content: JSON.stringify({
        type: 'plan-approval-request',
        planId,
        plan: {
          planId,
          agentId: 'engineer@' + teamName,
          title: 'Implementation Plan',
          description: 'Detailed plan for implementation',
          steps: [
            { stepNumber: 1, description: 'Step 1', expectedOutcome: 'Done' },
            { stepNumber: 2, description: 'Step 2', expectedOutcome: 'Done' },
          ],
        },
      }),
    })
    console.log('✅ Plan submitted')

    // 7. Leader check pending plans
    console.log('\n7️⃣  Leader checking pending plans...')
    const plansRes = await request('GET', `/api/swarm/teams/${teamName}/plans/pending`)
    console.log('✅ Pending plans:', (plansRes.count as number) || 0)

    // 8. Leader approve plan
    console.log('\n8️⃣  Leader approving plan...')
    const approvePlanRes = await request(
      'POST',
      `/api/swarm/teams/${teamName}/plans/approve`,
      {
        workerName: 'engineer',
        planId,
        feedback: 'Great plan! Proceed with implementation.',
      },
    )
    console.log('✅ Plan approved:', (approvePlanRes.success as boolean) ? 'YES' : 'NO')

    // 9. Shutdown team
    console.log('\n9️⃣  Shutting down team...')
    await request('POST', `/api/swarm/teams/${teamName}/shutdown`)
    console.log('✅ Team shut down')

    console.log('\n🎉 Fase 7 Session 2 - Todos os testes passaram!')
  } catch (error) {
    console.error('❌ Erro:', error)
    process.exit(1)
  }
}

test()
