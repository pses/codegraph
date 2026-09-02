/**
 * Frozen serve — `MCPEngine` opens the indexed DB as-is and SKIPS the startup
 * catch-up reconcile, so a static, pre-built merged edge DB is never mutated by
 * `serve`.
 *
 * Background: on open, `MCPEngine.catchUpSync()` runs `cg.sync()` to reconcile
 * the graph against the on-disk sources. That is correct for a live working
 * tree, but WRONG for our per-project edge DB — a merged/resolved static
 * artifact whose project dir has no real source files (only best-effort
 * symlinks). The catch-up then treats every indexed file as deleted and PRUNES
 * THE DB TO 0 NODES. `--no-watch` disables only the LIVE watcher, not this
 * startup catch-up, so a separate switch (`--frozen` / `CODEGRAPH_FROZEN=1`,
 * surfaced as the `frozen` engine option) is required.
 *
 * We exercise the engine's real `catchUpSync()` gate (white-box: a genuine
 * `CodeGraph` is injected, because opening a project THROUGH the engine inside
 * vitest trips the lazy `require('../index')` — see the ToolHandler cache notes
 * in explore-session-state.test.ts). We reproduce the sources-gone startup case
 * (index a dir, then delete its sources) and prove:
 *   - frozen: `catchUpSync()` sets no gate and runs no sync — the DB file count
 *     is UNCHANGED (no prune), and
 *   - NOT frozen: the same call reconciles and prunes the DB to 0 (the flag is
 *     load-bearing).
 * The live watcher is off in every arm, so the ONLY variable is the startup
 * catch-up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { MCPEngine } from '../src/mcp/engine';

describe('MCP frozen serve — skip startup catch-up sync', () => {
  let testDir: string;
  let cg: CodeGraph;
  let gateTimeoutPrev: string | undefined;

  beforeEach(async () => {
    // With the catch-up gate time-box disabled, the first tool call waits for
    // the FULL reconcile, so in the non-frozen arm the prune has committed
    // before we read the count. Frozen sets no gate, so this is a no-op there.
    gateTimeoutPrev = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-frozen-serve-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha.ts'),
      'export function alpha() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'beta.ts'),
      'export function beta() { return 2; }\n',
    );

    // Keep this ONE cg instance open across index + sync (grammars are inited by
    // indexAll in this process; a fresh openSync would not have them) — the same
    // lifecycle mcp-catchup-gate.test.ts relies on.
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    // Sanity: both files landed in the index before we simulate the sources
    // vanishing between sessions.
    expect(cg.getStats().fileCount).toBe(2);

    // Simulate the symlink-less edge-DB dir: the DB is populated but the sources
    // it references are gone from disk.
    fs.rmSync(path.join(testDir, 'src'), { recursive: true, force: true });
  });

  afterEach(() => {
    if (gateTimeoutPrev === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = gateTimeoutPrev;
    delete process.env.CODEGRAPH_FROZEN;
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Wire the already-open `cg` in as the engine's default project (bypassing the
   * lazy `require('../index')` that `doInitialize` cannot satisfy under vitest),
   * run the engine's own `catchUpSync()`, then drive one tool call so any gate
   * the engine set is awaited. Returns the DB file count afterward.
   */
  async function runStartupCatchUp(engine: MCPEngine): Promise<number> {
    // White-box: attach the real cg exactly where doInitialize would.
    (engine as unknown as { cg: CodeGraph }).cg = cg;
    engine.getToolHandler().setDefaultCodeGraph(cg);
    // Invoke the private startup catch-up — the code path serve() runs on open.
    (engine as unknown as { catchUpSync(): void }).catchUpSync();
    // First tool call awaits the catch-up gate (if any) before serving.
    await engine.getToolHandler().execute('codegraph_search', { query: 'alpha' });
    return cg.getStats().fileCount;
  }

  it('frozen: serves the DB as-is — sources gone but the index is NOT pruned', async () => {
    const engine = new MCPEngine({ frozen: true, watch: false });
    try {
      const count = await runStartupCatchUp(engine);
      expect(count).toBe(2);
    } finally {
      engine.stop();
    }
  });

  it('NOT frozen: the startup catch-up prunes the index to 0 (flag is load-bearing)', async () => {
    const engine = new MCPEngine({ frozen: false, watch: false });
    try {
      const count = await runStartupCatchUp(engine);
      expect(count).toBe(0);
    } finally {
      engine.stop();
    }
  });

  it('frozen is honored via CODEGRAPH_FROZEN=1 (the --frozen env chokepoint)', async () => {
    process.env.CODEGRAPH_FROZEN = '1';
    // No `frozen` option — the constructor must resolve it from the env, the way
    // `serve --frozen` sets CODEGRAPH_FROZEN before the engine is constructed.
    const engine = new MCPEngine({ watch: false });
    try {
      const count = await runStartupCatchUp(engine);
      expect(count).toBe(2);
    } finally {
      engine.stop();
    }
  });
});
