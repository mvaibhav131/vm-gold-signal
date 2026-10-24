import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

const RECORD_SEPARATOR = '\u001e';

export interface FakeConnection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly subscribed: string[];
  handshaken: boolean;
}

export interface FakeRestAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A small SignalR server for tests: the negotiate request, the WebSocket upgrade, the JSON hub
 * protocol (handshake, invocations, completions, pings, close) and the Biquote hub `/hubs/tick`
 * with `Subscribe` and `Unsubscribe`, plus the REST route `/api/{symbol}`. It is a real server on
 * a local port, so the real SignalR client talks to it exactly as it talks to Biquote. Test code
 * can push ticks, drop connections, go silent and refuse the negotiate request.
 */
export class FakeSignalRServer {
  /** When each negotiate request, each WebSocket connection and each REST request arrived. */
  readonly negotiates: number[] = [];
  readonly connects: number[] = [];
  readonly restHits: { at: number; symbol: string }[] = [];
  readonly subscribes: { at: number; connectionId: string; symbols: string[] }[] = [];
  readonly unsubscribes: string[][] = [];
  readonly connections = new Set<FakeConnection>();

  /** A status other than null makes the negotiate request fail with it. */
  negotiateStatus: number | null = null;
  /** A successful negotiate request is answered only after this many milliseconds (a slow connect). */
  negotiateDelayMs = 0;
  /** The REST answer per symbol; an unlisted symbol is open and fresh. */
  readonly rest = new Map<string, FakeRestAnswer>();
  /** Called after each `Subscribe`: the place to send the state and the seeded tick. */
  onSubscribe: ((connection: FakeConnection, symbols: string[]) => void) | null = null;
  /** While true the server sends no pings and no ticks, but keeps the sockets open. */
  silent = false;

  private readonly server: Server;
  private readonly sockets: WebSocketServer;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(pingEveryMs: number) {
    this.sockets = new WebSocketServer({ noServer: true });
    this.server = createServer((request, response) => {
      this.handleHttp(request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      if (!(request.url ?? '').startsWith('/hubs/tick')) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        this.accept(ws);
      });
    });
    this.pingTimer = setInterval(() => {
      if (this.silent) return;
      for (const connection of this.connections) {
        if (connection.handshaken) this.write(connection, { type: 6 });
      }
    }, pingEveryMs);
  }

  static async start(options: { pingEveryMs?: number } = {}): Promise<FakeSignalRServer> {
    const fake = new FakeSignalRServer(options.pingEveryMs ?? 40);
    await new Promise<void>((resolve) => {
      fake.server.listen(0, '127.0.0.1', resolve);
    });
    return fake;
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /** Sends `ReceiveTick` to every connection that subscribed to the symbol. */
  sendTick(tick: Record<string, unknown>): void {
    if (this.silent) return;
    for (const connection of this.connections) {
      if (connection.subscribed.includes(String(tick.symbol))) {
        this.invoke(connection, 'ReceiveTick', [tick]);
      }
    }
  }

  /** Sends any client method to every handshaken connection. */
  broadcast(target: string, args: unknown[]): void {
    for (const connection of this.connections) {
      if (connection.handshaken) this.invoke(connection, target, args);
    }
  }

  invoke(connection: FakeConnection, target: string, args: unknown[]): void {
    this.write(connection, { type: 1, target, arguments: args });
  }

  /** Cuts every connection without a word, like a network that went away. */
  dropAll(): void {
    for (const connection of this.connections) connection.socket.terminate();
  }

  /** Tells every client that the server is closing, then closes the sockets. */
  closeAll(): void {
    for (const connection of this.connections) {
      this.write(connection, { type: 7 });
      connection.socket.close();
    }
  }

  async stop(): Promise<void> {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const connection of this.connections) connection.socket.terminate();
    await new Promise<void>((resolve) => {
      this.sockets.close(() => {
        resolve();
      });
    });
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------------------------

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/hubs/tick/negotiate') {
      this.negotiates.push(Date.now());
      if (this.negotiateStatus !== null) {
        response.writeHead(this.negotiateStatus).end();
        return;
      }
      const token = randomUUID();
      const answer = JSON.stringify({
        negotiateVersion: 1,
        connectionId: randomUUID(),
        connectionToken: token,
        availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }],
      });
      const send = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(answer);
      };
      if (this.negotiateDelayMs > 0) setTimeout(send, this.negotiateDelayMs);
      else send();
      return;
    }
    const match = /^\/api\/([A-Z0-9]+)$/.exec(url.pathname);
    if (request.method === 'GET' && match?.[1] !== undefined) {
      const symbol = match[1];
      this.restHits.push({ at: Date.now(), symbol });
      const answer = this.rest.get(symbol) ?? {
        status: 200,
        body: { symbol, marketState: 'open', stale: false, quoteAgeSeconds: 0 },
      };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
      return;
    }
    response.writeHead(404).end();
  }

  private accept(socket: WebSocket): void {
    this.connects.push(Date.now());
    const connection: FakeConnection = {
      id: randomUUID(),
      socket,
      subscribed: [],
      handshaken: false,
    };
    this.connections.add(connection);
    socket.on('close', () => {
      this.connections.delete(connection);
    });
    socket.on('error', () => undefined);
    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
      for (const record of text.split(RECORD_SEPARATOR)) {
        if (record !== '') this.receive(connection, record);
      }
    });
  }

  private receive(connection: FakeConnection, record: string): void {
    const message = JSON.parse(record) as {
      type?: number;
      protocol?: string;
      invocationId?: string;
      target?: string;
      arguments?: unknown[];
    };
    if (!connection.handshaken) {
      connection.handshaken = true;
      connection.socket.send(`{}${RECORD_SEPARATOR}`);
      return;
    }
    if (message.type === 7) {
      connection.socket.close();
      return;
    }
    if (message.type !== 1) return;
    const first = message.arguments?.[0];
    const symbols = Array.isArray(first) ? first.map(String) : [];
    if (message.target === 'Subscribe') {
      this.subscribes.push({ at: Date.now(), connectionId: connection.id, symbols });
      for (const symbol of symbols) {
        if (!connection.subscribed.includes(symbol)) connection.subscribed.push(symbol);
      }
    } else if (message.target === 'Unsubscribe') {
      this.unsubscribes.push(symbols);
      for (const symbol of symbols) {
        const index = connection.subscribed.indexOf(symbol);
        if (index >= 0) connection.subscribed.splice(index, 1);
      }
    }
    if (message.invocationId !== undefined) {
      this.write(connection, { type: 3, invocationId: message.invocationId, result: null });
    }
    if (message.target === 'Subscribe') this.onSubscribe?.(connection, symbols);
  }

  private write(connection: FakeConnection, message: Record<string, unknown>): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(`${JSON.stringify(message)}${RECORD_SEPARATOR}`);
  }
}
