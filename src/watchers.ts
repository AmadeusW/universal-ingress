import { DurableObject } from "cloudflare:workers";
import { readEventsAfter } from "./events";

const PUSH_BATCH_SIZE = 100;

/** Per-connection state. Survives hibernation via serializeAttachment. */
interface Watcher {
  /** Highest seq already sent on this socket. */
  cursor: number;
}

/**
 * One instance (named "all") holds every connected watcher socket.
 * Events live in D1; this object only says "something new arrived" by pushing it.
 * Each socket has its own cursor, so a watcher that connects with `?after=<seq>`
 * gets the backlog first and then live events, with no gap.
 *
 * Delivery is at-least-once: the watcher keeps its own last_seq and dedupes by seq.
 */
export class Watchers extends DurableObject<Env> {
  // Flushes run one at a time so two quick notifies can't send the same events twice.
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object, so keepalives don't cost anything.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Called from the Worker after the websocket upgrade is authenticated. */
  async fetch(request: Request): Promise<Response> {
    const afterSeq = Number.parseInt(new URL(request.url).searchParams.get("after") ?? "", 10);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cursor: Number.isFinite(afterSeq) && afterSeq >= 0 ? afterSeq : 0 } satisfies Watcher);

    this.enqueueFlush();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** RPC: a new event was stored, push it to everyone. */
  async notify(): Promise<void> {
    this.enqueueFlush();
  }

  // Watchers only listen. Anything they send (other than the auto-answered ping) is ignored.
  webSocketMessage(): void {}

  webSocketClose(ws: WebSocket, code: number): void {
    ws.close(code, "closing");
  }

  webSocketError(ws: WebSocket): void {
    ws.close(1011, "error");
  }

  private enqueueFlush(): void {
    this.flushQueue = this.flushQueue.then(() => this.flushAll()).catch((error) => {
      console.error("watcher flush failed", error);
    });
    // Keep the object alive until the flush finishes, even when called from fetch().
    this.ctx.waitUntil(this.flushQueue);
  }

  private async flushAll(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      await this.flushSocket(socket);
    }
  }

  private async flushSocket(socket: WebSocket): Promise<void> {
    const watcher = socket.deserializeAttachment() as Watcher | null;
    if (!watcher) return;

    let cursor = watcher.cursor;
    while (true) {
      const events = await readEventsAfter(this.env.DB, cursor, PUSH_BATCH_SIZE);
      if (events.length === 0) break;

      try {
        socket.send(JSON.stringify({ events }));
      } catch {
        return; // Socket is gone; its close handler cleans up.
      }
      cursor = events[events.length - 1].seq;
      socket.serializeAttachment({ cursor } satisfies Watcher);

      if (events.length < PUSH_BATCH_SIZE) break;
    }
  }
}
