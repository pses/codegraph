/**
 * Cross-repo edge tiering (P2A productionization, Task 2).
 *
 * Every resolved edge is stamped in its metadata with the repo of each endpoint
 * (`sourceRepo`/`targetRepo`, derived from `file_path.split('/')[0]` — repos are
 * laid out under `<repo>/` in our per-project working DBs) and a confidence
 * `tier`:
 *   - `high`   — resolvedBy import / qualified-name / framework (precise),
 *   - `medium` — same-repo name match (exact-match / fuzzy / instance-method …),
 *   - `low`    — CROSS-repo name match (kept, never dropped — just marked low).
 *
 * The decisive property: a cross-repo bare-NAME edge (the "DbxFolderInfo-style"
 * link the spike found worth keeping) is PRESENT and tagged `low`, while a
 * cross-repo IMPORT edge is `high`. Tiering ANNOTATES; it never filters.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import type { Edge } from '../src/types';

describe('cross-repo edge tiering', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tier-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Find the first outgoing edge from a symbol named `from` to a symbol named `to`. */
  function edgeBetween(g: CodeGraph, from: string, to: string, kind?: Edge['kind']): Edge | undefined {
    const sources = g.searchNodes(from).map((r) => r.node).filter((n) => n.name === from);
    for (const s of sources) {
      for (const e of g.getOutgoingEdges(s.id)) {
        if (kind && e.kind !== kind) continue;
        const t = g.getNode(e.target);
        if (t?.name === to) return e;
      }
    }
    return undefined;
  }

  it('stamps repos + tiers: cross-repo import=high, cross-repo name=low (KEPT), same-repo name=medium', async () => {
    // Two repos laid out under `<repo>/` and indexed TOGETHER (rootDir = parent),
    // exactly the productionization merge shape — file_path comes out `<repo>/...`.
    fs.mkdirSync(path.join(dir, 'repo-a'));
    fs.mkdirSync(path.join(dir, 'repo-b'));

    // repo-b DEFINES the shared types.
    fs.writeFileSync(
      path.join(dir, 'repo-b', 'widget.ts'),
      ['export class Widget {', '  render(): string { return "widget"; }', '}', 'export class DbxFolderInfo {', '  name: string = "";', '}'].join('\n'),
    );

    // repo-a: (1) cross-repo IMPORT of Widget, (2) a bare-NAME use of DbxFolderInfo
    // with NO import (cross-repo name match), (3) a same-repo use of Helper.
    fs.writeFileSync(
      path.join(dir, 'repo-a', 'consumer.ts'),
      [
        "import { Widget } from '../repo-b/widget';",
        '',
        'export function makeWidget(): Widget {',
        '  return new Widget();',
        '}',
        '',
        'export function inspect(info: DbxFolderInfo): string {',
        '  return info.name;',
        '}',
        '',
        'export class Helper {',
        '  help(): string { return "h"; }',
        '}',
        'export function useHelper(): string {',
        '  return new Helper().help();',
        '}',
      ].join('\n'),
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    // (a) cross-repo IMPORT edge (makeWidget -> Widget, resolvedBy import): tier high.
    const importEdge = edgeBetween(cg, 'makeWidget', 'Widget');
    expect(importEdge).toBeDefined();
    const importMd = importEdge!.metadata as { tier?: string; edgeTier?: string; resolvedBy?: string; sourceRepo?: string; targetRepo?: string };
    expect(importMd.resolvedBy).toBe('import');
    expect(importMd.tier).toBe('high');
    expect(importMd.sourceRepo).toBe('repo-a');
    expect(importMd.targetRepo).toBe('repo-b');

    // (b) cross-repo bare-NAME edge (inspect -> DbxFolderInfo, resolvedBy exact-match):
    // PRESENT (not dropped) and tier low.
    const crossNameEdge = edgeBetween(cg, 'inspect', 'DbxFolderInfo');
    expect(crossNameEdge).toBeDefined(); // KEPT — cross-repo name match is not dropped
    const crossMd = crossNameEdge!.metadata as { tier?: string; edgeTier?: string; resolvedBy?: string; sourceRepo?: string; targetRepo?: string };
    expect(crossMd.resolvedBy).toBe('exact-match');
    expect(crossMd.tier).toBe('low');
    expect(crossMd.sourceRepo).toBe('repo-a');
    expect(crossMd.targetRepo).toBe('repo-b');

    // (c) same-repo NAME edge (useHelper -> Helper, exact-match, both repo-a): tier medium.
    const sameRepoEdge = edgeBetween(cg, 'useHelper', 'Helper');
    expect(sameRepoEdge).toBeDefined();
    const sameMd = sameRepoEdge!.metadata as { tier?: string; edgeTier?: string; resolvedBy?: string; sourceRepo?: string; targetRepo?: string };
    expect(sameMd.tier).toBe('medium');
    expect(sameMd.sourceRepo).toBe('repo-a');
    expect(sameMd.targetRepo).toBe('repo-a');

    // Both cross-repo edges coexist — tiering annotates, never filters.
    expect(importEdge!.target).not.toBe(crossNameEdge!.target);

    // P2C: the same confidence is also stamped under `edgeTier`, the key that
    // NEVER means anything else. `tier` is overloaded across the graph — on a
    // cross-tier synthesized edge (tier-synthesizer.ts) it is a DIRECTION,
    // `client→server`, which `src/context`, `src/mcp/tools` and the Steps view
    // all read by that name. A consumer filtering the whole edge set by
    // confidence therefore has to read `edgeTier`; `tier` stays untouched so
    // the fork's own readers are unaffected.
    expect(importMd.edgeTier).toBe('high');
    expect(crossMd.edgeTier).toBe('low');
    expect(sameMd.edgeTier).toBe('medium');
  });
});
