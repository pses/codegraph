/**
 * Scoped CodeGraph view — the MCP session's repo-set boundary (P2A Task 4).
 *
 * Our per-project layer starts ONE MCP server per run, scoped to that project's
 * chosen repo set (a "repo" is a node's `file_path` first segment — the working
 * DBs lay repos out under `<repo>/`). This wraps the {@link CodeGraph} a tool
 * handler queries so EVERY node / edge / file / source result is restricted to
 * the in-scope repos, no matter which tool asked or how it navigates. It is the
 * single choke point: `ToolHandler.getCodeGraph()` returns this wrapper, so the
 * 8 read tools (search, callers, callees, impact, node, files, explore, status)
 * are all contained without threading scope through their bodies — there is no
 * per-tool bypass to forget.
 *
 * Enforcement is layered:
 *   - The methods Task 3 made scope-aware (`getNodesByName`, `searchNodes`,
 *     `getCallers` / `getCallees` / `getImpactRadius`) are called WITH the repo
 *     set, so the SQL / traversal never expands out of scope in the first place.
 *   - Every other node/edge/file/source-returning method the tools use is
 *     filtered in memory here (`getNode`, `getNodesInFile`, `getChildren`,
 *     out/incoming edges and their batch forms `getNodesByIds` /
 *     `getOutgoingEdgesFrom` / `getIncomingEdgesTo` — the type-hierarchy walk
 *     behind `codegraph_explore` — `getFile(s)`,
 *     `getFileDependents/Dependencies`, `getCode`, `findRelevantContext`,
 *     name-prefix/substring/kind lookups).
 *   - An out-of-scope node id resolves to `null` (`getNode`) and an out-of-scope
 *     file yields no nodes/source, so an edge crossing the boundary can never
 *     surface the far side's data — the far endpoint simply isn't there.
 *
 * When no repo set is supplied the raw instance is returned unwrapped, so
 * upstream single-repo behavior is byte-identical.
 */

import type CodeGraph from '../index';
import type { Node, Edge, Subgraph, SearchOptions, SearchResult, FileRecord } from '../types';
import { repoInScope } from '../db/repo-scope';

/**
 * Parse `CODEGRAPH_MCP_REPOS` (comma-separated repo names) into a repo set, or
 * `undefined` when unset/empty. This is how a scoped MCP session declares its
 * boundary; the env travels to a spawned daemon and is read in-process for a
 * direct-mode server, so it works across every runtime mode.
 */
export function parseMcpReposEnv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const repos = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return repos.length > 0 ? repos : undefined;
}

/**
 * Wrap `inner` so every query is restricted to `repos`. Returns a Proxy that
 * overrides only the result-bearing methods and forwards everything else (stats,
 * project root, watcher state, lifecycle) untouched. `repos` must be non-empty;
 * callers with no scope should use the raw instance.
 */
export function createScopedCodeGraph(inner: CodeGraph, repos: readonly string[]): CodeGraph {
  const repoList = [...repos];
  const repoSet = new Set(repoList);

  const nodeInScope = (n: Node | null | undefined): n is Node =>
    !!n && repoInScope(n.filePath, repoSet);
  const pathInScope = (p: string | undefined): boolean => repoInScope(p, repoSet);
  const filterNodes = (nodes: Node[]): Node[] => nodes.filter((n) => nodeInScope(n));

  // An edge is in scope only when BOTH endpoints resolve to in-scope nodes.
  // Resolving through the wrapper's own `getNode` (below) means an endpoint in
  // an out-of-scope repo reads back as `null`, so the edge is dropped — the same
  // "drop the out-of-scope neighbor and its edge" rule the scoped traversal uses.
  const edgeInScope = (e: Edge): boolean =>
    nodeInScope(inner.getNode(e.source)) && nodeInScope(inner.getNode(e.target));

  const scopeSubgraph = (sg: Subgraph): Subgraph => {
    const nodes = new Map<string, Node>();
    for (const [id, n] of sg.nodes) if (nodeInScope(n)) nodes.set(id, n);
    const edges = sg.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target));
    const roots = sg.roots.filter((id) => nodes.has(id));
    return { ...sg, nodes, edges, roots };
  };

  // Each override delegates to `inner` and applies the scope. Anything not here
  // is forwarded verbatim by the Proxy `get` trap.
  const overrides: Record<string, (...args: never[]) => unknown> = {
    // Task-3 scope-aware methods: push the repo set down so the DB / traversal
    // filters at the source. The agent cannot widen it — a `repos` arg it might
    // pass to a traversal tool is ignored in favor of the session scope.
    getNodesByName: ((name: string) => inner.getNodesByName(name, repoList)) as never,
    searchNodes: ((query: string, options?: SearchOptions): SearchResult[] =>
      inner.searchNodes(query, { ...(options ?? {}), repos: repoList })) as never,
    getCallers: ((nodeId: string, maxDepth?: number) =>
      inner.getCallers(nodeId, maxDepth, repoList)) as never,
    getCallees: ((nodeId: string, maxDepth?: number) =>
      inner.getCallees(nodeId, maxDepth, repoList)) as never,
    getImpactRadius: ((nodeId: string, maxDepth?: number) =>
      inner.getImpactRadius(nodeId, maxDepth, repoList)) as never,

    // In-memory scope for the remaining result-bearing surface.
    getNode: ((id: string): Node | null => {
      const n = inner.getNode(id);
      return nodeInScope(n) ? n : null;
    }) as never,
    getNodesInFile: ((filePath: string): Node[] =>
      pathInScope(filePath) ? inner.getNodesInFile(filePath) : []) as never,
    getNodesByNamePrefix: ((prefix: string, limit?: number): Node[] =>
      filterNodes(inner.getNodesByNamePrefix(prefix, limit as number))) as never,
    getNodesByNameSubstring: ((substring: string, options?: object): Node[] =>
      filterNodes(inner.getNodesByNameSubstring(substring, options as never))) as never,
    getNodesByKind: ((kind: string): Node[] =>
      filterNodes(inner.getNodesByKind(kind as never))) as never,
    getChildren: ((nodeId: string): Node[] => filterNodes(inner.getChildren(nodeId))) as never,
    getOutgoingEdges: ((nodeId: string): Edge[] =>
      inner.getOutgoingEdges(nodeId).filter(edgeInScope)) as never,
    getIncomingEdges: ((nodeId: string): Edge[] =>
      inner.getIncomingEdges(nodeId).filter(edgeInScope)) as never,

    // Batch forms of the single-node edge/node accessors. These are reached by
    // the type-hierarchy walk (`getNodesByIds` / `getOutgoingEdgesFrom` /
    // `getIncomingEdgesTo`) that `codegraph_explore` runs through
    // `countImplementers` — without these overrides they forwarded UNSCOPED and
    // an in-scope type's implementer count / hierarchy leaked out-of-scope
    // repos. Same rules as their single-node siblings above: an edge survives
    // only when BOTH endpoints are in scope; an out-of-scope node is dropped.
    getNodesByIds: ((ids: readonly string[]): Map<string, Node> => {
      const scoped = new Map<string, Node>();
      for (const [id, n] of inner.getNodesByIds(ids)) if (nodeInScope(n)) scoped.set(id, n);
      return scoped;
    }) as never,
    getOutgoingEdgesFrom: ((nodeIds: readonly string[], kinds?: Edge['kind'][]): Edge[] =>
      inner.getOutgoingEdgesFrom(nodeIds, kinds).filter(edgeInScope)) as never,
    getIncomingEdgesTo: ((nodeIds: readonly string[], kinds?: Edge['kind'][]): Edge[] =>
      inner.getIncomingEdgesTo(nodeIds, kinds).filter(edgeInScope)) as never,
    getFile: ((filePath: string): FileRecord | null =>
      pathInScope(filePath) ? inner.getFile(filePath) : null) as never,
    getFiles: ((): FileRecord[] => inner.getFiles().filter((f) => pathInScope(f.path))) as never,
    getFileDependents: ((filePath: string): string[] =>
      inner.getFileDependents(filePath).filter((p) => pathInScope(p))) as never,
    getFileDependencies: ((filePath: string): string[] =>
      inner.getFileDependencies(filePath).filter((p) => pathInScope(p))) as never,
    getCode: (async (nodeId: string): Promise<string | null> =>
      nodeInScope(inner.getNode(nodeId)) ? inner.getCode(nodeId) : null) as never,
    findRelevantContext: (async (query: string, options?: object): Promise<Subgraph> =>
      scopeSubgraph(await inner.findRelevantContext(query, options as never))) as never,
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      const override = typeof prop === 'string' ? overrides[prop] : undefined;
      if (override) return override;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as CodeGraph;
}
