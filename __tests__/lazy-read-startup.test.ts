import { afterEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import CodeGraph from '../src/index';
let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
it('a built read-only query does not load extraction or resolution modules', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-read-')); const cg = await CodeGraph.init(dir); cg.close();
  const script = `const CG=require(${JSON.stringify(path.resolve('dist/index.js'))}).default;const cg=CG.openSync(${JSON.stringify(dir)},{readOnly:true});cg.getStats();cg.close();console.log(JSON.stringify(Object.keys(require.cache).filter(p=>/[/\\\\](extraction|resolution)[/\\\\]index\\.js$/.test(p))));`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, CODEGRAPH_TELEMETRY: '0' } });
  expect(child.status, child.stderr).toBe(0); expect(JSON.parse(child.stdout)).toEqual([]);
});
