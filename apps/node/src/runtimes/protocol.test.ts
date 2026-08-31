import { describe, expect, it } from 'vitest';
import { BoundedStdioProcess, JsonRpcDemux, readUntilResponse } from './protocol.js';

describe('newline protocol framing', () => {
  it('round-trips bounded JSON-RPC frames without shell execution', async () => {
    const script = "process.stdin.on('data',d=>{const x=JSON.parse(String(d)); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{ok:true}})+'\\n');});";
    const child = new BoundedStdioProcess(process.execPath, ['-e', script], { stdoutLimit: 1024, stderrLimit: 1024 });
    child.send({ jsonrpc: '2.0', id: 7, method: 'fixture' });
    const response = await readUntilResponse(child, 7);
    expect(response.response.result).toEqual({ ok: true });
    await child.close();
  });

  it('preserves unknown notification frames', async () => {
    const script = "process.stdin.on('data',d=>{const x=JSON.parse(String(d)); process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'vendor/new_event',params:{value:1}})+'\\n'+JSON.stringify({jsonrpc:'2.0',id:x.id,result:null})+'\\n');});";
    const child = new BoundedStdioProcess(process.execPath, ['-e', script], { stdoutLimit: 1024, stderrLimit: 1024 });
    child.send({ jsonrpc: '2.0', id: 1, method: 'fixture' });
    const response = await readUntilResponse(child, 1);
    expect(response.notifications[0]?.method).toBe('vendor/new_event');
    await child.close();
  });

  it('interrupts a pending read when its signal aborts', async () => {
    const child = new BoundedStdioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const controller = new AbortController();
    const pending = child.next(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    await child.close();
  });

  it('times out a pending read and leaves no orphaned waiter', async () => {
    const child = new BoundedStdioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    await expect(child.next(undefined, 10)).rejects.toThrow('timed out');
    await child.close();
  });

  it('demultiplexes concurrent out-of-order responses by request id', async () => {
    const script = "process.stdin.on('data',d=>{for(const line of String(d).trim().split('\\n')){const x=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{id:x.id}})+'\\n'),x.id===1?20:0)}});";
    const child = new BoundedStdioProcess(process.execPath, ['-e', script], { stdoutLimit: 1024, stderrLimit: 1024 });
    const demux = new JsonRpcDemux(child);
    const first = demux.request(1, { jsonrpc: '2.0', id: 1, method: 'one' });
    const second = demux.request(2, { jsonrpc: '2.0', id: 2, method: 'two' });
    expect((await second).response.result).toEqual({ id: 2 });
    expect((await first).response.result).toEqual({ id: 1 });
    demux.stop();
    await child.close();
  });

  it('keeps a later cancellation response isolated after an aborted turn request', async () => {
    const script = "process.stdin.on('data',d=>{for(const line of String(d).trim().split('\\n')){const x=JSON.parse(line);if(x.id===1)setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{late:true}})+'\\n'),30);else if(x.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{cancelled:true}})+'\\n')}});";
    const child = new BoundedStdioProcess(process.execPath, ['-e', script], { stdoutLimit: 1024, stderrLimit: 1024 });
    const demux = new JsonRpcDemux(child);
    const controller = new AbortController();
    const turn = demux.request(1, { jsonrpc: '2.0', id: 1, method: 'turn/start' }, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(turn).rejects.toThrow('cancelled');
    const cancel = await demux.request(2, { jsonrpc: '2.0', id: 2, method: 'turn/interrupt' });
    expect(cancel.response.result).toEqual({ cancelled: true });
    demux.stop();
    await child.close();
  });

  it('routes an id-colliding inbound request as a notification, not a response', async () => {
    const script = "process.stdin.on('data',d=>{const x=JSON.parse(String(d));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,method:'server/approval',params:{request:'fixture'}})+'\\n'+JSON.stringify({jsonrpc:'2.0',id:x.id,result:{ok:true}})+'\\n')});";
    const child = new BoundedStdioProcess(process.execPath, ['-e', script], { stdoutLimit: 1024, stderrLimit: 1024 });
    const demux = new JsonRpcDemux(child);
    const notifications: Array<{ id?: number | string | null; method?: string }> = [];
    const result = await demux.request(1, { jsonrpc: '2.0', id: 1, method: 'turn/start' }, undefined, undefined, (frame) => notifications.push({ ...(frame.id === undefined ? {} : { id: frame.id }), ...(frame.method === undefined ? {} : { method: frame.method }) }));
    expect(result.response.result).toEqual({ ok: true });
    expect(notifications).toEqual([{ id: 1, method: 'server/approval' }]);
    demux.stop();
    await child.close();
  });
});
