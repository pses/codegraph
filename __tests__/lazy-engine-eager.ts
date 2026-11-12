// Vitest cannot lazy-require TypeScript; built-process tests exercise the real loader.
import * as loaded from '../src/engine';
export function engine(): typeof loaded { return loaded; }
export { FileWatcher } from '../src/sync/watcher';
export { MCPServer } from '../src/mcp';
