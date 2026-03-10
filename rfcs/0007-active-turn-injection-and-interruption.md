# RFC 0007: Active Turn Injection and Interruption

- Status: proposed
- Date: 2026-03-10

## Summary

This RFC adds two primitives for interacting with an active agent turn:

- **Inject**: deliver a user message into an active turn without stopping it
- **Interrupt**: cancel an active turn

It also extends the existing `prompt` message (RFC 0002) with an optional
`position` field for queue placement.

These three orthogonal primitives — `prompt`, `inject`, `interrupt` — compose
cleanly. There are no bundled operations.

## Problem

The current protocol models turns as atomic: a prompt enters the queue, reaches
the front, runs to completion, and produces a `done` event. Participants can
manage the queue (RFC 0006), but they cannot interact with the turn that is
currently executing.

This creates problems in practice:

1. **Guidance too late.** A participant notices the agent is taking the wrong
   approach three tool calls in, but cannot say "also check the slicing metadata"
   until the turn finishes.

2. **Wasted work.** An agent spends minutes on a wrong approach that could have
   been corrected in seconds, but there is no way to say "stop, wrong file"
   without waiting.

3. **Deep agent loops.** A single turn can involve many sequential tool calls
   (validate, search Jira, read file, edit, validate again). Without injection,
   participants are locked out for the full duration.

4. **Human-in-the-loop steering.** Some workflows need mid-turn context ("use
   staging credentials, not prod") without restarting the agent's reasoning.

## Primitive Design

Three orthogonal primitives:

| Primitive | What it does | Creates a turn? | Affects active turn? |
|-----------|-------------|-----------------|---------------------|
| `prompt` | Submit new work; queues if agent is busy | Yes | No |
| `inject` | Add context to the active turn | No | Yes (non-destructive) |
| `interrupt` | Stop the active turn | No | Yes (destructive) |

These compose without bundling:

**"Add guidance mid-turn"**: `inject`

**"Stop"**: `interrupt`

**"Stop and do this instead"**: `interrupt` then `prompt` with `position: 0`.
If the same client sends those two messages sequentially on one websocket
connection, the runtime processes them in that order. There is no protocol-wide
global ordering guarantee across different clients or across websocket and REST
calls. The prompt arrives at the front of the queue and starts immediately once
the interrupted turn has finished unwinding.

**"Send work while agent is busy"**: `prompt` (existing behavior; queues behind
active turn)

**"Send urgent work while agent is busy"**: `prompt` with `position: 0` (insert
before queue position `1`, so it runs after the current turn finishes)

A `prompt` never becomes an inject. They are fundamentally different: a prompt
creates a new turn; an inject modifies the current one. The user picks the right
action based on intent, not retroactively.

## Background: Shelley Runtime Internals

The Shelley runtime already implements both mechanisms internally. This RFC
exposes them as workspace protocol operations.

### Internal injection: `Loop.QueueUserMessage()`

Messages are added to a thread-safe `messageQueue` on the Loop struct. The queue
is drained at two safe points:

1. **Before each LLM request** in the main `Go()` loop — messages are moved from
   the queue into history before calling the LLM service.

2. **After each tool completes** in `executeToolCalls()` — immediately after tool
   results are collected and before the loop returns to make another LLM request.
   This is the responsive path: during a five-tool chain, an injected message
   appears to the LLM right after the current tool finishes, not after all five.

The runtime first records the message durably to the database. Only after that
succeeds does it acknowledge the inject and queue it for delivery at the next
safe point. From the LLM's perspective, the injected message is a normal user
message that appears in the history after the latest tool result.

```
Agent turn in progress: tool_use A → tool_result A → tool_use B (executing)

User injects "also check slicing metadata":
  1. Message recorded to DB immediately
  2. Inject acknowledged and queued in Loop.messageQueue

Tool B completes:
  3. executeToolCalls() adds tool_result B to history
  4. Checks messageQueue — finds the injection
  5. Adds user message to history

Next LLM request sees:
  [..., tool_use B, tool_result B, User: "also check slicing metadata"]
  Agent naturally incorporates the guidance.
```

### Internal interruption: `CancelConversation()`

Cancellation works through Go context propagation:

1. Inspects message history to find any in-flight tool call (tool_use without a
   matching tool_result).
2. Cancels the loop's context (`loopCancel()`).
3. Waits briefly for the loop to notice `ctx.Done()` at a safe point.
4. If a tool was in flight, records a cancelled tool_result (`ToolError: true`,
   text: "Tool execution cancelled by user").
5. Records an assistant end-of-turn message (`[Operation cancelled]`).
6. Resets the loop state (`loop=nil`, `hydrated=false`).
7. Marks agent as not working.

The loop checks `ctx.Done()` at the top of each iteration and inside LLM/tool
calls, so cancellation propagates quickly. The next interaction reloads history
from the database, which includes the cancellation messages, giving the agent
full context of what was interrupted and why.

## Decision

### Inject

Inject delivers a user message into the active turn at the next safe point. The
turn continues. The agent sees the message as additional context.

Properties:
- non-blocking — the call returns immediately
- after durable persistence succeeds, the runtime emits `inject_status:
  accepted`
- the message is then visible to all participants immediately (broadcast as a
  `user` event with `injected: true`)
- delivery to the agent happens at the next safe point (after the current tool
  finishes, before the next LLM call)
- delivery latency depends on the current activity — if a tool takes 30 seconds,
  the injection waits up to 30 seconds
- multiple injections can be queued; they are delivered in order
- does not create a new turn, queue entry, or prompt lifecycle
- does not reset the agent's token budget or stop conditions
- if durable persistence fails, the inject is rejected and must not emit
  `accepted`

### Interrupt

Interrupt cancels the active turn. It is a pure stop — it does not submit new
work.

Properties:
- cancels the active turn's context
- records a cancelled tool result for any in-flight tool
- emits `done` with `status: "interrupted"` for the cancelled turn
- the queue drains normally after the turn ends (next queued prompt starts)
- message history from the interrupted turn is preserved

### Prompt (extended)

RFC 0002 `prompt` is extended with an optional `position` field for queue
placement. This is consistent with RFC 0006's queue model.

- `position: 0` — insert before queue position `1` (next to run)
- omitted — append to the back of the queue (existing behavior)

This replaces the need for a bundled "interrupt and send" primitive. "Stop and
redirect" is simply:

```
→ { "type": "interrupt", "reason": "Wrong approach." }
→ { "type": "prompt", "promptId": "p_456", "data": "Do this instead.", "position": 0 }
```

### Safe Points

Injection does not preempt running LLM requests or running tool execution.
Messages are delivered at safe points:

1. After tool results are collected, before the next LLM request
2. At the top of the main loop iteration, before processing queued messages

Interruption preempts via context cancellation, which propagates into LLM API
calls and tool execution (if they check `ctx.Done()`).

## Client WebSocket Messages

### `inject`

Deliver a message into the active turn:

```json
{
  "type": "inject",
  "injectId": "inj_abc",
  "data": "Also check the slicing metadata on Observation.component."
}
```

Rules:
- `injectId` is required and must be unique within the session
- `data` is the message text (text-only for the demo contract)
- if no turn is active, the requester receives `inject_status { status:
  "rejected" }` plus a session-level `error` event

### `interrupt`

Cancel the active turn:

```json
{
  "type": "interrupt",
  "reason": "Wrong approach, switching to a different file."
}
```

Rules:
- `reason` is required (visible to all participants)
- if no turn is active, the server responds with an `error` event
- does not submit new work — use a follow-up `prompt` for that

### `prompt` (extended)

RFC 0002 `prompt` gains an optional `position` field:

```json
{
  "type": "prompt",
  "promptId": "p_456",
  "data": "Use input/fsh/VitalSignsPanel.fsh instead.",
  "position": 0
}
```

Rules:
- `position` is optional
- `position: 0` inserts at the front of the queue
- omitting `position` appends to the back (existing behavior)
- all other `prompt` rules from RFC 0002 still apply

## Server Events

### `inject_status`

Tracks injection lifecycle:

```json
{
  "type": "inject_status",
  "eventId": "e_60",
  "timestamp": "2026-03-10T12:01:00Z",
  "injectId": "inj_abc",
  "status": "accepted"
}
```

After the message reaches the agent at a safe point:

```json
{
  "type": "inject_status",
  "eventId": "e_61",
  "timestamp": "2026-03-10T12:01:03Z",
  "injectId": "inj_abc",
  "status": "delivered"
}
```

Allowed `status` values:
- `accepted` — the inject was durably recorded and queued for delivery
- `delivered` — message was added to the agent's context at a safe point
- `rejected` — no active turn, durable recording failed, or the turn ended
  before delivery

### `user` (extended)

Injected messages are broadcast as `user` events with an `injected` flag:

```json
{
  "type": "user",
  "eventId": "e_62",
  "timestamp": "2026-03-10T12:01:03Z",
  "promptId": "p_123",
  "submittedBy": { "kind": "participant", "id": "priya@example.com" },
  "data": "Also check the slicing metadata on Observation.component.",
  "injected": true,
  "injectId": "inj_abc"
}
```

Clients should render injected messages distinctly from the initial prompt.

### `done` (extended)

RFC 0002 defines `done` with `status` values `completed`, `failed`, and
`cancelled`. This RFC adds:

- `interrupted` — the turn was interrupted by a participant

```json
{
  "type": "done",
  "eventId": "e_63",
  "timestamp": "2026-03-10T12:01:04Z",
  "promptId": "p_123",
  "status": "interrupted",
  "interruptedBy": { "kind": "participant", "id": "marco@example.com" },
  "reason": "Wrong approach, switching to a different file."
}
```

## REST API

### `POST .../topics/{topic}/inject`

Request body:

```json
{
  "data": "Also check the slicing metadata."
}
```

Response:
- `200 OK` with `{ "injectId": "inj_abc", "status": "accepted" }`
- `409 Conflict` if no turn is active
- `500 Internal Server Error` if the runtime cannot durably record the inject

### `POST .../topics/{topic}/interrupt`

Request body:

```json
{
  "reason": "Wrong approach."
}
```

Response:
- `200 OK` with the interrupted prompt's `done` event
- `409 Conflict` if no turn is active

## Composition Examples

### Steer mid-turn

```
→ inject { data: "Use staging credentials, not prod." }
← inject_status { status: "accepted" }
← inject_status { status: "delivered" }
← user { data: "Use staging credentials...", injected: true }
  (agent incorporates guidance and continues)
```

### Stop and redirect

```
→ interrupt { reason: "Wrong file." }
← done { promptId: "p_123", status: "interrupted" }
→ prompt { promptId: "p_456", data: "Use VitalSigns.fsh instead.", position: 0 }
← prompt_status { promptId: "p_456", status: "started" }
  (new turn begins immediately)
```

### Stop, let the queue drain

```
→ interrupt { reason: "Taking too long." }
← done { promptId: "p_123", status: "interrupted" }
  (next queued prompt starts automatically)
```

### Add guidance, then queue follow-up work

```
→ inject { data: "Focus on the component slicing." }
→ prompt { data: "After that, re-run the publisher." }
  (inject modifies active turn; prompt queues behind it)
```

## Interaction with Queue (RFC 0006)

Inject does not affect the queue. It modifies the active turn's context without
creating queue entries.

Interrupt ends the active turn. The queue drains normally afterward. If a
`prompt` with `position: 0` follows the interrupt, it goes to the front.

The `position` field on `prompt` is a queue-placement hint, consistent with
RFC 0006's reordering model. It does not bypass the queue — it places the prompt
at a specific position within it.

## Interaction with Approvals (RFC 0004)

If the active turn is waiting on an approval when an inject arrives:
- the inject is accepted but not delivered until the approval resolves

If the active turn is waiting on an approval when an interrupt arrives:
- the approval is auto-denied with reason `turn_interrupted`
- the turn is interrupted as normal

## Client UI Integration (Informative)

This section is non-normative. It sketches one coherent way a client could
surface these primitives, demonstrating that they compose well in a real UI.
Clients are free to choose different UX patterns.

### Composer behavior by state

One natural approach: keep the composer as a single text input with a Send
button, and change what Send does based on turn state:

| Turn state | Send action | Extra affordances |
|------------|-------------|-------------------|
| **Idle** | `prompt` (starts a new turn) | — |
| **Active turn** | `inject` (adds context to the running turn) | Stop button; "Queue instead" toggle |

When a turn is active, defaulting to `inject` makes sense because the most
common mid-turn action is steering ("also check X", "use staging not prod").
A secondary toggle (e.g. a "Queue instead" link or modifier key) could switch
Send to `prompt` mode for follow-up work the user wants to line up without
affecting the active turn.

### Stop button

A Stop button could appear beside the composer whenever a turn is active,
sending `interrupt`. "Stop and redirect" becomes a natural gesture: click Stop,
type the new instruction, hit Send. If other prompts are queued, the client
could offer a "Send next" option that sets `position: 0`.

### Queue panel

The existing queue panel (RFC 0006) composes naturally — `interrupt` clears the
active turn, `prompt { position: 0 }` inserts at the front, and `inject` does
not create queue entries at all.

### Message rendering

Clients should distinguish three cases in the message list:

1. **Normal prompt** (`user` event) — the start of a new turn.
2. **Injected message** (`user` event with `injected: true`) — mid-turn context,
   rendered distinctly (e.g. indented, lighter background, "mid-turn" label).
3. **Interrupted turn** (`done` with `status: "interrupted"`) — a visual break
   showing what happened and why.

Clients can optionally use `inject_status: delivered` to show a "delivered to
agent" indicator on injected messages.

### Example: steering a deep agent loop

```
[Agent is running: validate → search Jira → read file → edit...]

User types: "focus on the component slicing, ignore the extension warnings"
  → hits Send (inject mode, since turn is active)
  → message appears in chat with "injected" styling
  → after current tool finishes, agent sees the message
  → agent adjusts approach without restarting

[Agent continues with adjusted approach...]

User types: "when you're done, also run the publisher"
  → clicks "Queue instead" toggle
  → hits Send (prompt mode)
  → message appears in queue panel at position 2
  → will run as a new turn after the current one finishes
```

### Example: stop and redirect

```
[Agent is running: editing the wrong file...]

User clicks Stop
  → interrupt sent
  → turn ends with "interrupted" marker in message list
  → composer reverts to idle mode

User types: "use VitalSigns.fsh instead of BloodPressure.fsh"
  → hits Send (prompt mode, since idle)
  → new turn starts immediately
```

### Example: multi-user collaboration

```
[Priya's turn is running. Marco is watching.]

Marco types: "Priya asked me to mention — the slicing rules changed last week"
  → hits Send (inject, since turn is active)
  → appears in chat for everyone, delivered to agent

Marco types: "After this, validate the CarePlan profile too"
  → clicks "Queue instead"
  → hits Send (prompt, queues behind current turn)
  → appears in queue panel

Priya sees Marco's queued prompt, drags it below her own queued prompt
  → queue reorder via RFC 0006
```

## Non-Goals

This RFC does not define:
- collaborative editing of the active prompt while it runs
- partial rollback of agent actions taken before interruption
- injection of structured content (images, files) — text only for now
- rate limiting for inject/interrupt
- priority levels for injected messages
- bundled "interrupt and send" — use `interrupt` + `prompt` composition instead

## Tradeoffs

Pros:
- three orthogonal primitives that compose without bundling
- maps directly to existing Shelley runtime mechanisms
- minimal protocol surface (two new client messages, one extended server event,
  one extended field on `prompt`)
- injection timing is well-defined (safe points after tool completion)

Costs:
- injection latency is non-deterministic (depends on tool execution time)
- agents must handle mid-turn context changes gracefully
- interrupted turns may leave partial side effects (files written, tools called)
- client UI complexity increases (inject vs. prompt vs. interrupt states)
- "stop and redirect" requires two messages instead of one (but is cleaner)

## Relationship to Shelley Internals

| Protocol operation | Shelley mechanism | Location |
|---|---|---|
| `inject` | `Loop.QueueUserMessage()` + safe-point drain in `executeToolCalls()` | `loop/loop.go:87-93, 499-510` |
| `interrupt` | `ConversationManager.CancelConversation()` | `server/convo.go:591-727` |
| `inject_status: delivered` | Queue drain in `executeToolCalls()` after tool completion | `loop/loop.go:503-509` |
| `done: interrupted` | End-of-turn message + `SetAgentWorking(false)` | `server/convo.go:703-715` |
| `prompt { position: 0 }` | Queue insertion at front via `PromptQueue` | `server/prompt_queue.go` |

The workspace protocol contract is designed so that alternative runtimes can
implement the same semantics without depending on Shelley's specific architecture.
The safe-point model (inject at tool boundaries, interrupt via context
cancellation) is general enough for any runtime that executes tools sequentially
within a turn.
