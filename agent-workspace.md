# Agent Workspace Protocol

**Status:** Draft
**Date:** March 2026
**Working Group:** Agent-Workspace-Protocol / working-draft

---

## 1. What is a Workspace

A workspace is an environment for humans and agents to collaborate on shared resources — code, documents, data, or any other resources relevant to the task at hand.

Participants communicate through a shared conversation thread and act on resources through tools — all in one place. Every action is visible to everyone: who did what, why, and when. Humans connect from IDEs, terminals, or messengers. Agents live inside the workspace as persistent instances.

Tools are governed by granular access control: each tool can be freely available, restricted by role, or require explicit approval for every use. Participants can delegate specific permissions to each other — a human can grant an agent the right to deploy, or an agent can request shell access for a particular task. This makes a workspace a controlled operational environment, not just a shared folder.

A workspace has an email-like identity (e.g. `payments-debug.acme@relay.example.com`). This identity serves multiple purposes: it is the address for receiving external events (webhooks, emails, scheduled triggers), the subject for access control (granting permissions to a workspace as a whole), and the principal for workload identity when accessing external services. A workspace is not an isolated bubble but an addressable, authenticatable participant in broader workflows.

A workspace is defined by a declarative specification and is not tied to a specific machine or platform. The same workspace can run locally, in a private cloud, or in a public cloud — any compliant runtime can host it.

The entire workspace state — resources, conversation, configuration — is versioned. Participants can commit a snapshot, roll back to any previous point, or clone the workspace to experiment safely.

---

## 2. Workspace Manager

Workspace Manager is a service that manages workspace lifecycle — creating, listing, connecting, suspending, and terminating workspaces. It exposes a REST API that clients use before establishing an ACP connection.

The typical flow: a client calls the Manager API to create or find a workspace, receives a connection endpoint, and then connects via ACP to participate.

### API

All resources are scoped to a namespace, following the Kubernetes convention.

```
POST   /apis/v1/namespaces/{ns}/workspaces                — create a workspace
GET    /apis/v1/namespaces/{ns}/workspaces                — list workspaces
GET    /apis/v1/namespaces/{ns}/workspaces/{name}         — get workspace details and connection endpoint
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}         — terminate a workspace
PUT    /apis/v1/namespaces/{ns}/workspaces/{name}/suspend — suspend a workspace
PUT    /apis/v1/namespaces/{ns}/workspaces/{name}/resume  — resume a suspended workspace
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/clone   — clone a workspace
```

Workspace state versioning:

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/commits              — list commits
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/commits              — create a commit (snapshot)
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/commits/{commit}     — get commit details
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/commits/{commit}/rollback — rollback to this commit
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/commits/{commit}/clone    — clone workspace from this commit
```

Each workspace also exposes a Resource API for direct access to files:

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}  — read file content
PUT    /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}  — write file content
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}  — delete file
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}/ — list directory
```

### Example

**1. Create a workspace:**

```yaml
# POST /apis/v1/namespaces/acme/workspaces
name: payments-debug
participants:
  - subject: alice@acme.com
    role: owner
  - agent: claude
    harness: anthropic/claude-code
    role: contributor
resources:
  - source: git://github.com/acme/payments
    path: /code
```

**Response:**

```yaml
id: payments-debug.acme@relay.example.com
namespace: acme
name: payments-debug
status: active
endpoint: wss://relay.example.com/acp/acme/payments-debug
```

**2. Clone a workspace:**

```yaml
# POST /apis/v1/namespaces/acme/workspaces/payments-debug/clone
name: payments-experiment
commit: c3
```

This creates a new independent workspace `payments-experiment` from the state of `payments-debug` at commit `c3`. The clone has the same resources, configuration, and conversation history up to that point. From here the two workspaces evolve independently — useful for safe experimentation, parallel approaches, or handing off context to another team.

**3. Connect via ACP:**

Alice opens her IDE and connects to `wss://relay.example.com/acp/acme/payments-debug`. She sees the conversation thread, the agent `claude` is already active, and the code from `github.com/acme/payments` is mounted at `/code`. She types a message — both the agent and any other connected participants see it instantly.

---

## 3. Tools

Tools are first-class resources in a workspace. A tool represents a capability — reading email, creating a pull request, querying a database, executing shell commands — together with the credentials to access it and the policy governing who can use it and how.

### Tool Registry

A global registry where tools are published and discovered. Each tool in the registry describes:

```yaml
tool: gmail
version: 1.2.0
description: Read, send, and manage email via Gmail API
protocol: mcp
actions:
  - read
  - send
  - list
  - search
```

### Connecting Tools to a Workspace

When a tool is connected to a workspace, it gets a credential binding (who provides access) and a policy (who can do what). The participant who connects the tool decides what to share.

```yaml
# Alice connects her Gmail to the workspace
tool: gmail
provider: alice@acme.com
grants:
  - subject: agent:claude
    actions: [read, search]
    scope: { from: "client@example.com" }
  - subject: agent:claude
    actions: [send]
    access: approval_required
    approvers: [alice@acme.com]
  - subject: role:contributor
    actions: [read]
```

In this example, agent `claude` can read emails from a specific sender without asking, but sending requires Alice's approval. All contributors can read.

### Delegation

Participants can delegate tool access at runtime — not just at workspace creation time. Delegation is scoped and revocable:

```yaml
# Bob grants claude access to his GitHub repos for this workspace
tool: github
provider: bob@acme.com
grants:
  - subject: agent:claude
    actions: [repo.read, pr.create, pr.comment]
  - subject: agent:claude
    actions: [repo.push]
    access: approval_required
    approvers: [bob@acme.com]
```

Every delegation is recorded in the audit log. Grants can be revoked at any time.

### API

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/tools              — list connected tools
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/tools              — connect a tool
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}       — get tool details and grants
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}       — disconnect a tool
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}/grants — add a grant
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}/grants/{grant} — revoke a grant
```

All tool calls go through the workspace runtime, which enforces policy, checks grants, injects credentials, and logs every invocation. Agents never see raw tokens or secrets.

---

## 4. Topics

A workspace contains one or more **topics** — named conversation threads where participants communicate and work. Every workspace starts with a default topic. New topics can be created at any time.

A topic is a focused conversation between a subset of participants — humans and agents — around a specific subject. All messages within a topic are persisted, audited, and included in workspace state.

### Examples

A workspace for a payments service might have:

- `general` — default topic, high-level coordination
- `debug-timeout` — an agent investigating a timeout bug
- `refactor-api` — a human and agent working on API redesign
- `ci` — automated notifications from CI/CD pipeline

### Creating and Joining Topics

Any participant can create a topic. Agents can be assigned to topics at creation time or join later. A participant can be active in multiple topics simultaneously.

```yaml
# Create a topic
topic: debug-timeout
participants:
  - agent:claude
  - alice@acme.com
```

### API

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/topics              — list topics
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/topics              — create a topic
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/topics/{topic}      — get topic details
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/topics/{topic}      — archive a topic
```

Each topic has its own ACP endpoint for real-time communication:

```
wss://relay.example.com/acp/acme/payments-debug/topics/debug-timeout
```

### Relationship to ACP Sessions

Each topic maps to an ACP session. When a client connects to a topic, they join the corresponding session. An agent running in a topic maintains its own conversation context — separate from other topics but sharing the same workspace resources.
