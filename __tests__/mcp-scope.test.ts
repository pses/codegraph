/**
 * MCP server repo-set scope enforced across the nav tools (P2A Task 4).
 *
 * A scoped MCP session (our per-project layer starts one MCP per run, scoped to
 * that project's repos) must never let an agent retrieve data from a repo
 * outside the scope — no matter which read tool it calls. The scope is applied
 * once, at `ToolHandler.getCodeGraph()`, which returns a scoped CodeGraph view
 * (`createScopedCodeGraph`), so every tool handler queries through it.
 *
 * We drive the handlers directly (`executeReadTool`) over a merged 2-repo DB and
 * assert, PER TOOL, that:
 *   - scoped to {repo-a}, NO repo-b node / symbol / callee / source ever appears;
 *   - with NO scope, repo-b IS reachable (upstream behavior, unchanged).
 *
 * Fixture mirrors the Task-3 repo-scope fixture: `Shared` is defined in BOTH
 * repos (the name-fallback trap), `repo-a/makeWidget` constructs `repo-b/Widget`
 * (a real cross-repo edge for the traversal test), and `onlyInB` is repo-b-only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler, type ToolResult } from '../src/mcp/tools';
import { createScopedCodeGraph } from '../src/mcp/scoped-codegraph';
import { countImplementers } from '../src/graph/type-hierarchy';

describe('MCP repo-set scope (nav tools)', () => {
  let dir: string;
  let cg: CodeGraph;
  let scoped: ToolHandler;   // session scoped to {repo-a}
  let unscoped: ToolHandler; // no scope — all repos (upstream)

  beforeAll(async () => {
    // A scoped session declares its boundary via this env; make sure the
    // "unscoped" handler really is unscoped regardless of the ambient env.
    delete process.env.CODEGRAPH_MCP_REPOS;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-scope-'));
    fs.mkdirSync(path.join(dir, 'repo-a'));
    fs.mkdirSync(path.join(dir, 'repo-b'));

    fs.writeFileSync(
      path.join(dir, 'repo-b', 'b.ts'),
      [
        'export class Widget {',
        '  render(): string { return "widget"; }',
        '}',
        'export class Shared {',
        '  tag(): string { return "b-shared"; }',
        '}',
        'export function onlyInB(): string { return "b"; }',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'repo-a', 'a.ts'),
      [
        "import { Widget } from '../repo-b/b';",
        '',
        'export function makeWidget(): Widget {',
        '  return new Widget();',
        '}',
        '',
        'export class Shared {',
        '  tag(): string { return "a-shared"; }',
        '}',
      ].join('\n'),
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    scoped = new ToolHandler(cg, ['repo-a']);
    unscoped = new ToolHandler(cg);
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const text = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

  // ---- search --------------------------------------------------------------

  it('search: scope hides a repo-b-only symbol; unscoped finds it', async () => {
    const un = text(await unscoped.executeReadTool('codegraph_search', { query: 'onlyInB' }));
    expect(un).toContain('onlyInB');
    expect(un).toContain('repo-b'); // upstream reaches repo-b

    const sc = text(await scoped.executeReadTool('codegraph_search', { query: 'onlyInB' }));
    expect(sc).not.toContain('repo-b'); // no out-of-scope hit surfaces
    expect(sc).toMatch(/No results/i); // (the message still echoes the query term)
  });

  it('search: a name defined in BOTH repos returns only the in-scope repo', async () => {
    const un = text(await unscoped.executeReadTool('codegraph_search', { query: 'Shared' }));
    expect(un).toContain('repo-a');
    expect(un).toContain('repo-b'); // both, unscoped

    const sc = text(await scoped.executeReadTool('codegraph_search', { query: 'Shared' }));
    expect(sc).toContain('repo-a');
    expect(sc).not.toContain('repo-b');
  });

  // ---- traversal (callees across a real cross-repo edge) -------------------

  it('callees: scope drops the repo-b callee reached over the cross-repo edge', async () => {
    const un = text(await unscoped.executeReadTool('codegraph_callees', { symbol: 'makeWidget' }));
    expect(un).toContain('Widget');
    expect(un).toContain('repo-b'); // makeWidget -> repo-b/Widget, unscoped

    const sc = text(await scoped.executeReadTool('codegraph_callees', { symbol: 'makeWidget' }));
    expect(sc).not.toContain('repo-b');
  });

  // ---- node lookup ---------------------------------------------------------

  it('node: scope hides a repo-b-only symbol; unscoped reads it', async () => {
    const un = text(await unscoped.executeReadTool('codegraph_node', { symbol: 'onlyInB' }));
    expect(un).toContain('repo-b');

    const sc = text(await scoped.executeReadTool('codegraph_node', { symbol: 'onlyInB' }));
    expect(sc).not.toContain('repo-b');
  });

  it('node: a both-repos name resolves only to the in-scope definition', async () => {
    const sc = text(await scoped.executeReadTool('codegraph_node', { symbol: 'Shared' }));
    expect(sc).toContain('repo-a');
    expect(sc).not.toContain('repo-b');
  });

  // ---- files ---------------------------------------------------------------

  it('files: the indexed file tree lists only in-scope repos', async () => {
    const un = text(await unscoped.executeReadTool('codegraph_files', {}));
    expect(un).toContain('repo-a');
    expect(un).toContain('repo-b');

    const sc = text(await scoped.executeReadTool('codegraph_files', {}));
    expect(sc).toContain('repo-a');
    expect(sc).not.toContain('repo-b');
  });
});

/**
 * Batch edge/node accessors must obey the same repo-set boundary as their
 * single-node siblings (the `codegraph_explore` cross-scope leak, review of
 * Task 4).
 *
 * `codegraph_explore` → `buildPolymorphicBoundaries` → `countImplementers`
 * calls `cg.getIncomingEdgesTo([typeId], ['implements','extends'])`, and the
 * type-hierarchy walk also uses `getOutgoingEdgesFrom` / `getNodesByIds`. Those
 * three batch methods were NOT in the scoped-Proxy override table, so they
 * forwarded UNSCOPED — an interface in repo-a would count its repo-b
 * implementers, leaking a cross-scope magnitude (and, via `buildTypeHierarchy`,
 * latently the raw out-of-scope `Node[]`).
 *
 * Fixture: `Drawable` (interface, repo-a) with one implementer in each repo
 * (`ASquare` in repo-a, `BCircle` in repo-b — a real cross-repo `implements`
 * edge), plus a cross-repo call (`useCircle` in repo-a constructs `BCircle`).
 */
describe('MCP repo-set scope (batch edge/node accessors)', () => {
  let dir: string;
  let cg: CodeGraph;
  let scopedCg: CodeGraph; // repo-a view of the same DB

  const idsByName = (graph: CodeGraph, name: string): string[] =>
    graph.getNodesByName(name).map((n) => n.id);
  const oneId = (name: string): string => {
    const ids = cg.getNodesByName(name).map((n) => n.id);
    expect(ids.length).toBeGreaterThan(0);
    return ids[0];
  };

  beforeAll(async () => {
    delete process.env.CODEGRAPH_MCP_REPOS;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-scope-hier-'));
    fs.mkdirSync(path.join(dir, 'repo-a'));
    fs.mkdirSync(path.join(dir, 'repo-b'));

    fs.writeFileSync(
      path.join(dir, 'repo-a', 'a.ts'),
      [
        "import { BCircle } from '../repo-b/b';",
        '',
        'export interface Drawable {',
        '  draw(): void;',
        '}',
        '',
        'export class ASquare implements Drawable {',
        '  draw(): void {}',
        '}',
        '',
        'export function useCircle(): void {',
        '  new BCircle();',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'repo-b', 'b.ts'),
      [
        "import { Drawable } from '../repo-a/a';",
        '',
        'export class BCircle implements Drawable {',
        '  draw(): void {}',
        '}',
      ].join('\n'),
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    scopedCg = createScopedCodeGraph(cg, ['repo-a']);
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- the explore leak: countImplementers over getIncomingEdgesTo ---------

  it('countImplementers: unscoped counts the repo-b implementer, scope drops it', () => {
    const drawableId = oneId('Drawable');

    // Sanity: the cross-repo `implements` edge exists (both implementers count).
    expect(countImplementers(cg, drawableId)).toBe(2);

    // Scoped to {repo-a}: the repo-b implementer must NOT be counted.
    expect(countImplementers(scopedCg, drawableId)).toBe(1);
  });

  // ---- direct batch-accessor scoping --------------------------------------

  it('getIncomingEdgesTo: scope drops edges whose source is out of scope', () => {
    const drawableId = oneId('Drawable');
    const kinds = ['implements', 'extends'] as const;

    const un = cg.getIncomingEdgesTo([drawableId], kinds as never);
    const unSources = new Set(un.map((e) => e.source));
    expect(unSources.has(idsByName(cg, 'ASquare')[0])).toBe(true);
    expect(unSources.has(idsByName(cg, 'BCircle')[0])).toBe(true);

    const sc = scopedCg.getIncomingEdgesTo([drawableId], kinds as never);
    const scSources = new Set(sc.map((e) => e.source));
    expect(scSources.has(idsByName(cg, 'ASquare')[0])).toBe(true);
    expect(scSources.has(idsByName(cg, 'BCircle')[0])).toBe(false);
    // every surviving edge has both endpoints in repo-a
    for (const e of sc) {
      expect(cg.getNode(e.source)?.filePath.startsWith('repo-a')).toBe(true);
      expect(cg.getNode(e.target)?.filePath.startsWith('repo-a')).toBe(true);
    }
  });

  it('getOutgoingEdgesFrom: scope drops edges whose target is out of scope', () => {
    const useCircleId = oneId('useCircle');

    const un = cg.getOutgoingEdgesFrom([useCircleId]);
    const unTargets = un.map((e) => cg.getNode(e.target)?.filePath ?? '');
    expect(unTargets.some((p) => p.startsWith('repo-b'))).toBe(true); // reaches BCircle

    const sc = scopedCg.getOutgoingEdgesFrom([useCircleId]);
    for (const e of sc) {
      expect(cg.getNode(e.source)?.filePath.startsWith('repo-a')).toBe(true);
      expect(cg.getNode(e.target)?.filePath.startsWith('repo-a')).toBe(true);
    }
  });

  it('getNodesByIds: scope drops out-of-scope nodes and keeps the Map shape', () => {
    const aId = idsByName(cg, 'ASquare')[0];
    const bId = idsByName(cg, 'BCircle')[0];

    const un = cg.getNodesByIds([aId, bId]);
    expect(un.has(aId)).toBe(true);
    expect(un.has(bId)).toBe(true);

    const sc = scopedCg.getNodesByIds([aId, bId]);
    expect(sc).toBeInstanceOf(Map);
    expect(sc.has(aId)).toBe(true);
    expect(sc.has(bId)).toBe(false); // repo-b node filtered out
  });
});
