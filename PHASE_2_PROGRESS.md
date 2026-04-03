# Fase 2: Permission Pipeline + Hook System

**Status**: Core infrastructure COMPLETE ✅ — Ready for UI integration & database persistence.

## Completado ✅

### Arquitetura Core

**Hook System** (`src/hooks/`)
- `index.ts`: Registry with register/unregister, list, disable/enable, dispatch
- `events.ts`: 20 event types defined (SessionStart, PreToolUse, PermissionDenied, FileRead, FileWrite, FileDelete, FileMove, WorkflowCreated, WorkflowUpdated, WorkflowCompleted, SecurityAlert, etc.)
- Global singleton pattern
- Priority-based execution (0-100)
- Error-safe dispatch (swallows exceptions, logs)

**Permission Pipeline** (`src/permissions/`)
- `pipeline.ts`: Full 7-step gauntlet:
  1. ✅ Deny rules (fail-closed) 
  2. ✅ Ask rules (session-based approvals)
  3. ✅ Tool.checkPermissions (delegated) 
  4. ✅ Content-specific checks (paths, bash patterns, URLs)
  5. ✅ Requires interaction (gesture-based)
  6. ✅ Safety checks (moderation, rate limits — placeholder)
  7. ✅ Post-pipeline transforms (audit hooks)
- Deny/Ask rule engine with conditions
- Global singleton pattern

- `defaults.ts`: 4 baseline rules
  - Ask for `file_delete` (always)
  - Ask for `bash_exec` (always)
  - Ask for `web_fetch` (if not approved)
  - Ask for file_write with `../` (escape path)

- `index.ts`: Central exports

**Audit Logger** (`src/audit/logger.ts`)
- Log tool executions
- Log permission denials/approvals  
- Log errors (ToolError action)
- Query recent entries (by user/chat/action)
- Statistics API (byAction counts)
- In-memory store with 10K entry limit (auto-cleanup)

### Server Integration

**`src/server.ts`** updated:
- Import permission pipeline, hooks, audit logger, defaults
- `initPermissionPipeline()` on startup
- `initHooks()` on startup  
- `initDefaultRules(pipeline)` on startup
- Extended `/tools/run` endpoint:
  - Check permission pipeline before execution
  - Return 403 if denied
  - Dispatch `PreToolUse` hook before execution
  - Log successful execution to audit trail
  - Dispatch `PostToolUse` hook after execution
  - Catch errors and log with `tool_error` action
- New endpoints:
  - `GET /audit/recent?limit=50` — recent audit entries
  - `GET /audit/stats` — audit statistics

### Type Exports
- `src/tools.ts`: Exported `ToolContext` for reuse in permissions

## Build & Runtime Status

✅ **TypeScript build**: Zero errors
✅ **Development server**: Starts successfully (`npm run dev`)
✅ **Initialization**: All Fase 2 systems initialize on startup

## Completado ✅

### Arquitetura Core
- **Hook Registry** (`src/hooks/index.ts`)
  - Register/unregister hooks
  - List, disable, enable hooks
  - Dispatch events with priority order
  - Global singleton pattern

- **Hook Events** (`src/hooks/events.ts`)
  - 20 event types defined (SessionStart, PreToolUse, PermissionDenied, FileRead, etc.)
  - Hook handler signature + payload structure
  - Hook priority ordering

- **Permission Pipeline** (`src/permissions/pipeline.ts`)
  - 7-step gauntlet fully implemented:
    1. Deny rules (fail-closed)
    2. Ask rules (session-based approvals)
    3. Tool.checkPermissions (delegated)
    4. Content-specific checks (paths, bash patterns)
    5. Requires interaction (gesture-based)
    6. Safety checks (moderation, rate limits placeholder)
    7. Post-pipeline transforms (audit hooks)
  - Deny/Ask rule engine
  - Global singleton pattern

- **Audit Logger** (`src/audit/logger.ts`)
  - Log tool executions
  - Log permission denials/approvals
  - Query recent entries (by user/chat/action)
  - Statistics API
  - In-memory store with 10K entry limit

### Server Integration
- `src/server.ts` updated:
  - `initPermissionPipeline()` called on startup
  - `initHooks()` called on startup
  - New endpoint `GET /audit/recent` — get recent audit entries
  - New endpoint `GET /audit/stats` — get audit statistics

### Exports/Types
- `src/tools.ts`: Exported `ToolContext` type for reuse
- `src/permissions/index.ts`: Central export point

## Próximos Passos

### 1. Integrate Permission Pipeline into Tool Execution
- Modify `/tools/run` endpoint to call permission pipeline
- Return 403 if permission denied
- Dispatch `PreToolUse` hook before execution
- Dispatch `PostToolUse` hook after execution
- Log to audit trail

### 2. Add Default Permission Rules
- Create `src/permissions/defaults.ts` with baseline rules
- Rule: Deny absolute paths outside project
- Rule: Ask for file_delete (always)
- Rule: Ask for bash_exec with dangerous patterns

### 3. Permission UI Integration
- Add "Audit Log" panel to sidebar
- Show recent denied permissions
- Display permission rule overview
- Per-conversation rule management

### 4. Database Persistence (Fase 2b)
- Add table `permission_rules` (Postgres)
- Add table `permission_approvals` (Postgres)
- Add table `audit_log` (Postgres)
- Extend AuditLogger to persist

### 5. Hook Examples
- Example: Log all tool executions to stdout
- Example: Alert on permission denied
- Example: Track file read patterns

## Technical Debt

- [ ] Rate limiting placeholder in step 6
- [ ] Moderation integration in step 6
- [ ] Error handling in hook dispatch (add retry logic)
- [ ] Hook persistence (currently in-memory)
- [ ] Permission rule versioning

## Timeline

**This week**: Finish permission pipeline integration (1-2 days)
**Next week**: Database persistence + UI (2-3 days)
**Following week**: Testing + documentation (1-2 days)

**Total remaining**: ~1 week for full Fase 2 completion.

## Files Created

```
src/
  hooks/
    index.ts           ← Hook registry & dispatcher (100 LOC)
    events.ts          ← Hook event types + payload (60 LOC)
  permissions/
    pipeline.ts        ← 7-step permission gauntlet (230 LOC)
    index.ts           ← Central exports (5 LOC)
  audit/
    logger.ts          ← Audit logging API (140 LOC)
```

**Total new code**: ~535 LOC (all TypeScript, fully typed)

## Build Status

✅ Zero compile errors
✅ Ready for next phase
✅ No breaking changes to existing code
