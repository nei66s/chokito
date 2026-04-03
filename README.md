# Chocks: TypeScript LLM Agent Server (Phase 1 Complete ✅)

Minimal agent server with a local-first web UI. **Production-ready for internal team use.**

**Status**: Fase 1 (MVP) completada. Veja [PHASE_1_COMPLETE.md](./PHASE_1_COMPLETE.md) e [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md) para roadmap futuro.

## GitHub About Metadata

- Description: Chokito is a TypeScript local-first coding agent with permission pipeline, hooks, workflow tracking, and secure bash execution.
- Website: https://github.com/nei66s/chokito/tree/main/agent-ts/chokito
- Topics: typescript, openai, ai-agent, coding-agent, permission-pipeline, workflow, hooks, bash-security, express, postgres

Main endpoints:

- `GET /conversations` - lists persisted conversations from Postgres
- `POST /conversations` - creates an empty conversation
- `PUT /conversations/:id` - replaces a conversation snapshot with messages and attachments
- `PATCH /conversations/:id` - renames a conversation
- `POST /conversations/:id/duplicate` - duplicates a conversation and its workflow
- `DELETE /conversations/:id` - deletes a conversation and related records
- `POST /chat` - sends `messages` to the OpenAI Responses API and auto-runs tool calls
- `POST /chat/stream` - streams text deltas and tool trace events
- `POST /tools/run` - runs local tools such as file, search, web, todo, and workflow actions
- `GET /tools/status` - returns enabled tool metadata
- `GET /workflow/status` - returns the active workflow plan for a specific chat via `chatId`
- `GET /files/raw` - serves a file inline for preview (for example image preview)
- `GET /` - opens the Chocks UI

Quick start:

```bash
cd agent-ts
cp .env.example .env
# set OPENAI_API_KEY (and optionally OPENAI_MODEL) in .env
npm install
npm run dev
```

What the UI already supports:

- conversations persisted in Postgres
- ownership by local browser user id, created automatically and sent to the backend
- permission mode with `ask`, `auto`, and `read_only`
- interactive approval card in the trace when an action is blocked in `ask`
- full conversation context sent to the backend on each turn
- rename, duplicate, and delete chat
- quick actions on listed files and folders such as read, list, rename, move, create folder, delete, and download
- workspace file preview for text/code and images without requiring a new chat response
- direct file editing in the workspace preview with save
- richer file actions: copy, duplicate, create empty file, create folder by relative path, download
- continuous folder navigation inside the same listing block, with open and up actions
- persistent `Arquivos` workspace in the sidebar synced with the latest browsed folder
- file attachments with validation
- real response streaming
- live tool trace with collapsible blocks
- `Workflow` sidebar for per-chat plan progress
- workflow operational controls in sidebar: reset, archive, resume prompt, and manual step updates
- permissions UX in sidebar config: show active approvals, revoke approvals, allow/revoke by category
- legacy `localStorage` chats are migrated on first load if the database is empty

Safety notes:

- `file_read`, `file_write`, and `file_edit` are restricted to `PROJECT_ROOT`
- in `ask` mode, writes, deletes, shell, and web actions require explicit user intent in the latest message
- in `read_only` mode, mutating, shell, and web tools are blocked
- `bash_exec` is disabled by default and only allows a small safe command set
- `web_fetch` is disabled by default and can use an allowlist
- `glob` and `grep` ignore `node_modules` and `.git`
- conversations, todos, and workflow state are persisted in Postgres
- records are scoped by local owner id, so different local users do not share chats by default
