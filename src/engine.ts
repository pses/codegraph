/** Write-only layers, loaded on first use (backport of upstream #3143). */
export { ExtractionOrchestrator, extractFromSource } from './extraction';
export { createResolver } from './resolution';
export { FileWatcher } from './sync/watcher';
