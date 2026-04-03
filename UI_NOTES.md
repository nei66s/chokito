# Chocks UI Notes

This file documents the current visual interface for Chocks in `public/index.html`.

## Overview

The UI was redesigned to feel closer to Claude's web app structure while staying simple and local-first.

It has 2 major states:

1. Welcome state
   Shows a centered landing view with:
   - a headline
   - a large composer card
   - suggestion chips

2. Chat state
   Shows:
   - the conversation header in the top bar
   - message history
   - a bottom composer
   - tool traces under assistant messages

The sidebar remains visible on desktop in both states.

## Layout Structure

Main file:
- [index.html](C:\Users\bsilv\OneDrive\Desktop\claude-reviews-claude\agent-ts\public\index.html)

High-level sections:
- `.sidebar`
- `.topbar`
- `.welcome-view`
- `.chat-view`

The page uses a 2-column app shell:
- left sidebar
- right main content area

## Sidebar

The sidebar is designed to resemble Claude's information hierarchy:

- Brand row
  - Chocks badge
  - title
  - small utility icon

- Primary navigation
  - `Novo bate-papo`
  - `Procurar`
  - `Personalizar`

- Workspace navigation
  - `Conversas`
  - `Ferramentas`
  - `Workflow`
  - `Config`

- Recent chats
  Rendered from local storage into `#recent-list`

- Profile footer
  Shows a simple local user card

## Welcome State

The welcome state is shown when the active chat has no messages.

Important elements:
- `#welcome-view`
- `#welcome-prompt`
- `#welcome-send`

Behavior:
- typing a first prompt creates the first user message
- the chat title is auto-generated from the first prompt
- the UI switches to the chat state after submission

## Chat State

The chat state is shown when the active conversation has at least one message.

Important elements:
- `#chat-view`
- `#messages`
- `#messages-inner`
- `#chat-prompt`
- `#chat-send`

Message rendering:
- user messages are right-aligned
- assistant messages are left-aligned
- assistant messages may include a tool trace block
- directory listing responses can render quick actions for files and folders
- opening a folder from a listing updates that same listing block instead of always creating a new assistant message
- the sidebar now includes an `Arquivos` workspace that keeps the latest browsed folder available across reloads
- the `Arquivos` workspace now includes inline preview for text/code and image files
- file reading from listing and sidebar opens the workspace preview instead of forcing a chat turn
- the preview panel supports direct text editing and save

## Persistence

Conversations are now stored in Postgres through the backend.

Keys:
- `chocks_active_chat_v2`

Stored per chat:
- `id`
- `title`
- `messages`

Stored per message:
- `role`
- `content`
- optional `trace`

`localStorage` is still used for:
- active chat id
- workspace mode
- local UI personalization
- local permission mode
- local browser user id and display name

Legacy chats from the old `localStorage` model are migrated to the backend on first load when the database is empty.

## Tool Trace Rendering

Assistant tool activity is rendered below assistant responses.

The trace supports:
- `tool_call`
- `tool_output`

This is intended to keep agent behavior visible in the interface without exposing raw protocol details directly in the main message bubble.

When a tool is blocked by permission policy in `ask` mode, the trace can render an inline approval card so the user can authorize that specific action and run it immediately.

The `Config` workspace now also shows active per-conversation approvals, and allows:
- grant/revoke by category (`leitura`, `escrita`, `exclusao`, `web`, `shell`)
- revoking individual tool approvals
- clearing all persistent approvals in the current conversation

## Workflow Sidebar

The `Workflow` sidebar mode shows the active plan stored by the backend for the current conversation.

It displays:
- current goal
- optional summary
- ordered steps
- per-step status
- progress and last update time

It now also supports operational actions in the sidebar:
- reset workflow
- archive workflow locally per conversation
- resume task via a generated follow-up message
- manual step editing and status updates
- manual blocker tagging on a step

Important endpoint:
- `GET /workflow/status?chatId=...`

Conversation endpoints:
- `GET /conversations`
- `POST /conversations`
- `PUT /conversations/:id`
- `PATCH /conversations/:id`
- `POST /conversations/:id/duplicate`
- `DELETE /conversations/:id`

## Main Client Functions

Important functions inside `public/index.html`:

- `loadChats()`
  Reads chats from local storage.

- `saveChats(chats)`
  Persists chats.

- `createChat(seedTitle)`
  Creates a new empty conversation and marks it active.

- `renderRecentList()`
  Rebuilds the sidebar recent chat list.

- `renderMessages(chat)`
  Renders chat messages into the main view.

- `renderApp()`
  Decides whether to show welcome state or chat state.

- `submitMessage(text)`
  Sends the prompt to `/chat`, stores messages, and re-renders the UI.

## Styling Direction

The current visual system uses:
- warm dark neutrals
- serif headline for the landing view
- sans-serif interface typography
- soft rounded panels and borders

Design goal:
- closer to Claude's product structure
- not a literal clone
- simple enough to keep editing in one HTML file

## Editing Guide

If you want to tweak visual behavior later, use this map:

- Sidebar width and spacing
  Edit `.app` and `.sidebar`

- Welcome screen appearance
  Edit `.welcome-view`, `.welcome-shell`, `.welcome-title`, `.composer-card`

- Chat layout
  Edit `.chat-view`, `.messages`, `.messages-inner`

- Message bubbles
  Edit `.message`, `.bubble`, `.message-row`

- Bottom composer
  Edit `.chat-composer`, `.chat-toolbar`

- Recent chat behavior
  Edit `renderRecentList()`

- App state switching
  Edit `renderApp()`

## Known Limitations

- Workflow is now scoped per conversation and persisted on the server with the chat data
- Ownership is based on a local browser user id, not full authentication
- Workflow archive is local UI state in browser storage, not shared server-side
- Permission category toggles map to tool allowlists; backend category policies are still not first-class rules
- Mobile layout is simplified compared to desktop

## Suggested Next Steps

Natural next improvements:

1. Add real authentication on top of the local owner model
2. Add explicit workflow controls to the UI such as reset and archive
3. Persist and render richer attachment metadata beyond file name
4. Split the HTML file into separate CSS and JS files if the UI grows further
