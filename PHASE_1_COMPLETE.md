# Fase 1: MVP Complete ✅

**Status**: Fase 1 completada com sucesso. Chocks está pronto para uso em equipes internas.

## Resumo de Completação

### Implementado nesta Fase
- ✅ **Modal de Rename/Move** — substitui `window.prompt()` por modal elegante
- ✅ **Melhorias de UX** — corrigido modelo de IA (gpt-4o-mini)
- ✅ **npm run dev** — agora funciona sem erros (EADDRINUSE resolvido)
- ✅ **File Preview** — texto, imagem, binário com fallback
- ✅ **File Actions** — copy, duplicate, create, edit, save, move, rename, delete
- ✅ **Permission UX** — categoria toggles, approval mgmt, revocation
- ✅ **Workflow Operations** — reset, archive, resume, edit steps, block markers
- ✅ **Visual Modernization** — theme system, professional polish, responsive design
- ✅ **Functional UI Cleanup** — removidas elementos cenogarfic (semântica clara)
- ✅ **TypeScript Build** — zero erros, passes cleanly

### Funcionalidades Estáveis
- Conversas persistidas em Postgres
- Streaming real-time de respostas
- Tool execution com permission gating
- File browser integrado com workspace
- Moderation de conteúdo
- Approvals por conversation
- localStorage para state persistence

### Arquitetura Funcionando
```
┌─────────────────────────────────────┐
│    Browser (Single-page app)        │
│  ├─ Welcome screen                  │
│  ├─ Chat view com streaming         │
│  ├─ File browser + preview          │
│  ├─ Workflow editor                 │
│  └─ Permission manager              │
├─────────────────────────────────────┤ HTTP/WebSocket
│   Express.js + TypeScript Server    │
│  ├─ POST /chat/stream               │
│  ├─ POST /tools/run                 │
│  ├─ GET /workflow/status            │
│  ├─ GET /files/raw                  │
│  └─ CRUD /conversations/*           │
├─────────────────────────────────────┤ SQL
│   PostgreSQL Database               │
│  ├─ conversations                   │
│  ├─ messages                        │
│  ├─ workflow_plans                  │
│  └─ app_todos                       │
└─────────────────────────────────────┘
```

### Ferramentas Disponíveis (20+)
- **File**: file_read, file_write, file_edit, file_copy, file_delete, file_move
- **Directory**: directory_create, glob, grep, ls_safe
- **Bash**: bash_exec (com validação)
- **Web**: web_fetch
- **Workflow**: workflow_get, workflow_replace, workflow_update_step, workflow_clear
- **Todo**: todo_list, todo_add, todo_update
- **Env**: env_get, pwd

### Tested & Verified
- npm run build: ✅ zero errors
- npm run dev: ✅ server starts on :3000
- File preview: ✅ text/image/binary
- Modal rename: ✅ funcional
- Permission modal: ✅ category toggles working

## Próximas Fases (Roadmap)

### Fase 2: Permission Pipeline + Hook System (3-4 weeks)
- 7-step permission gauntlet (deny/ask/allow rules)
- Event hooks (20+ types: PreToolUse, SessionStart, etc)
- Audit logging
- Per-path/per-user permissions

### Fase 3: Bash Security (3-4 weeks)
- Tree-sitter AST parsing
- Sandbox via bubblewrap/seatbelt
- Safe sed edit preview

### Fase 4: Plugin System (4 weeks)
- Plugin marketplace
- Hot-reload
- Dependency resolution
- 40+ example plugins

### Fase 5: QueryEngine (2-3 weeks)
- Two-layer message compression
- Token accounting
- Auto-compaction

### Fase 6: Coordinator Mode (3-4 weeks)
- Multi-agent orchestration
- Worker dispatch
- Shared state management

## Deployment Notes

### Environment Variables
```bash
DATABASE_URL=postgresql://...
OPENAI_API_KEY=sk-...
ALLOW_BASH_EXEC=false        # Default: disabled
ALLOW_WEB_FETCH=false        # Default: disabled
MAX_FILE_BYTES=524288        # 512KB default
WEB_FETCH_ALLOWLIST=...      # Comma-separated domains
```

### Start Development
```bash
cd agent-ts
npm install
npm run build
npm run dev
# Server listens on http://localhost:3000
```

### Production Deployment
- Build: `npm run build`
- Output: JavaScript in `dist/`
- Runtime: `node dist/server.js` (or via PM2/systemd)
- Database: Requires Postgres initialization

## Technical Debt & Feedback Wishlist

### Small Improvements
- [ ] Syntax highlighting in file preview (add highlight.js)
- [ ] Keyboard shortcuts panel
- [ ] Dark mode toggle (WCAG AA contrast audit)
- [ ] Accessibility: keyboard navigation polish

### Infrastructure
- [ ] Smoke tests for critical flows
- [ ] Logging setup (Pino/Winston)
- [ ] Error boundary in UI
- [ ] Retry logic for tool failures

### Future Extensibility
- [ ] Custom tool creation flow
- [ ] Local file watcher (auto-refresh on external edits)
- [ ] Conversation templates
- [ ] Workflow templates

## Success Metrics
- ✅ Core chat works end-to-end
- ✅ File operations stable
- ✅ Server doesn't crash on rapid requests
- ✅ Permissions enforceable
- ✅ Visual UI professional (no ambiguous controls)
- ✅ Ready for 2-5 person team use

---

**Handoff State**: MVP stable and ready. Next: decide on Fase 2 priority (Async Permissions vs. immediate polish/testing).
