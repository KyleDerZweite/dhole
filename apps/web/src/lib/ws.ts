export type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

type EventHandler = (event: Record<string, unknown>) => void;

/** Small reconnecting app socket. The server remains the sole authority; a reconnect asks for catch-up after the snapshot watermark. */
export class AppSocket {
  #socket: WebSocket | undefined;
  #timer: number | undefined;
  #attempt = 0;
  #closed = false;
  #sessionId = '';
  #after = 0;
  #onEvent: EventHandler = () => undefined;
  #onStatus: (status: SocketStatus) => void = () => undefined;

  connect(sessionId: string, after: number, onEvent: EventHandler, onStatus: (status: SocketStatus) => void): void {
    this.close();
    this.#closed = false;
    this.#sessionId = sessionId;
    this.#after = after;
    this.#onEvent = onEvent;
    this.#onStatus = onStatus;
    this.open();
  }

  updateWatermark(after: number): void { this.#after = Math.max(this.#after, after); }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#attempt = 0;
    this.#sessionId = '';
    this.#after = 0;
    socket?.close();
    this.#onStatus('offline');
  }

  private open(): void {
    if (this.#closed || !this.#sessionId) return;
    this.#onStatus(this.#attempt ? 'reconnecting' : 'connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/app`);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      if (this.#closed || this.#socket !== socket) return;
      this.#attempt = 0;
      this.#onStatus('connected');
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: this.#sessionId, afterSequence: this.#after }));
    });
    socket.addEventListener('message', (message) => {
      if (this.#closed || this.#socket !== socket) return;
      try {
        const value: unknown = JSON.parse(String(message.data));
        if (!value || typeof value !== 'object') return;
        const body = value as Record<string, unknown>;
        const event = body.event && typeof body.event === 'object' ? body.event as Record<string, unknown> : body;
        const sequence = event.projectSequence;
        if (typeof sequence === 'number') this.updateWatermark(sequence);
        this.#onEvent(event);
      } catch { /* malformed frames are ignored; HTTP snapshot remains authoritative */ }
    });
    const retry = (): void => {
      if (this.#closed || this.#socket !== socket) return;
      this.#socket = undefined;
      this.#onStatus('reconnecting');
      this.#attempt += 1;
      this.#timer = window.setTimeout(() => this.open(), Math.min(15_000, 500 * 2 ** Math.min(this.#attempt, 5)));
    };
    socket.addEventListener('close', retry);
    socket.addEventListener('error', () => { if (this.#socket === socket) socket.close(); });
  }
}
