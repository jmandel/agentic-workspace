# Agentic Workspace — Reference Implementation

Minimal reference implementation of the Agentic Workspace protocol.
Runs Claude inside Docker containers, exposes ACP over WebSocket.

## Architecture

```
┌──────────────┐    REST API     ┌─────────────────────────────┐
│  CLI (cli.ts)│───────────────→ │  wsmanager (wsmanager.ts)   │
│              │                 │  :31337                      │
│  ws create   │                 │  - POST/GET/DELETE /workspaces│
│  ws list     │                 │  - reads token from keychain │
│  ws connect  │                 │  - docker run per workspace  │
└──────┬───────┘                 └──────────┬──────────────────┘
       │                                    │ docker run
       │ WebSocket                          ▼
       │                         ┌─────────────────────────┐
       └────────────────────────→│  wmlet container        │
                                 │  :52001 (per workspace) │
                                 │                         │
                                 │  wmlet.ts               │
                                 │   ├─ ACP SDK            │
                                 │   ├─ claude-agent-acp   │
                                 │   └─ WebSocket ↔ stdio  │
                                 │                         │
                                 │  /workspace/ (files+git)│
                                 └─────────────────────────┘
```

**wsmanager** — runs on the host, manages workspace lifecycle via Docker.
Reads Claude OAuth token from macOS keychain and injects it into containers.

**wmlet** — runs inside each container. Spawns `claude-agent-acp`, communicates
via ACP protocol (JSON-RPC over stdio), and exposes it as a WebSocket endpoint.

**cli** — command-line client to create, list, connect to workspaces.

## Quick Start

```bash
# 1. Build the workspace container image
docker build -t agrp-wmlet .

# 2. Start the workspace manager
bun run wsmanager.ts

# 3. Create a workspace
bun run ws create my-task

# 4. Connect and chat with Claude
bun run ws connect my-task
```

## CLI Commands

```
bun run ws list                 List all workspaces
bun run ws create <name>        Create a new workspace
bun run ws connect <name>       Connect to workspace (interactive chat)
bun run ws delete <name>        Delete workspace (stops container)
bun run ws health               Show manager status
```

Inside a connected session, type a message and press Enter.
Type `/quit` to disconnect.

## API

### Workspace Manager (REST)

```
POST   /workspaces          Create workspace  { "name": "my-task" }
GET    /workspaces          List workspaces
GET    /workspaces/:name    Get workspace details + ACP endpoint
DELETE /workspaces/:name    Delete workspace
GET    /health              Manager health
```

### Workspace ACP (WebSocket)

Connect: `ws://localhost:<port>/acp?session=<id>`

Messages from client:
```json
{ "type": "prompt", "data": "your message here" }
```

Messages from server:
```json
{ "type": "connected", "session": "default", "sessionId": "..." }
{ "type": "text", "data": "response chunk" }
{ "type": "tool_call", "title": "Read", "status": "running" }
{ "type": "tool_update", "toolCallId": "...", "status": "completed" }
{ "type": "done" }
{ "type": "error", "data": "error message" }
{ "type": "system", "data": "starting agent..." }
```

## Files

| File | Runs | Purpose |
|------|------|---------|
| `wsmanager.ts` | Host | REST API, manages Docker containers |
| `wmlet.ts` | Container | ACP bridge: claude-agent-acp ↔ WebSocket |
| `cli.ts` | Host | CLI client |
| `Dockerfile` | — | Container image: bun + node + claude-agent-acp |

## Requirements

- [Bun](https://bun.sh) runtime
- Docker
- Claude subscription (token read from macOS keychain)
