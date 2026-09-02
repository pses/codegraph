/**
 * Repo-subset scope (P2A productionization, Task 3).
 *
 * A query over a merged multi-repo DB can be restricted to a chosen set of repos
 * (repo = `file_path.split('/')[0]`) and must NEVER return or expand into an
 * out-of-scope repo. Three call paths carry an OPTIONAL, additive scope:
 *
 *   1. name lookup  — `QueryBuilder.getNodesByName(name, repos?)`
 *   2. search       — a `repo:` filter parsed by `parseQuery`, gated in searchNodes
 *   3. traversal    — `TraversalOptions.repos` / `getCallers`/`getCallees` repo arg
 *
 * When the scope is ABSENT, behavior is byte-identical to upstream. When a
 * repo-set is provided, an out-of-scope repo is never a candidate, a search
 * hit, or a traversal neighbor — even across a real cross-repo edge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

describe('repo-subset scope', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scope-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Two repos laid out under `<repo>/` and indexed TOGETHER (rootDir = parent) —
   * the productionization merge shape, so `file_path` comes out `<repo>/...`.
   *
   * - `Shared` is a class name defined in BOTH repos (the name-fallback trap).
   * - repo-a's `makeWidget` imports and constructs repo-b's `Widget` → a real
   *   CROSS-repo edge for the traversal test.
   * - `onlyInB` is a repo-b-only symbol for the search test.
   */
  async function buildFixture(): Promise<CodeGraph> {
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

    const g = CodeGraph.initSync(dir);
    await g.indexAll();
    return g;
  }

  /** Repo of a node by the working-DB layout convention. */
  const repoOf = (n: Node): string => n.filePath.split('/')[0]!;

  it('(1) name lookup: scope keeps only in-scope candidates; unscoped is unchanged', async () => {
    cg = await buildFixture();
    const queries = (cg as unknown as { queries: {
      getNodesByName(name: string, repos?: readonly string[]): Node[];
    } }).queries;

    // Unscoped (upstream behavior): `Shared` exists in BOTH repos.
    const all = queries.getNodesByName('Shared');
    const allRepos = new Set(all.map(repoOf));
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(allRepos.has('repo-a')).toBe(true);
    expect(allRepos.has('repo-b')).toBe(true);

    // Scoped to repo-a: only repo-a candidates, though `Shared` exists in both.
    const scoped = queries.getNodesByName('Shared', ['repo-a']);
    expect(scoped.length).toBeGreaterThanOrEqual(1);
    expect(scoped.every((n) => repoOf(n) === 'repo-a')).toBe(true);
    expect(scoped.some((n) => repoOf(n) === 'repo-b')).toBe(false);
  });

  it('(2) search: repo: scope drops out-of-scope symbols; unscoped is unchanged', async () => {
    cg = await buildFixture();

    // Unscoped: the repo-b-only symbol is found.
    const unscoped = cg.searchNodes('onlyInB');
    expect(unscoped.some((r) => r.node.name === 'onlyInB' && repoOf(r.node) === 'repo-b')).toBe(true);

    // Scoped to repo-a via the `repo:` filter: no repo-b symbol survives.
    const scoped = cg.searchNodes('onlyInB repo:repo-a');
    expect(scoped.some((r) => repoOf(r.node) === 'repo-b')).toBe(false);
    expect(scoped.some((r) => r.node.name === 'onlyInB')).toBe(false);
  });

  it('(3) traversal: BFS scoped to repo-a never yields a repo-b node across a cross-repo edge; unscoped does', async () => {
    cg = await buildFixture();

    const makeWidget = cg.getNodesByName('makeWidget').find((n) => n.name === 'makeWidget');
    expect(makeWidget).toBeDefined();

    // Unscoped BFS crosses the import edge into repo-b (proves the edge exists
    // and the default is unchanged).
    const unscoped = cg.traverse(makeWidget!.id, { direction: 'outgoing', maxDepth: 3 });
    const unscopedRepos = new Set([...unscoped.nodes.values()].map(repoOf));
    expect(unscopedRepos.has('repo-b')).toBe(true);

    // Scoped to repo-a: BFS never crosses into repo-b.
    const scoped = cg.traverse(makeWidget!.id, { direction: 'outgoing', maxDepth: 3, repos: ['repo-a'] });
    const scopedRepos = new Set([...scoped.nodes.values()].map(repoOf));
    expect(scopedRepos.has('repo-b')).toBe(false);
    expect([...scoped.nodes.values()].every((n) => repoOf(n) === 'repo-a')).toBe(true);
  });

  it('(3b) getCallees scoped to repo-a drops a repo-b callee; unscoped keeps it', async () => {
    cg = await buildFixture();
    const makeWidget = cg.getNodesByName('makeWidget').find((n) => n.name === 'makeWidget')!;

    const unscoped = cg.getCallees(makeWidget.id, 2);
    expect(unscoped.some(({ node }) => repoOf(node) === 'repo-b')).toBe(true);

    const scoped = cg.getCallees(makeWidget.id, 2, ['repo-a']);
    expect(scoped.some(({ node }) => repoOf(node) === 'repo-b')).toBe(false);
  });
});
