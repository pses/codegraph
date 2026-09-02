/**
 * Reference resolution over an already-extracted DB (P2A productionization
 * Task 6.5 — the counterpart to `--extract-only`).
 *
 * `extractOnly` stops indexAll() after the extraction pass: nodes + structural
 * `contains` edges are written and `unresolved_refs` are left pending, with the
 * resolution pass skipped. Our per-project layer extracts each repo separately,
 * merges the node DBs into one working dir, then needs to RESOLVE edges over the
 * merged DB WITHOUT re-extracting.
 *
 * `CodeGraph.resolveExtracted()` (surfaced on the CLI as `codegraph resolve
 * <dir>`) does exactly that: it opens the existing DB, runs
 * `resolveReferencesBatched` plus the same post-resolution passes indexAll runs
 * after resolution, and persists — no extraction.
 *
 * The load-bearing property is EQUIVALENCE: extract-only + resolve must produce
 * the SAME edges a normal (full) init of the same dir produces.
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
 * A small self-contained TypeScript project whose cross-symbol references are
 * CALLS (`main` -> `greet`, `greet` -> `shout`). Call sites are emitted as
 * unresolved_refs at extraction time and only become `calls` edges once the
 * resolution pass runs — cleanly separating the two phases.
 */
function writeFixture(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    `export function shout(s: string): string {
  return s + '!';
}

export function greet(): string {
  return shout('hi');
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

/**
 * A stable, DB-independent signature of every edge: `kind|srcQName|tgtQName`,
 * joined through the nodes table so it does not depend on synthetic node IDs
 * (which vary between two separately-built DBs). Used to assert equivalence.
 */
function edgeSignatures(cg: CodeGraph): string[] {
  const db = (cg as any).db.db;
  return db
    .prepare(
      `SELECT e.kind AS kind, s.qualified_name AS src, t.qualified_name AS tgt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target`
    )
    .all()
    .map((r: any) => `${r.kind}|${r.src}|${r.tgt}`)
    .sort();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-'));
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CODEGRAPH_EXTRACT_ONLY;
});

describe.skipIf(!HAS_SQLITE)('resolve over an already-extracted DB', () => {
  it('extract-only + resolveExtracted drains unresolved_refs and produces `calls` edges', async () => {
    const dir = path.join(tempDir, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    writeFixture(dir);

    // Phase 1: extract only — nodes + `contains`, refs left pending.
    const cg = await CodeGraph.init(dir, {});
    const extract = await cg.indexAll({ extractOnly: true });
    expect(extract.success).toBe(true);
    expect(unresolvedCount(cg)).toBeGreaterThan(0);
    expect(edgeKinds(cg)).toEqual(['contains']);
    cg.close?.();

    // Phase 2: resolve over the existing DB — no re-extraction.
    const cg2 = await CodeGraph.open(dir);
    const result = await cg2.resolveExtracted();
    expect(result.stats.resolved).toBeGreaterThan(0);

    // Resolution ran: refs drained and real `calls` edges now exist.
    expect(unresolvedCount(cg2)).toBe(0);
    expect(edgeKinds(cg2)).toContain('calls');
    cg2.close?.();
  }, 120_000);

  it('equivalence: extract-only + resolve produces the SAME edges as a full init', async () => {
    // A) extract-only, then resolve.
    const dirA = path.join(tempDir, 'proj-a');
    fs.mkdirSync(dirA, { recursive: true });
    writeFixture(dirA);
    const cgA1 = await CodeGraph.init(dirA, {});
    await cgA1.indexAll({ extractOnly: true });
    cgA1.close?.();
    const cgA2 = await CodeGraph.open(dirA);
    await cgA2.resolveExtracted();
    const sigA = edgeSignatures(cgA2);
    const unresolvedA = unresolvedCount(cgA2);
    cgA2.close?.();

    // B) full init (extraction + resolution in one pass).
    const dirB = path.join(tempDir, 'proj-b');
    fs.mkdirSync(dirB, { recursive: true });
    writeFixture(dirB);
    const cgB = await CodeGraph.init(dirB, {});
    await cgB.indexAll();
    const sigB = edgeSignatures(cgB);
    const unresolvedB = unresolvedCount(cgB);
    cgB.close?.();

    // The whole point: extract-only + resolve == init.
    expect(sigA).toEqual(sigB);
    expect(unresolvedA).toEqual(unresolvedB);
    // And it actually resolved something (guard against a trivially-equal empty graph).
    expect(sigA.some((s) => s.startsWith('calls|'))).toBe(true);
  }, 180_000);
});
