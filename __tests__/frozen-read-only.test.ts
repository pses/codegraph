import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { spawnSync } from 'child_process';
import * as resolution from '../src/resolution';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-reader-')); dirs.push(dir);
  const writer = await CodeGraph.init(dir);
  writer.close();
  return dir;
}
describe('frozen index readers', () => {
  it('opens without constructing the write resolver and still answers queries', async () => {
    const dir = await fixture();
    const createResolver = vi.spyOn(resolution, 'createResolver');
    const reader = await CodeGraph.open(dir, { readOnly: true });
    try {
      expect(reader.getStats().nodeCount).toBe(0);
      expect(createResolver).not.toHaveBeenCalled();
    } finally { reader.close(); }
  });
  it('cannot write or repair a missing writer index', async () => {
    const dir = await fixture(); const dbPath = path.join(dir, '.codegraph', 'codegraph.db');
    const writer = DatabaseConnection.open(dbPath);
    writer.getDb().exec('DROP INDEX idx_nodes_name'); writer.close();
    const reader = DatabaseConnection.open(dbPath, { readOnly: true });
    try {
      expect(reader.getDb().prepare("SELECT name FROM sqlite_master WHERE name='idx_nodes_name'").get()).toBeUndefined();
      expect(() => reader.getDb().exec("DELETE FROM schema_versions")).toThrow(/readonly|read.only/i);
    } finally { reader.close(); }
  });
  it('rejects incompatible schema rather than migrating from a reader', async () => {
    const dir = await fixture(); const dbPath = path.join(dir, '.codegraph', 'codegraph.db');
    const writer = DatabaseConnection.open(dbPath); writer.getDb().exec(`DELETE FROM schema_versions WHERE version = ${CURRENT_SCHEMA_VERSION}`); writer.close();
    expect(() => DatabaseConnection.open(dbPath, { readOnly: true })).toThrow(/schema.*re.?index/i);
  });
  it('frozen daemon workers never repair the default or cross-project index', async () => {
    const root = await fixture(); const other = await fixture();
    for (const dir of [root, other]) {
      const writer = DatabaseConnection.open(path.join(dir, '.codegraph', 'codegraph.db'));
      writer.getDb().exec('DROP INDEX idx_nodes_name'); writer.close();
    }
    const script = `const {MCPEngine}=require(${JSON.stringify(path.resolve('dist/mcp/engine.js'))});
      (async()=>{const e=new MCPEngine({frozen:true,queryPool:true,watch:false});try{
        await e.ensureInitialized(${JSON.stringify(root)});
        const deadline=Date.now()+10000; while(!e.queryPool?.ready){if(Date.now()>deadline)throw new Error("worker not ready");await new Promise(r=>setTimeout(r,10));}
        const h=e.getToolHandler();
        for(const projectPath of [undefined,${JSON.stringify(other)}]) {
          const r=await h.execute('codegraph_search',{query:'missing',...(projectPath?{projectPath}:{})});
          if(r.isError) throw new Error(JSON.stringify(r));
        }
      }finally{e.stop();}})().catch(e=>{console.error(e);process.exitCode=1});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000, env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_QUERY_POOL_SIZE: '1', CODEGRAPH_MCP_TOOLS: 'search' } });
    expect(child.status, child.stderr).toBe(0);
    for (const dir of [root, other]) {
      const reader = DatabaseConnection.open(path.join(dir, '.codegraph', 'codegraph.db'), { readOnly: true });
      try { expect(reader.getDb().prepare("SELECT name FROM sqlite_master WHERE name='idx_nodes_name'").get()).toBeUndefined(); }
      finally { reader.close(); }
    }
  });
  it('retains eager resolver initialization for writers', async () => {
    const dir = await fixture(); const createResolver = vi.spyOn(resolution, 'createResolver');
    const writer = await CodeGraph.open(dir);
    try { expect(createResolver).toHaveBeenCalledOnce(); } finally { writer.close(); }
  });
});
