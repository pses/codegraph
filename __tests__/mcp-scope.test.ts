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
