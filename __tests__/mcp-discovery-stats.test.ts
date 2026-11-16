import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { ToolHandler, getExploreBudget } from '../src/mcp/tools';

describe('MCP discovery uses only the indexed file count', () => {
  let dir: string;
  let cg: CodeGraph;
  afterEach(() => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([0, 501, 5001, 15001, 25001])('preserves guidance for %i files without aggregating nodes or edges', fileCount => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-discovery-stats-'));
    cg = CodeGraph.initSync(dir);
    const writer = DatabaseConnection.open(getDatabasePath(dir));
    const db = writer.getDb();
    if (fileCount) db.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
      INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at)
      SELECT 'file-' || n || '.ts', 'hash', 'typescript', 1, 1, 1 FROM seq`).run(fileCount);
    writer.close();
    const fullStats = vi.spyOn(cg, 'getStats');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'search,node,explore,callers,callees,impact,files');
    const listed = new ToolHandler(cg).getTools();
    expect(listed).toHaveLength(7);
    expect(listed.find(tool => tool.name === 'codegraph_explore')?.description).toContain(`${fileCount.toLocaleString()} files indexed`);
    expect(listed.find(tool => tool.name === 'codegraph_explore')?.description).toContain(`~${getExploreBudget(fileCount)} focused calls`);
    expect(fullStats).not.toHaveBeenCalled();
  });
  it('reads the live file count after changes and from a frozen reader without caching graph statistics', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-count-'));
    cg = CodeGraph.initSync(dir);
    expect(cg.getFileCount()).toBe(0);
    const writer = DatabaseConnection.open(getDatabasePath(dir));
    try {
      writer.getDb().prepare("INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at) VALUES ('alpha.ts', 'h', 'typescript', 1, 1, 1)").run();
      expect(cg.getFileCount()).toBe(1);
      writer.getDb().prepare("DELETE FROM files WHERE path = 'alpha.ts'").run();
      expect(cg.getFileCount()).toBe(0);
    } finally { writer.close(); }
    cg.close();
    cg = CodeGraph.openSync(dir, { readOnly: true });
    expect(cg.getFileCount()).toBe(0);
  });

});
