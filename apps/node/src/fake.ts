import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { NodeClient, type NodeClientOptions } from './client.js';
import { loadNodeConfig, type NodeConfig } from './config.js';

/** Tiny in-memory WebSocket pair used by tests and fixture demos. */
export class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeSocket.OPEN;
  peer?: FakeSocket;

  send(data: string | Buffer): void {
    if (this.readyState !== FakeSocket.OPEN || !this.peer || this.peer.readyState !== FakeSocket.OPEN) return;
    const value = Buffer.isBuffer(data) ? Buffer.from(data) : data;
    queueMicrotask(() => this.peer?.emit('message', value));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
    const peer = this.peer;
    if (peer && peer.readyState !== FakeSocket.CLOSED) {
      peer.readyState = FakeSocket.CLOSED;
      peer.emit('close', code, Buffer.from(reason));
    }
  }

  ping(): void { /* no-op for heartbeat tests */ }
}

export function createFakeSocketPair(): { client: WebSocket; server: WebSocket } {
  const client = new FakeSocket();
  const server = new FakeSocket();
  client.peer = server;
  server.peer = client;
  return { client: client as unknown as WebSocket, server: server as unknown as WebSocket };
}

export interface FakeNodeOptions extends Omit<NodeClientOptions, 'socketFactory' | 'config'> {
  config?: NodeConfig;
}

/** NodeClient wired through the exact same protocol over an in-memory socket. */
export class FakeNode {
  readonly client: NodeClient;
  #serverSocket?: WebSocket;

  get serverSocket(): WebSocket | undefined { return this.#serverSocket; }

  constructor(options: FakeNodeOptions = {}) {
    const config = options.config ?? loadNodeConfig({
      DHOLE_NODE_MACHINE_ID: 'fake-machine',
      DHOLE_NODE_CREDENTIAL: 'fake-credential',
    });
    this.client = new NodeClient({
      ...options,
      config,
      socketFactory: () => {
        const pair = createFakeSocketPair();
        this.#serverSocket = pair.server;
        queueMicrotask(() => pair.client.emit('open'));
        return pair.client;
      },
    });
  }

  start(): void { this.client.start(); }
  stop(): void { this.client.stop(); }
}

export const createFakeNode = (options: FakeNodeOptions = {}): FakeNode => new FakeNode(options);
