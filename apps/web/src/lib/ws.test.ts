import { afterEach, expect, it, vi } from 'vitest';
import { AppSocket } from './ws';

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  constructor(readonly url: string) { super(); FakeWebSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWebSocket.instances = []; });

it('ignores late events from a replaced session and clears status on close', () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'dhole.example' });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const socket = new AppSocket();
  const event = vi.fn();
  const status = vi.fn();
  socket.connect('old-session', 7, event, status);
  const old = FakeWebSocket.instances[0]!;
  socket.connect('new-session', 2, event, status);
  const current = FakeWebSocket.instances[1]!;
  old.dispatchEvent(new Event('open'));
  old.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ projectSequence: 100 }) }));
  old.dispatchEvent(new Event('close'));
  current.dispatchEvent(new Event('open'));
  expect(event).not.toHaveBeenCalled();
  expect(old.sent).toEqual([]);
  expect(JSON.parse(current.sent[0]!)).toEqual({ type: 'subscribe', sessionId: 'new-session', afterSequence: 2 });
  vi.advanceTimersByTime(20_000);
  expect(FakeWebSocket.instances).toHaveLength(2);
  socket.close();
  expect(status).toHaveBeenLastCalledWith('offline');
});
