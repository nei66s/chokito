#!/usr/bin/env node
/**
 * Test script para Fase 7: Agent Swarms endpoints
 * Roda testes básicos da API REST
 */
import fetch from 'node-fetch';
const BASE_URL = 'http://localhost:3000';
async function request(method, path, body) {
    const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
}
async function test() {
    console.log('🚀 Testando Fase 7: Agent Swarms API\n');
    try {
        // 1. Criar time
        console.log('1️⃣  POST /api/swarm/teams - Criando novo time...');
        const teamRes = await request('POST', '/api/swarm/teams', {
            name: 'test-team',
            description: 'Time de teste para Fase 7',
        });
        console.log('✅ Time criado:', JSON.stringify(teamRes, null, 2));
        const teamName = teamRes.teamName;
        // 2. Listar times
        console.log('\n2️⃣  GET /api/swarm/teams - Listando times...');
        const listRes = await request('GET', '/api/swarm/teams');
        console.log('✅ Times encontrados:', listRes.count);
        console.log(JSON.stringify(listRes, null, 2).substring(0, 200));
        // 3. Spawn teammate
        console.log('\n3️⃣  POST /api/swarm/teams/:teamName/spawn - Spawning teammate...');
        const spawnRes = await request('POST', `/api/swarm/teams/${teamName}/spawn`, {
            name: 'researcher',
            cwd: '/tmp',
            initialPrompt: 'Você é um pesquisador especialista. Comece investigando o problema.',
            backendType: 'in-process',
        });
        console.log('✅ Teammate spawned:', JSON.stringify(spawnRes, null, 2));
        // 4. Send message
        console.log('\n4️⃣  POST /api/swarm/teams/:teamName/send-message - Enviando mensagem...');
        const msgRes = await request('POST', `/api/swarm/teams/${teamName}/send-message`, {
            from: 'team-lead',
            to: 'researcher',
            content: 'Faça uma análise aprofundada do problema descrito.',
        });
        console.log('✅ Mensagem enviada:', JSON.stringify(msgRes, null, 2));
        // 5. Read mailbox
        console.log('\n5️⃣  GET /api/swarm/teams/:teamName/mailbox/:agentName - Lendo mailbox...');
        const mailboxRes = await request('GET', `/api/swarm/teams/${teamName}/mailbox/team-lead`);
        console.log('✅ Mensagens na mailbox:', mailboxRes.count);
        console.log(JSON.stringify(mailboxRes, null, 2).substring(0, 300));
        // 6. Shutdown team
        console.log('\n6️⃣  POST /api/swarm/teams/:teamName/shutdown - Encerrando time...');
        const shutdownRes = await request('POST', `/api/swarm/teams/${teamName}/shutdown`);
        console.log('✅ Time encerrado:', JSON.stringify(shutdownRes, null, 2));
        console.log('\n🎉 Todos os testes passaram!');
    }
    catch (error) {
        console.error('❌ Erro:', error);
        process.exit(1);
    }
}
test();
