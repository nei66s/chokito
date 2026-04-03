# Chocks: Roadmap Detalhado

**Status Atual**: Fase 1 (MVP) COMPLETA ✅

Veja [PHASE_1_COMPLETE.md](./PHASE_1_COMPLETE.md) para detalhes da conclusão.

## Fase 1: MVP ✅ (Completado)

Entrega: Chocks funcional para equipes internas pequenas.

**Implementado**:
- UI pro com modal rename/move
- File preview (text/image/binary)
- File actions (read, edit, copy, duplicate, create, delete, move)
- Permission UX (ask/auto/read_only, category toggles, approval mgmt)
- Workflow operations (reset, archive, resume, edit steps)
- npm run dev funcionando sem erros
- Build passar com zero erros TypeScript

## Ja implementado

- UI principal em `public/index.html`
- backend em `src/server.ts`
- loop do agente em `src/llm.ts`
- tools locais em `src/tools.ts`
- conversas persistidas em Postgres
- ownership por usuario local do navegador
- streaming real de resposta
- trace de tools ao vivo e dobravel
- workflow/planning por conversa
- sidebar com:
  - `Novo bate-papo`
  - `Procurar`
  - `Conversas`
  - `Ferramentas`
  - `Arquivos`
  - `Workflow`
  - `Config`
- anexo de arquivo no composer com validacao
- acesso total ao computador com toggle
- permission pipeline com modos:
  - `ask`
  - `auto`
  - `read_only`
- aprovacao interativa por acao no trace
- `Permitir sempre nesta conversa`
- leitura, escrita, edicao e exclusao de arquivos
- mover/renomear item
- criar pasta
- listar pasta
- download de arquivo
- navegador de arquivos no chat com:
  - breadcrumbs
  - abrir pasta no mesmo bloco
  - subir nivel
  - acoes por item
- workspace lateral de arquivos persistente e sincronizado com a navegacao

## O que ainda falta fazer

### 1. Preview de arquivo no workspace

Status: base implementada.

Ja pronto:
- preview direto no workspace lateral para texto/codigo
- preview de imagem no proprio app
- fallback para download quando nao for textual
- leitura de arquivo sem gerar nova resposta no chat

Pendencias pequenas:
- syntax highlight real (hoje o preview e monoespacado, sem parser de linguagem)
- preview mais rico para alguns binarios especificos

### 2. Fluxo melhor para leitura de arquivo

Status: implementado.

Ja pronto:
- acao `Ler/Preview` abre no workspace
- imagens abrem como preview visual
- binario/arquivo grande cai para fallback de download

### 3. Acoes de arquivo mais completas

Status: implementado em boa parte.

Ja pronto:
- copiar arquivo/pasta (`file_copy`)
- duplicar arquivo/pasta
- criar arquivo vazio
- editar e salvar arquivo direto pelo workspace
- criar pasta por caminho relativo no workspace (sem `prompt()` cru)

Pendencias pequenas:
- fluxo de rename/move ainda usa `prompt()`

### 4. UX melhor para permissoes

Status: base implementada.

Ja pronto:
- visualizacao de permissoes ativas por conversa
- revogacao individual
- revogar tudo
- permitir/revogar por categoria (`leitura`, `escrita`, `exclusao`, `web`, `shell`)
- feedback mais claro de bloqueio no workspace

Pendencias pequenas:
- pode evoluir para painel dedicado em vez de ficar dentro de `Config`

### 5. Permissoes mais fortes no backend

Hoje a politica ja existe, mas pode amadurecer.

Falta:
- regras por categoria de tool
- regras por path
- diferenciar leitura e escrita por pasta
- permitir somente algumas raizes fora do projeto
- auditoria de acoes sensiveis

### 6. Acesso ao computador do usuario final

Limite atual importante:
- o acesso ao filesystem e da maquina onde o backend roda

Possiveis proximos passos:
- modo `pasta concedida pelo usuario` no navegador
- bridge desktop local
- agente local por usuario

### 7. MCP real

Ainda nao implementado.

Sugestoes de inicio:
- GitHub
- docs
- banco
- deploy

Requisitos antes de fazer direito:
- manter permission pipeline
- mostrar origem da tool
- deixar visivel quando a tool vier de MCP

### 8. Subagentes

Ainda nao implementado.

Base ja preparada conceitualmente:
- workflow
- trace
- persistencia

Falta:
- spawn de subtarefa
- retorno agregado
- estado de subagentes na UI
- regras de permissao para delegacao

### 9. Workflow mais operacional

Status: base implementada.

Ja pronto:
- resetar workflow na UI
- arquivar workflow (local por conversa)
- editar etapas manualmente
- marcar bloqueios manualmente
- retomar tarefa anterior via acao de resume no chat

Pendencias pequenas:
- arquivamento server-side (hoje local)
- historico de multiplos workflows por conversa

### 10. Sessao e autenticacao real

Hoje existe isolamento por owner local.

Falta:
- login real
- sessao por usuario
- compartilhamento entre dispositivos
- controle de acesso de verdade

### 11. Compartilhamento real

Hoje `Compartilhar` copia texto.

Falta:
- URL de conversa
- snapshot compartilhavel
- permissao de leitura
- export estruturado

### 12. Persistencia de anexos mais robusta

Hoje o fluxo esta mais orientado a texto.

Falta:
- armazenar anexos completos no backend
- metadata melhor
- download e reuso posterior
- suporte melhor a binarios/imagens

### 13. Melhorias visuais ainda pendentes

Falta:
- syntax highlight real no preview de codigo
- empty states do workspace de arquivos
- estados de carregamento mais suaves
- densidade melhor no mobile
- cards de acao menos dependentes de `prompt()`

## Ordem recomendada

Se continuar em ordem de valor real:

1. Endurecer backend de permissoes por categoria/path e auditoria
2. Melhorar UX de rename/move sem `prompt()`
3. Persistir arquivo de workflow no backend (nao so localStorage)
4. MCP real
5. Subagentes

## Observacoes

- Antes de implementar MCP e subagentes, vale manter o foco em UX real e capacidades concretas.
- O maior proximo salto de usabilidade agora e fazer o workspace de arquivos virar um lugar onde da para navegar e inspecionar sem sempre gerar novas mensagens.

## Resumo rapido do estado atual

Ja entregue nesta rodada:
- preview de arquivo no workspace (texto/imagem/fallback)
- leitura sem depender do chat
- acoes de arquivo: copiar/duplicar/criar vazio/editar/salvar
- UX de permissoes por conversa com revogacao por tool e por categoria
- workflow operacional base (reset, arquivar local, editar etapa, marcar bloqueio, retomar)

Ainda pendente para proximas rodadas:
- endurecimento de permissoes no backend por categoria/path + auditoria
- substituir prompts de rename/move por UI dedicada
- persistir workflow arquivado no backend (hoje localStorage)
- syntax highlight real no preview
