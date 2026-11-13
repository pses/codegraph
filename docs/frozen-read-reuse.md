# Frozen read-only startup and isolated process reuse

This branch merges upstream `f72c9d2efb14454ff4f9fd7b8460abd82f19a287`
(1.6.2, 2026-11-01), including all 889 previously missing upstream commits.
It is no longer just the earlier targeted adaptation of #3143. Package and UI
versions follow upstream; the embedding application's exact Git pin identifies
this fork build.

Upstream supplies lazy write-engine loading, read-only SQLite opens, deferred
index recovery, bounded impact walks and query-worker lifecycle improvements.
The fork retains repo-set query scope, extract-only / standalone resolution,
root-link source containment, config-value masking, response budgets and
cross-repo confidence/HTTP-edge annotations. The new call-site, copybook and
miss-diagnostic APIs also obey the repo-set boundary. TypeScript name matches
respect upstream module/global visibility; invalid unimported type references
are not restored as guessed edges.

Frozen MCP opens SQLite read-only, without migrations, interrupted-index repair,
grammar startup or framework resolver construction. Upstream's backward-compatible
read paths can query older schemas without upgrading them. Secondary project
opens and query workers obey the same restriction. A frozen reader claims no
writer slot and never starts catch-up sync or watching.

An embedding host may set `CODEGRAPH_FROZEN=1` and
`CODEGRAPH_ALLOW_SESSION_RESET=1` in direct mode. Only then initialize advertises
`experimental["uca/session-reset"] = {version: 1}` and the private
`uca/resetSession` JSON-RPC method is available. It is deliberately not a tool.
The host must hold the process exclusively, keep repository/tool scope immutable,
release all calls, then reset before assigning it to another run. Reset clears
explore emission history and per-client stale-index warnings, and refuses while
tools are in flight. It never changes scope, index identity, authorization or
tool configuration. Shared daemon sessions cannot opt in through this environment
variable.

`resolveExtracted()` includes upstream's parameter-flow post-pass, in the same
order as full indexing. A completed split resolution records
`project_metadata.uca_resolution_version=2`; embedding hosts use it alongside
schema 16 and extraction version 28 to invalidate old cached project graphs.
Schema migration by itself cannot recover symbols an older extractor omitted.

Verification includes actual SQLite write/repair refusal, a built-child lazy
module-load assertion, frozen query workers with secondary project access,
writer-slot coexistence, session reset/concurrency, scoped navigation/diagnostics,
and full-index versus split-pipeline parameter-flow parity. UCA additionally
exercises two real extracts, SQLite merge, standalone resolution and frozen stdio
source/navigation queries. Local small-index timings are not production latency
guarantees.
