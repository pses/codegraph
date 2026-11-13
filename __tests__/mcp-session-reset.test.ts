import { describe, expect, it, vi } from 'vitest';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport, MessageHandler } from '../src/mcp/transport';
function fixture(allowSessionReset = true, execute = vi.fn(async () => ({ content: [] }))) {
  let receive!: MessageHandler;
  const transport = { start: (handler: MessageHandler) => { receive = handler; }, stop: vi.fn(), send: vi.fn(), notify: vi.fn(), request: vi.fn(), sendResult: vi.fn(), sendError: vi.fn() } satisfies JsonRpcTransport;
  const engine = { hasDefaultCodeGraph: () => true, getToolHandler: () => ({ execute }) } as unknown as MCPEngine;
  const session = new MCPSession(transport, engine, { allowSessionReset }); session.start();
  const call = (method: string, params?: unknown) => receive({ jsonrpc: '2.0', id: 1, method, params });
  return { session, call, transport };
}
describe('opt-in private session reset', () => {
  it('clears all prior explore state and acknowledges version 1', async () => {
    const f = fixture(); f.session.getExploreSessionState().record({ projectRoot: '/project', query: 'secret-query', files: [], sourceBytes: 0, responseBytes: 12 });
    await f.call('uca/resetSession'); expect(f.session.getExploreSessionState().snapshot()).toEqual([]); expect(f.transport.sendResult).toHaveBeenCalledWith(1, { version: 1 });
  });
  it('resets upstream per-client stale-index warning history for the next lease', async () => {
    const f = fixture();
    const warnings = () => (f.session as unknown as { indexVersionWarnings: { claim(root: string): boolean } }).indexVersionWarnings;
    expect(warnings().claim('/project')).toBe(true); expect(warnings().claim('/project')).toBe(false);
    await f.call('uca/resetSession');
    expect(warnings().claim('/project')).toBe(true);
  });
  it('has no endpoint without the explicit direct frozen opt-in', async () => {
    const f = fixture(false); await f.call('uca/resetSession'); expect(f.transport.sendError).toHaveBeenCalledWith(1, -32601, expect.any(String));
  });
  it('refuses reset while a tool call is in flight', async () => {
    let finish!: (result: { content: never[] }) => void;
    const execute = vi.fn(() => new Promise<{ content: never[] }>(resolve => { finish = resolve; }));
    const f = fixture(true, execute); const running = f.call('tools/call', { name: 'codegraph_search', arguments: { query: 'x' } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled()); await f.call('uca/resetSession'); expect(f.transport.sendError).toHaveBeenCalledWith(1, -32600, expect.stringMatching(/in.flight/i));
    finish({ content: [] }); await running; f.transport.sendError.mockClear(); await f.call('uca/resetSession'); expect(f.transport.sendError).not.toHaveBeenCalled();
  });
});
