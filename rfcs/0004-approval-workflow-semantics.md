# RFC 0004: Approval Workflow Semantics

- Status: proposed
- Date: 2026-03-10

## Summary

This RFC settles the demo-ready approval workflow.

It defines:
- how approval pauses tool execution
- exact approval request and response messages
- how decisions are emitted and audited
- the demo rule for concurrent approver responses

For the demo, approval is a topic realtime workflow. A separate REST approval
API is deferred.

## Scope

This contract applies when a tool grant uses:

```json
{ "access": "approval_required" }
```

Approval happens over the same authenticated topic realtime connection defined
in RFC 0002.

## Approval Lifecycle

The runtime must treat approval as a first-class object with its own identity:
- `approvalId` identifies the approval workflow
- `toolCallId` identifies the paused tool invocation

They are related but not interchangeable.

Lifecycle:
1. tool call reaches an approval gate
2. runtime emits `approval_request`
3. tool execution pauses
4. an authenticated approver sends `approval_response`
5. runtime resolves the approval and emits `approval_decision`
6. tool execution either resumes or fails

## Approval Request

When approval is required, the runtime must emit:

```json
{
  "type": "approval_request",
  "eventId": "e_49",
  "timestamp": "2026-03-10T12:00:06Z",
  "promptId": "p_123",
  "approvalId": "a_123",
  "toolCallId": "tc_124",
  "tool": "github",
  "action": "repo.push",
  "approvers": ["alice@acme.com"],
  "inputSummary": "push branch fix-timeout",
  "expiresAt": "2026-03-10T12:05:06Z"
}
```

Required fields:
- `approvalId`
- `toolCallId`
- `tool`
- `action`
- `approvers`
- `expiresAt`

Rules:
- `inputSummary` is required for the demo, but it is intentionally a summary,
  not raw secret-bearing input
- `expiresAt` must be explicit so clients can display timeout state

## Approval Response

An approver resolves the request with:

```json
{
  "type": "approval_response",
  "approvalId": "a_123",
  "decision": "approved",
  "reason": "Reviewed and approved"
}
```

Allowed `decision` values from clients:
- `approved`
- `denied`

Rules:
- clients must not send `approver`
- approver identity comes from authenticated connection context
- the runtime must ignore responses from callers who are not valid approvers

## Approval Decision Event

Once the runtime resolves the approval, it must emit:

```json
{
  "type": "approval_decision",
  "eventId": "e_50",
  "timestamp": "2026-03-10T12:01:00Z",
  "promptId": "p_123",
  "approvalId": "a_123",
  "toolCallId": "tc_124",
  "decision": "approved",
  "approver": "alice@acme.com",
  "reason": "Reviewed and approved"
}
```

Allowed server `decision` values:
- `approved`
- `denied`
- `timed_out`

Rules:
- `approver` is runtime-asserted identity, never echoed from client input
- `timed_out` is server-generated only

## Resolution Rules

For the demo, the resolution rule is:
- first valid response wins

Meaning:
- the first response from an authenticated allowed approver resolves the
  approval
- later responses for the same `approvalId` are ignored
- once resolved, the runtime must not reopen the same `approvalId`

Tool execution behavior:
- if `decision` is `approved`, the paused tool call resumes
- if `decision` is `denied` or `timed_out`, the paused tool call fails

The enclosing prompt still ends through the normal RFC 0002 flow:
- optional `error`
- then `done`

## Timeout Behavior

For the demo:
- every approval request must have an `expiresAt`
- if no valid approver responds by then, the runtime emits
  `approval_decision` with `decision: "timed_out"`

The exact timeout duration may be runtime-configured, but it must be visible to
clients through `expiresAt`.

## Audit Requirement

Every resolved approval must be recorded with:
- `approvalId`
- `toolCallId`
- `tool`
- `action`
- `subject`
- `decision`
- `approver`
- `reason`
- `timestamp`

For `timed_out`, `approver` may be null or omitted.

## Demo Guarantees

This RFC defines the demo guarantee as:
- approval is visible to all connected topic participants
- an approver can resolve it over the websocket connection
- the decision is machine-readable and auditable
- approval pauses a real tool invocation rather than simulating success/failure

## Non-Goals For This Contract

Explicitly deferred:
- REST approval endpoints for offline approvers
- multi-step approval chains
- quorum or multi-approver voting
- approval delegation beyond the configured approver list
