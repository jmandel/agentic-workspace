# RFC 0005: Manager-Published Local Tool Catalog

- Status: proposed
- Date: 2026-03-10

## Summary

This RFC defines how trusted local runtime tools are described and selected
without turning them into first-class managed workspace tools.

The core model is:

- a Workspace Manager may publish a catalog of local tools it knows how to
  provide
- workspace configuration may reference those tools by string name
- the workspace runtime receives only the selected local tools
- Shelley learns about those local tools through generated workspace guidance
  and normal bash access

This is intentionally separate from the managed workspace tools API used for MCP
tools.

## Problem

The demo needs two different tool stories:

- trusted local runtime tools such as `fhir-validator`
- first-class managed tools such as MCP `hl7-jira`

A bare string like `"fhir-validator"` is too opaque to be a protocol design on
its own. But fully standardizing packaging or bundle transport is out of scope
for this layer and would overcomplicate the demo.

We need a middle ground:

- discoverable enough to be explicit
- simple enough to demo and implement
- flexible enough that managers can provide tools however they want

## Decision

Trusted local runtime tools are modeled as manager capabilities, not as managed
workspace tools.

The protocol should expose:

1. a manager-published local tool catalog
2. workspace configuration that selects catalog entries by name
3. workspace detail that shows which local tools are enabled

Managed tools registered through `POST /tools` remain the first-class tool API
for MCP and other schema-bearing integrations.

## Routes

### Manager catalog

```text
GET /apis/v1/local-tools
```

This returns the list of local tools the manager knows how to provide.

### Workspace create or update

Workspace create and update may select local tools by name:

```text
POST  /apis/v1/namespaces/{ns}/workspaces
PATCH /apis/v1/namespaces/{ns}/workspaces/{name}
```

### Workspace detail

Workspace detail should expose enabled local tools:

```text
GET /apis/v1/namespaces/{ns}/workspaces/{name}
```

## Catalog Shape

`GET /apis/v1/local-tools` returns objects like:

```json
[
  {
    "name": "fhir-validator",
    "kind": "local_tool",
    "exposure": "bash_only",
    "description": "FHIR Validator CLI available inside the workspace runtime",
    "commands": [
      {
        "name": "fhir-validator",
        "command": "/tools/bin/fhir-validator"
      }
    ],
    "guidance": "Use via bash to validate generated FHIR artifacts.",
    "requirements": ["java"],
    "version": "demo"
  },
  {
    "name": "ig-publisher",
    "kind": "local_tool",
    "exposure": "bash_only",
    "description": "FHIR IG Publisher available inside the workspace runtime",
    "commands": [
      {
        "name": "ig-publisher",
        "command": "/tools/bin/ig-publisher"
      }
    ],
    "guidance": "Use via bash to run a local IG Publisher build.",
    "version": "demo"
  }
]
```

Required fields:

- `name`
- `kind`
- `exposure`
- `description`
- `commands`

Rules:

- `kind` is `local_tool` for this contract
- `exposure` is `bash_only` for the demo
- `commands` is the user/model-facing command metadata the manager promises to
  make available inside enabled workspaces
- `guidance` is optional but strongly recommended
- `requirements` is optional descriptive metadata for runtime dependencies such
  as `java`
- `version` is optional

Additional rules:

- `requirements` is descriptive and discoverable, but it is not separately
  selected by clients
- if a workspace enables `fhir-validator`, the client selects only
  `fhir-validator`, not its transitive runtime dependencies

## Workspace Create Shape

Workspace creation may select local tools by name:

```json
{
  "name": "bp-ig-fix",
  "template": "acme-rpm-ig",
  "topics": [
    { "name": "bp-panel-validator" }
  ],
  "runtime": {
    "localTools": ["fhir-validator"]
  }
}
```

Rules:

- `runtime.localTools` is optional
- each entry must match a `name` from the manager catalog
- unknown local tool names must be rejected at create/update time

For the demo:

- `fhir-validator` is selected this way
- optional `ig-publisher` can be added later the same way

## Workspace Detail Shape

`GET /apis/v1/namespaces/{ns}/workspaces/{name}` should expose the enabled local
tools in resolved form, not just as raw names.

Example:

```json
{
  "namespace": "acme",
  "name": "bp-ig-fix",
  "status": "running",
  "runtime": {
    "localTools": [
      {
        "name": "fhir-validator",
        "kind": "local_tool",
        "exposure": "bash_only",
        "description": "FHIR Validator CLI available inside the workspace runtime",
        "commands": [
          {
            "name": "fhir-validator",
            "command": "/tools/bin/fhir-validator"
          }
        ],
        "guidance": "Use via bash to validate generated FHIR artifacts."
      }
    ]
  }
}
```

This is the mechanism that keeps the string reference from being opaque.

## Relationship To The Managed Tools API

Local tool catalog entries are not created with:

```text
POST /tools
```

Managed tools created with `POST /tools` are still for:

- MCP tools
- schema-bearing tools
- grant-controlled tools
- approval-capable tools

So:

- `fhir-validator` -> local tool catalog + workspace runtime selection
- `hl7-jira` -> managed tool API

## Runtime Expectations

When a workspace enables a local tool, the manager is responsible for:

- making the advertised commands available inside the isolated runtime
- ensuring those commands match the catalog metadata
- generating workspace guidance so Shelley knows the tool exists and how to use
  it through bash

In practice, the manager may satisfy this using a mix of:

- selected per-workspace tool mounts
- base runtime binaries already present in the sandbox

Example:

- `fhir-validator` may be a selected mounted local tool
- `java` may come from the base runtime image or read-only runtime mounts
- the client still selects only `fhir-validator`

The protocol does not standardize how the manager accomplishes this.

Allowed implementation strategies include:

- bind mounts
- copied files
- preinstalled binaries
- per-runtime image contents

## Demo Contract

For the demo:

- `GET /apis/v1/local-tools` advertises at least `fhir-validator`
- workspace creation selects `runtime.localTools: ["fhir-validator"]`
- workspace detail shows resolved local tool metadata
- `hl7-jira` is separately registered through `POST /tools`

This gives the audience a clear story:

- the manager provides trusted local runtime capabilities
- the workspace tools API provides first-class managed agent tools

## Tradeoffs

Benefits:

- simple enough to implement and demo
- explicit enough to avoid hidden manager magic
- avoids standardizing package transport too early
- keeps local runtime tools separate from managed MCP tools

Costs:

- local tool names are only portable across managers that publish compatible
  catalogs
- this does not solve cross-manager packaging or distribution
- local tools remain less standardized than MCP tools

## Non-Goals

Explicitly deferred:

- standardizing how managers acquire local tools
- requiring Docker, OCI, npm, or any other packaging format
- making local runtime tools first-class schema-bearing workspace tools
- attaching grants or approval policy to bash-only local tools
