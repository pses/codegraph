/**
 * Cross-repo REST edges (P2C).
 *
 * The coupling between two repos in one project is rarely a symbol: it is an
 * HTTP call on one side and a route declaration on the other, and neither side
 * imports the other. The `http-client` channel of `resolution/tier-synthesizer`
 * pairs them on method + path; this suite pins the properties that make such a
 * pairing usable by a per-project layer that serves a REPO SUBSET of a MERGED
 * multi-repo graph over MCP:
 *
 *   1. the edge exists across a repo boundary, and carries the repo of each end
 *      (`sourceRepo` / `targetRepo` / `crossRepo`) plus a CONFIDENCE under
 *      `edgeTier` — `medium` for a whole-path match, `low` when only the tail
 *      matched behind a base URL, never `high`;
 *   2. a dynamic URL and a method mismatch produce NOTHING (a wrong cross-repo
 *      edge sends a reader into the wrong service — silence is cheaper);
 *   3. the pairing survives the real pipeline: extract each repo separately,
 *      merge the node DBs, resolve over the merge — which is where the app runs
 *      it, and where the route nodes have to have arrived by row-copy;
 *   4. an edge that leaves the MCP session's repo scope is filtered EXACTLY as a
 *      cross-repo name edge is — both ends must be in scope or neither end is
 *      reachable.
 *
 * The two-repos-under-one-root layout is the one `edge-repo-tier.test.ts` and
 * `mcp-scope.test.ts` use: a node's `file_path` first segment IS its repo, and
 * indexing together is equivalent to merging (P2A spike, Task 3) — test 3 below
 * exercises the merge itself so the equivalence is not merely asserted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { createScopedCodeGraph } from '../src/mcp/scoped-codegraph';
import type { Edge, Node } from '../src/types';

// node:sqlite (the merge below uses the raw handle) needs Node >= 22.5.
const HAS_SQLITE = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

/** The client repo: a frontend whose only link to the API is the path it calls. */
const WEB_FILES: Record<string, string> = {
  'src/api.ts': [
    "const BASE = process.env.API_URL ?? '';",
    '',
    '// Whole path, written from the root — the strongest form of the pairing.',
    'export async function loadFoo(id: string): Promise<unknown> {',
    '  const res = await fetch(`/api/foo/${id}`);',
    '  return res.json();',
    '}',
    '',
    'export async function createFoo(body: unknown): Promise<unknown> {',
    "  return fetch('/api/foo', { method: 'POST', body: JSON.stringify(body) });",
    '}',
    '',
    '// A base URL hides the front of the path — matched by its tail only.',
    'export async function loadBar(id: string): Promise<unknown> {',
    '  return fetch(`${BASE}/api/bar/${id}`);',
    '}',
    '',
    "// A route only Fastify's spelling declares.",
    'export async function ping(): Promise<unknown> {',
    "  return fetch('/api/health');",
    '}',
    '',
    '// Nothing literal at all: the URL is a parameter.',
    'export async function loadAnything(url: string): Promise<unknown> {',
    '  return fetch(url);',
    '}',
    '',
    '// The path a route serves, under a method it does not.',
    'export async function dropOnlyGet(id: string): Promise<unknown> {',
    "  return fetch(`/api/only-get/${id}`, { method: 'DELETE' });",
    '}',
  ].join('\n'),
  // A single-file component client. `.vue` / `.svelte` / `.astro` were not
  // scanned at all before P2C, so a Vue frontend produced no client→server
  // edge however plainly it named the path.
  'src/FooList.vue': [
    '<script setup lang="ts">',
    "import axios from 'axios'",
    'async function loadList() {',
    "  return axios.get('/api/list')",
    '}',
    '</script>',
    '<template><div @click="loadList()" /></template>',
  ].join('\n'),
  // A bare-name use of a symbol only the API repo declares — the cross-repo
  // NAME edge the scope test compares the REST edge against.
  'src/inspect.ts': [
    'export function inspectRecord(record: FooRecord): string {',
    '  return record.label;',
    '}',
  ].join('\n'),
};

/** The server repo. `routes/` + `express` in the source is what the express resolver detects on. */
const API_FILES: Record<string, string> = {
  'routes/foo.js': [
    "const express = require('express');",
    'const router = express.Router();',
    '',
    "router.get('/api/foo/:id', getFoo);",
    "router.post('/api/foo', createFoo);",
    "router.get('/api/bar/:id', getBar);",
    "router.get('/api/only-get/:id', getOnlyGet);",
    "router.get('/api/list', listFoo);",
    '',
    'module.exports = router;',
  ].join('\n'),
  // Fastify's own spelling of a registration. Before P2C the express extractor
  // only read `app.` / `router.`, so this declared no route at all and a client
  // call onto it had nothing to pair with.
  'routes/health.js': [
    "const fastify = require('fastify')();",
    '',
    "fastify.get('/api/health', checkHealth);",
    '',
    'module.exports = fastify;',
  ].join('\n'),
  'src/foo-record.ts': [
    'export class FooRecord {',
    "  label: string = '';",
    '}',
  ].join('\n'),
};

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Lay both repos out under `root` as `<repo>/…`, the merged-project shape. */
function writeBothRepos(root: string): void {
  writeTree(path.join(root, 'web-app'), WEB_FILES);
  writeTree(path.join(root, 'api-svc'), API_FILES);
}

type Meta = Record<string, unknown>;
const meta = (e: Edge): Meta => (e.metadata ?? {}) as Meta;
const isRest = (e: Edge): boolean => meta(e).synthesizedBy === 'http-client';

describe('REST edges across a repo boundary', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-'));
    writeBothRepos(dir);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  }, 180_000);

  afterAll(() => {
    cg?.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fn = (name: string): Node => {
    const found = cg.getNodesByName(name).filter((n) => n.kind === 'function');
    if (!found[0]) throw new Error(`no function ${name}`);
    return found[0];
  };
  const route = (name: string): Node => {
    const all = cg.getNodesByKind('route');
    const r = all.find((n) => n.name === name);
    if (!r) throw new Error(`no route ${name}: [${all.map((n) => n.name).join(', ')}]`);
    return r;
  };
  const restEdges = (from: Node): Edge[] => cg.getOutgoingEdges(from.id).filter(isRest);

  it('pairs a client call in one repo with the route declared in another, stamped with both repos', () => {
    const edges = restEdges(fn('loadFoo'));
    expect(edges).toHaveLength(1);
    const e = edges[0]!;
    expect(e.kind).toBe('calls');
    expect(e.provenance).toBe('heuristic');
    expect(e.target).toBe(route('GET /api/foo/:id').id);
    expect(meta(e)).toMatchObject({
      synthesizedBy: 'http-client',
      channel: 'http',
      method: 'GET',
      href: '/api/foo/${…}',
      // Direction (the pass's own `tier`) and CONFIDENCE (`edgeTier`) are
      // different facts under different keys — this is why P2C added the
      // second key rather than overloading the first.
      tier: 'client→server',
      edgeTier: 'medium',
      sourceRepo: 'web-app',
      targetRepo: 'api-svc',
      crossRepo: true,
    });
  });

  it('a POST body call pairs with the POST route, not the GET one on the same path', () => {
    const edges = restEdges(fn('createFoo'));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('POST /api/foo').id);
    expect(meta(edges[0]!).edgeTier).toBe('medium');
  });

  it('a path matched only by its tail behind a base URL lands in the LOW tier', () => {
    const edges = restEdges(fn('loadBar'));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('GET /api/bar/:id').id);
    // The hidden prefix could belong to a different service — least trusted.
    expect(meta(edges[0]!).edgeTier).toBe('low');
    expect(meta(edges[0]!).crossRepo).toBe(true);
  });

  it('no REST edge is ever `high` — a path pairing is agreement, not a binding', () => {
    const tiers = new Set<unknown>();
    for (const n of cg.getNodesByKind('function')) {
      for (const e of cg.getOutgoingEdges(n.id)) if (isRest(e)) tiers.add(meta(e).edgeTier);
    }
    expect(tiers.size).toBeGreaterThan(0);
    expect(tiers.has('high')).toBe(false);
    expect([...tiers].sort()).toEqual(['low', 'medium']);
  });

  it('reads a client call out of a .vue single-file component', () => {
    const loadList = cg.getNodesByName('loadList').find((n) => n.filePath.endsWith('.vue'));
    expect(loadList).toBeDefined();
    const edges = cg.getOutgoingEdges(loadList!.id).filter(isRest);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('GET /api/list').id);
    expect(meta(edges[0]!)).toMatchObject({ callee: 'axios.get', edgeTier: 'medium', crossRepo: true });
  });

  it("pairs onto a route declared in Fastify's spelling, `fastify.get(path, handler)`", () => {
    const edges = restEdges(fn('ping'));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('GET /api/health').id);
    expect(meta(edges[0]!)).toMatchObject({ edgeTier: 'medium', sourceRepo: 'web-app', targetRepo: 'api-svc' });
  });

  it('produces nothing for a dynamic URL, and nothing for a method the route does not serve', () => {
    expect(restEdges(fn('loadAnything'))).toHaveLength(0);
    // The path IS served — by GET. The call is a DELETE, so there is no pairing.
    expect(restEdges(fn('dropOnlyGet'))).toHaveLength(0);
    const onlyGet = route('GET /api/only-get/:id');
    expect(cg.getIncomingEdges(onlyGet.id).filter(isRest)).toHaveLength(0);
  });

  // ---- scope safety --------------------------------------------------------

  it('a REST edge pointing out of the MCP repo scope is filtered exactly like a name edge', () => {
    const client = fn('loadFoo');
    const inspector = fn('inspectRecord');
    const routeNode = route('GET /api/foo/:id');
    const record = cg.getNodesByName('FooRecord').find((n) => n.kind === 'class');
    expect(record).toBeDefined();

    // Unscoped, BOTH cross-repo edges are present: the REST pairing and the
    // bare-name match. This is the control — the scope must remove them, not
    // the fixture failing to produce them.
    expect(cg.getOutgoingEdges(client.id).filter(isRest).map((e) => e.target)).toEqual([routeNode.id]);
    const nameEdge = cg.getOutgoingEdges(inspector.id).find((e) => e.target === record!.id);
    expect(nameEdge).toBeDefined();
    expect(meta(nameEdge!).sourceRepo).toBe('web-app');
    expect(meta(nameEdge!).targetRepo).toBe('api-svc');

    // Scoped to the client repo only: the far end of each edge is not a node
    // any more, so neither edge is either — the single rule in
    // `createScopedCodeGraph` (both endpoints in scope) covers a REST edge
    // without knowing anything about REST.
    const scoped = createScopedCodeGraph(cg, ['web-app']);
    expect(scoped.getNode(routeNode.id)).toBeNull();
    expect(scoped.getNode(record!.id)).toBeNull();
    expect(scoped.getOutgoingEdges(client.id).filter(isRest)).toHaveLength(0);
    expect(scoped.getOutgoingEdges(inspector.id).some((e) => e.target === record!.id)).toBe(false);
    // The batch forms behind `codegraph_explore` scope identically.
    expect(scoped.getOutgoingEdgesFrom([client.id], ['calls']).filter(isRest)).toHaveLength(0);
    expect(scoped.getIncomingEdgesTo([routeNode.id], ['calls'])).toHaveLength(0);

    // Scoped to the server repo only: the route is reachable, the client is
    // not, and the edge between them is still gone.
    const serverOnly = createScopedCodeGraph(cg, ['api-svc']);
    expect(serverOnly.getNode(routeNode.id)?.id).toBe(routeNode.id);
    expect(serverOnly.getNode(client.id)).toBeNull();
    expect(serverOnly.getIncomingEdges(routeNode.id).filter(isRest)).toHaveLength(0);

    // With BOTH repos in scope the edge survives — the filter is a boundary,
    // not a blanket ban on crossing repos.
    const both = createScopedCodeGraph(cg, ['web-app', 'api-svc']);
    expect(both.getOutgoingEdges(client.id).filter(isRest).map((e) => e.target)).toEqual([routeNode.id]);
  });
});

// =============================================================================
// The real pipeline: extract per repo, merge the DBs, resolve over the merge.
// =============================================================================

/**
 * The per-project merge our layer performs, reduced to what this test needs:
 * repo A's DB file becomes the merged DB (identical schema, so this is the
 * "clone the schema from the first source" step), then repo B's rows are copied
 * in through the same explicit column lists — autoincrement `id` columns are
 * NOT carried across, exactly as the real merge leaves them to be re-assigned.
 */
function mergeNodeDbs(sourceDbs: string[], mergedDbPath: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  fs.mkdirSync(path.dirname(mergedDbPath), { recursive: true });
  fs.copyFileSync(sourceDbs[0]!, mergedDbPath);

  const columns: Record<string, string[]> = {
    nodes: [
      'id', 'kind', 'name', 'qualified_name', 'file_path', 'language',
      'start_line', 'end_line', 'start_column', 'end_column', 'docstring',
      'signature', 'visibility', 'is_exported', 'is_async', 'is_static',
      'is_abstract', 'decorators', 'type_parameters', 'return_type', 'updated_at',
    ],
    edges: ['source', 'target', 'kind', 'metadata', 'line', 'col', 'provenance'],
    unresolved_refs: [
      'from_node_id', 'reference_name', 'reference_kind', 'line', 'col',
      'candidates', 'file_path', 'language', 'status', 'name_tail',
    ],
    files: ['path', 'content_hash', 'language', 'size', 'modified_at', 'indexed_at', 'node_count', 'errors', 'generated'],
    name_segment_vocab: ['segment', 'name'],
    project_metadata: ['key', 'value', 'updated_at'],
  };

  const merged = new DatabaseSync(mergedDbPath);
  try {
    for (const src of sourceDbs.slice(1)) {
      merged.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS s`);
      try {
        for (const [table, cols] of Object.entries(columns)) {
          const list = cols.map((c) => `"${c}"`).join(', ');
          merged.exec(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM s.${table}`);
        }
      } finally {
        merged.exec('DETACH DATABASE s');
      }
    }
  } finally {
    merged.close();
  }
}

describe.skipIf(!HAS_SQLITE)('REST edges survive extract-per-repo → merge → resolve', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-merge-'));
  });
  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('the route node arrives by row-copy and the client call pairs with it on the merged graph', async () => {
    // Each repo is extracted under its OWN root that contains only `<repo>/`,
    // so its node `file_path`s come out `<repo>/…` — what makes the ids
    // globally unique and the rows mergeable by a straight copy.
    const dbs: string[] = [];
    for (const repo of ['web-app', 'api-svc'] as const) {
      const root = path.join(tempDir, `extract-${repo}`);
      fs.mkdirSync(root, { recursive: true });
      writeTree(path.join(root, repo), repo === 'web-app' ? WEB_FILES : API_FILES);
      const one = await CodeGraph.init(root, {});
      const res = await one.indexAll({ extractOnly: true });
      expect(res.success).toBe(true);
      one.close?.();
      dbs.push(path.join(root, '.codegraph', 'codegraph.db'));
    }

    // The merged working dir holds BOTH repos' sources — resolution re-reads
    // files, so the client's source has to be there beside the server's.
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    writeBothRepos(projectDir);
    mergeNodeDbs(dbs, path.join(projectDir, '.codegraph', 'codegraph.db'));

    const merged = await CodeGraph.open(projectDir);
    try {
      // The route node was produced by the API repo's extraction and copied in.
      const routeNode = merged.getNodesByKind('route').find((n) => n.name === 'GET /api/foo/:id');
      expect(routeNode).toBeDefined();
      expect(routeNode!.filePath).toBe('api-svc/routes/foo.js');

      await merged.resolveExtracted();

      const client = merged.getNodesByName('loadFoo').find((n) => n.kind === 'function');
      expect(client).toBeDefined();
      const edges = merged.getOutgoingEdges(client!.id).filter(isRest);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target).toBe(routeNode!.id);
      expect(meta(edges[0]!)).toMatchObject({
        edgeTier: 'medium',
        sourceRepo: 'web-app',
        targetRepo: 'api-svc',
        crossRepo: true,
      });
    } finally {
      merged.close?.();
    }
  }, 300_000);
});
