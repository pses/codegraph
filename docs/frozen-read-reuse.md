# Frozen read-only startup and isolated process reuse

Release: 1.6.0-sesp-007. Targeted adaptation of upstream
`6ad8beccf7aca0b5cd287e31026988b634c7847a` (#3143), not a wholesale merge.
Read commands load indexing modules lazily; writer behavior is preserved.

Frozen MCP opens current-schema SQLite databases read-only, without migrations,
interrupted-index repair, grammar startup or framework resolver construction.
Secondary project opens and daemon query workers obey the same restriction.
An incompatible schema requires re-indexing with this version before serving.

An embedding host may set `CODEGRAPH_FROZEN=1` and
`CODEGRAPH_ALLOW_SESSION_RESET=1` in direct mode. Only then initialize advertises
`experimental["uca/session-reset"] = {version: 1}` and the private
`uca/resetSession` JSON-RPC method is available. It is deliberately not a tool.
The host must hold the process exclusively, keep repository/tool scope immutable,
release all calls, then reset before assigning it to another run. Reset clears
explore emission history and refuses while tools are in flight. It never changes
scope, index identity, authorization or tool configuration. Shared daemon sessions
cannot opt in through this environment variable.

Verification includes real read-only writes/repair rejection, a built-child
module-load assertion, a built daemon worker with secondary project access, and
session reset/capability/concurrency tests. Local small-index measurements are
not production latency guarantees.
