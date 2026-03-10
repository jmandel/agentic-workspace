# RFC 0009: Manager Lifecycle Notifications

- Status: draft
- Date: 2026-03-10

## Summary

This RFC defines a manager-level WebSocket contract for workspace and topic
lifecycle notifications. It complements the topic-level realtime contract
(RFC 0002) by surfacing CRUD events at the manager scope so that dashboards,
CLIs, and other manager clients can react to changes without polling.

## Scope

This contract applies to one manager event WebSocket connection:

```text
wss://.../acp/{namespace}/events?client_id={clientId}
```

Each connected client receives a live stream of workspace and topic lifecycle
events for the specified namespace. The contract is read-only: clients do not
send commands over this connection.

## Session Model

Each manager process has a `sessionId` that identifies the current manager
lifetime. If the manager restarts, `sessionId` changes and prior replay state
is not resumable.

This follows the same session model as RFC 0002 topic sessions.

## Connect and Replay

### Connect request

Clients connect with no required resume parameter:

```text
wss://.../acp/default/events?client_id=web-abc123
```

### First server message

The server must send a `connected` message first:

```json
{
  "type": "connected",
  "protocolVersion": "manager-demo-v1",
  "namespace": "default",
  "sessionId": "ms_1",
  "replay": true
}
```

### Replay window

After `connected`, the server sends the current state as a burst of
`workspace_created` events with `"replay": true`, one per live workspace. Each
replayed workspace event includes its current topics.

This gives a connecting client a full snapshot of the namespace without a
separate REST call.

After the replay burst, the server switches to the live tail.

## Server Event Envelope

All server messages except `connected` must include:
- `eventId`
- `timestamp`

```json
{
  "type": "workspace_created",
  "eventId": "me_1",
  "timestamp": "2026-03-10T12:00:01Z",
  "replay": false
}
```

Rules:
- `eventId` is opaque but strictly ordered within one `sessionId`
- `timestamp` is RFC3339 UTC
- `replay` is `true` only for replayed events; it may be omitted or `false` for
  live events

## Server Messages

### `workspace_created`

Emitted after a workspace is launched successfully:

```json
{
  "type": "workspace_created",
  "eventId": "me_1",
  "timestamp": "2026-03-10T12:00:01Z",
  "workspace": {
    "name": "bp-ig-fix",
    "status": "running",
    "template": "acme-rpm-ig",
    "createdAt": "2026-03-10T12:00:01Z",
    "topics": [
      { "name": "bp-example-validator" }
    ]
  }
}
```

During replay, this event represents a workspace that already exists. During
live tail, it means a workspace was just created.

### `workspace_deleted`

Emitted after a workspace is stopped and removed:

```json
{
  "type": "workspace_deleted",
  "eventId": "me_5",
  "timestamp": "2026-03-10T12:05:00Z",
  "workspace": {
    "name": "bp-ig-fix"
  }
}
```

### `workspace_status_changed`

Emitted when a workspace runtime's health status transitions:

```json
{
  "type": "workspace_status_changed",
  "eventId": "me_8",
  "timestamp": "2026-03-10T12:10:00Z",
  "workspace": {
    "name": "bp-ig-fix",
    "status": "unavailable",
    "previousStatus": "running"
  }
}
```

Allowed `status` values: `running`, `unavailable`.

### `topic_created`

Emitted after a topic is created on a workspace:

```json
{
  "type": "topic_created",
  "eventId": "me_3",
  "timestamp": "2026-03-10T12:01:00Z",
  "workspace": "bp-ig-fix",
  "topic": {
    "name": "debug-timeout"
  }
}
```

### `topic_deleted`

Emitted after a topic is deleted from a workspace:

```json
{
  "type": "topic_deleted",
  "eventId": "me_6",
  "timestamp": "2026-03-10T12:06:00Z",
  "workspace": "bp-ig-fix",
  "topic": {
    "name": "debug-timeout"
  }
}
```

## Client Messages

None. This is a read-only event stream. Clients that need to create or delete
workspaces and topics use the REST API.

## Demo Guarantees

- Multi-client live fanout of workspace and topic CRUD events
- Late joiners receive current namespace state via replay burst
- Dashboard UIs can maintain a live workspace list without polling

## Non-Goals For This Contract

Explicitly deferred:
- Historical event log or audit trail
- `since=<eventId>` resumability across manager restarts
- Per-user event filtering or access control
- Cross-manager federation or multi-namespace multiplexing
- Runtime log streaming
- Local tool catalog change notifications
- Workspace file change notifications
