import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { createScopedCodeGraph } from '../src/mcp/scoped-codegraph';
import type { Node } from '../src/types';

let dir: string; let cg: CodeGraph; let queries: QueryBuilder;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-upgrade-'));
  cg = CodeGraph.initSync(dir);
  queries = (cg as unknown as { queries: QueryBuilder }).queries;
});
afterEach(() => { cg.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function node(file: string, name: string, kind: Node['kind'] = 'function', language: Node['language'] = 'typescript') {
  queries.insertNode({ id: `${file}:${name}`, name, qualifiedName: `${file}::${name}`, kind, language,
    filePath: file, startLine: 1, endLine: 2, startColumn: 0, endColumn: 1 });
}

describe('fork scope after upstream upgrade', () => {
  it('SQL scope is case-sensitive like repo identity, including diagnostics', () => {
    node('Repo-A/private.ts', 'PrivateThing');
    const view = createScopedCodeGraph(cg, ['repo-a']);
    expect(cg.getNodesByName('PrivateThing')).toHaveLength(1);
    expect(view.getNodesByName('PrivateThing')).toEqual([]);
    expect(view.getExploreMissDiagnostics('PrivateThing').candidates).toEqual([]);
    expect(view.getUnseenNames(['PrivateThing'])).toEqual(['PrivateThing']);
  });
  it.each(['Shared', 'hare', 'Shaerd', 'Shared repo:z-visible'])('scope precedes every candidate limit for %s', query => {
    for (let i = 0; i < 300; i++) node(`a-hidden/${i}.ts`, 'Shared');
    for (let i = 0; i < 3; i++) node(`z-visible/${i}.ts`, 'Shared');
    const found = cg.searchNodes(query, { repos: ['z-visible'], limit: 5 });
    expect(found).toHaveLength(3);
    expect(found.every(result => result.node.filePath.startsWith('z-visible/'))).toBe(true);
  });
  it('pagination counts visible candidates only and composes query/session scopes', () => {
    for (let i = 0; i < 300; i++) node(`a-hidden/${i}.ts`, 'Shared');
    for (let i = 0; i < 3; i++) node(`z-visible/${i}.ts`, `Shared${i}`);
    const page = cg.searchNodes('kind:function', { repos: ['z-visible'], limit: 1, offset: 1 });
    expect(page.map(result => result.node.name)).toEqual(['Shared1']);
    expect(cg.searchNodes('Shared repo:a-hidden', { repos: ['z-visible'] })).toEqual([]);
  });
  it('copybook scope precedes the 200-include cap, including include-only members', () => {
    queries.upsertFile({ path: 'z-visible/visible.cbl', contentHash: 'hash', language: 'cobol', size: 100, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
    for (let i = 0; i < 200; i++) node(`a-hidden/${i}.cbl`, 'LAYOUT', 'import', 'cobol');
    node('z-visible/visible.cbl', 'LAYOUT', 'import', 'cobol');
    expect(cg.findNamedCopybooks('LAYOUT')[0]!.includes).toHaveLength(200);
    const named = createScopedCodeGraph(cg, ['z-visible']).findNamedCopybooks('LAYOUT');
    expect(named).toHaveLength(1);
    expect(named[0]!.includes.map(include => include.filePath)).toEqual(['z-visible/visible.cbl']);
  });
});
