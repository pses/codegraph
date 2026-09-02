/**
 * Extract-only indexing (P2A productionization Task 1).
 *
 * `extractOnly` makes indexAll() stop after the extraction pass: nodes and the
 * structural `contains` edges are written, `unresolved_refs` are LEFT pending,
 * and the reference-resolution pass (which turns those refs into `calls` /
 * `references` / `imports` edges) is skipped entirely. This lets a caller
 * extract per-repo node DBs and merge + resolve them together later.
 *
 * The option resolves from BOTH the `--extract-only` CLI flag (via
 * IndexOptions.extractOnly) and the CODEGRAPH_EXTRACT_ONLY=1 env var; default
 * is false, so upstream behavior is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

// node:sqlite (the raw handle used below) needs Node >= 22.5.
const HAS_SQLITE = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

let tempDir: string;

/**
 * One self-contained TypeScript file whose only cross-symbol reference is a
 * CALL: `main` calls `greet`. A call site is emitted as an unresolved_ref at
 * extraction time and only becomes a `calls` edge once the resolution pass
 * runs — so it cleanly separates the two phases. (A bare identifier read of a
 * same-file symbol is resolved eagerly during extraction, so we avoid one
 * here.)
 */
function writeFixture(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    `export function greet(): string {
  return 'hi';
}

export function main(): string {
  return greet();
}
`
  );
}

/** Distinct edge kinds present in the produced DB. */
function edgeKinds(cg: CodeGraph): string[] {
  const db = (cg as any).db.db;
  return db
    .prepare('SELECT DISTINCT kind FROM edges ORDER BY kind')
    .all()
    .map((r: any) => r.kind as string);
}

/** Count of pending unresolved references left in the DB. */
function unresolvedCount(cg: CodeGraph): number {
  const db = (cg as any).db.db;
  return (db.prepare('SELECT count(*) AS c FROM unresolved_refs').get() as { c: number }).c;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-extract-only-'));
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CODEGRAPH_EXTRACT_ONLY;
});

describe.skipIf(!HAS_SQLITE)('extract-only indexing', () => {
  it('via the extractOnly option: leaves unresolved_refs pending and emits only `contains` edges', async () => {
    const dir = path.join(tempDir, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    writeFixture(dir);

    const cg = await CodeGraph.init(dir, {});
    const result = await cg.indexAll({ extractOnly: true });
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBeGreaterThan(0);

    // Resolution was skipped: the references are still pending...
    expect(unresolvedCount(cg)).toBeGreaterThan(0);
    // ...and no resolution-produced edges exist — only structural `contains`.
    const kinds = edgeKinds(cg);
    expect(kinds).not.toContain('calls');
    expect(kinds).not.toContain('references');
    expect(kinds).toEqual(['contains']);

    cg.close?.();
  }, 120_000);

  it('via CODEGRAPH_EXTRACT_ONLY=1: same behavior as the option', async () => {
    const dir = path.join(tempDir, 'proj-env');
    fs.mkdirSync(dir, { recursive: true });
    writeFixture(dir);

    process.env.CODEGRAPH_EXTRACT_ONLY = '1';
    const cg = await CodeGraph.init(dir, {});
    const result = await cg.indexAll();
    expect(result.success).toBe(true);

    expect(unresolvedCount(cg)).toBeGreaterThan(0);
    const kinds = edgeKinds(cg);
    expect(kinds).not.toContain('calls');
    expect(kinds).not.toContain('references');
    expect(kinds).toEqual(['contains']);

    cg.close?.();
  }, 120_000);

  it('default (no extract-only): resolution runs, producing `calls` edges and consuming the refs', async () => {
    const dir = path.join(tempDir, 'proj-full');
    fs.mkdirSync(dir, { recursive: true });
    writeFixture(dir);

    const cg = await CodeGraph.init(dir, {});
    const result = await cg.indexAll();
    expect(result.success).toBe(true);

    const kinds = edgeKinds(cg);
    // The intra-file call resolved into a real `calls` edge...
    expect(kinds).toContain('calls');
    // ...and resolution drained the pending references.
    expect(unresolvedCount(cg)).toBe(0);

    cg.close?.();
  }, 120_000);
});
