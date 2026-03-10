# RFC 0006: Topic Prompt Queue Management

- Status: proposed
- Date: 2026-03-10

## Summary

This RFC makes queued prompts first-class.

It defines:
- explicit queued prompt objects
- prompt ownership
- queue lifecycle events
- cancellation of queued prompts before they start
- minimal REST surfaces for queue inspection and removal

It does not attempt to solve true simultaneous multiplayer turns. It defines a
better shared queue model for the existing "one active turn per topic" runtime.

## Problem

The current topic model is better than hard mutex or dropped prompts, but it is
still too implicit for real collaboration:

- prompts can be accepted while another turn is active
- queued work is not yet modeled as a first-class resource
- users cannot clearly see what is waiting
- users cannot remove their own queued prompts before they start
- queue state is mostly inferred from `prompt_status` and ad hoc system text

In practice this leaves clients with a poor collaboration story:
- one participant may accidentally queue stale work
- another participant cannot tell whether a follow-up is pending
- a sender cannot retract or clear their own queued prompts

## Decision

Topics keep one active turn at a time, but every submitted prompt becomes an
explicit queue entry with stable identity and ownership.

The protocol must expose:
- the current active prompt, if any
- queued prompts behind it
- the ability for a submitter to cancel their own queued prompts while they are
  still queued
- the ability for a submitter to clear all of their own queued prompts for a
  topic

This queue model is part of the topic protocol, not an internal implementation
detail.

## Queue Model

Each prompt becomes a queue entry:

```json
{
  "promptId": "p_123",
  "topic": "bp-panel-validator",
  "sessionId": "s_123",
  "status": "queued",
  "submittedBy": {
    "kind": "user",
    "id": "priya@example.com"
  },
  "text": "Search HL7 Jira for Observation.component slicing issues.",
  "createdAt": "2026-03-10T12:00:00Z",
  "position": 2
}
```

Required fields:
- `promptId`
- `status`
- `submittedBy`
- `text`
- `createdAt`

Optional but recommended:
- `sessionId`
- `position`

For the first version, `text` may be stored verbatim because prompts are still
text-only. If later content becomes multi-part, this field should become
structured content.

## Prompt Status Values

Allowed queue-aware statuses:
- `accepted`
- `queued`
- `started`
- `completed`
- `cancelled`
- `failed`

Meaning:
- `accepted`: runtime accepted the submission and created a queue entry
- `queued`: prompt is waiting behind another active turn
- `started`: prompt reached the front of the queue and is now running
- `completed`: turn finished normally
- `cancelled`: prompt was removed before starting
- `failed`: prompt could not be executed

`accepted` and `queued` are not the same thing:
- every prompt produces `accepted`
- only prompts that are not immediately started produce `queued`

## Ownership and Cancellation Rules

Queue ownership comes from authenticated connection context.

Clients must not supply `submittedBy` inline in websocket or REST mutations.

Rules:
- a queued prompt may be cancelled only while its status is `queued`
- the prompt submitter may cancel their own queued prompt
- privileged moderators or workspace admins may cancel any queued prompt
- once a prompt reaches `started`, it is no longer removable through queue
  cancellation and must be handled by normal turn cancellation semantics if the
  runtime supports that separately

For demo implementations with weak auth, ownership may still be coarse, but the
protocol shape should assume real subject identity.

## Realtime Events

This RFC extends RFC 0002.

### Required event fields

Queue-related server events must include:
- `promptId`
- `timestamp`
- `eventId`

When available, include:
- `submittedBy`
- `position`

### `prompt_status`

RFC 0002 `prompt_status` stays in place, but its semantics become queue-aware.

Example:

```json
{
  "type": "prompt_status",
  "eventId": "e_51",
  "timestamp": "2026-03-10T12:00:01Z",
  "promptId": "p_123",
  "status": "queued",
  "position": 2
}
```

### `queue_snapshot`

On connect, after `connected`, the server should emit a queue snapshot for the
current topic session before switching fully to the live tail.

Example:

```json
{
  "type": "queue_snapshot",
  "eventId": "e_52",
  "timestamp": "2026-03-10T12:00:02Z",
  "activePromptId": "p_120",
  "entries": [
    {
      "promptId": "p_121",
      "status": "queued",
      "submittedBy": { "kind": "user", "id": "marco@example.com" },
      "text": "Search HL7 Jira for similar slicing issues.",
      "createdAt": "2026-03-10T12:00:01Z",
      "position": 1
    },
    {
      "promptId": "p_122",
      "status": "queued",
      "submittedBy": { "kind": "user", "id": "priya@example.com" },
      "text": "Re-run validation after the fix.",
      "createdAt": "2026-03-10T12:00:02Z",
      "position": 2
    }
  ]
}
```

Rationale:
- a late joiner should not have to infer the queue by replaying a long event
  stream
- a reconnecting client needs an authoritative current queue state

### `queue_entry_removed`

When a queued prompt is cancelled before start:

```json
{
  "type": "queue_entry_removed",
  "eventId": "e_53",
  "timestamp": "2026-03-10T12:00:03Z",
  "promptId": "p_122",
  "reason": "cancelled_by_submitter"
}
```

Allowed `reason` values initially:
- `cancelled_by_submitter`
- `cancelled_by_moderator`
- `expired`

This event is useful because it makes queue mutation explicit instead of forcing
clients to infer removal from absence.

## Client WebSocket Messages

### `prompt`

Prompt submission remains:

```json
{
  "type": "prompt",
  "promptId": "p_123",
  "data": "Validate the profile again."
}
```

### `cancel_prompt`

Clients may cancel a queued prompt:

```json
{
  "type": "cancel_prompt",
  "promptId": "p_123"
}
```

The server responds with either:
- `prompt_status` with `cancelled`
- or `error` if the prompt is not cancellable

## REST API

The runtime should expose queue state directly.

Suggested canonical paths:

```text
GET    /apis/v1/namespaces/{ns}/workspaces/{workspace}/topics/{topic}/queue
DELETE /apis/v1/namespaces/{ns}/workspaces/{workspace}/topics/{topic}/queue/{promptId}
POST   /apis/v1/namespaces/{ns}/workspaces/{workspace}/topics/{topic}/queue:clear-mine
```

Equivalent internal runtime paths may exist behind manager proxying.

### `GET .../queue`

Returns the current active prompt plus queued entries:

```json
{
  "sessionId": "s_123",
  "activePromptId": "p_120",
  "entries": [
    {
      "promptId": "p_121",
      "status": "queued",
      "submittedBy": { "kind": "user", "id": "marco@example.com" },
      "text": "Search HL7 Jira for similar slicing issues.",
      "createdAt": "2026-03-10T12:00:01Z",
      "position": 1
    }
  ]
}
```

### `DELETE .../queue/{promptId}`

Removes one queued prompt if the caller has permission.

Responses:
- `204 No Content` on success
- `403` if the caller may not remove it
- `409` if the prompt has already started and is no longer cancellable
- `404` if the prompt does not exist

### `POST .../queue:clear-mine`

Removes all queued prompts for the authenticated caller in the topic.

Example response:

```json
{
  "removed": ["p_121", "p_122"]
}
```

## Client Expectations

Clients should treat the queue as a first-class collaboration surface.

Minimum UI expectations:
- show the active prompt
- show queued prompts with position and owner
- allow "remove mine" on queued entries owned by the current caller
- update queue state live from websocket events

This is still not a true simultaneous multi-editor model, but it is much more
honest and usable than silent queueing or dropped prompts.

## Non-Goals

This RFC does not define:
- simultaneous co-editing within one turn
- merge/conflict handling between prompts
- durable queue replay across runtime restart
- moderation policy beyond basic ownership/admin cancellation

## Tradeoffs

Pros:
- collaboration becomes understandable
- queued work is inspectable instead of implicit
- users can retract stale queued work
- the protocol matches how serialized agent loops really behave

Costs:
- more protocol surface
- requires caller identity to be meaningful
- queue state now needs explicit persistence or authoritative in-memory tracking

## Relationship to the Current Shelley Prototype

The current Shelley prototype already has real serialized prompt queuing, which
is why the live demo did not need hard mutex or prompt dropping.

What is missing today is the public queue model:
- queued prompts are not exposed as first-class objects
- submitters cannot remove their own queued prompts before execution
- clients do not receive a queue snapshot on connect

This RFC describes the next step needed to make that queue behavior usable and
credible for collaboration.
