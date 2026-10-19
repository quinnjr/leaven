/**
 * @leaven-graphql/nestjs - Subscriptions Support
 *
 * Provides graphql-ws protocol handling over WebSocket for NestJS.
 *
 * Single-result operations (queries and mutations) are answered with one
 * `next` message followed by `complete`, or with a single `error` message
 * when they fail before execution (parse, validation, complexity or depth).
 * Streaming `subscription` operations are executed through the Leaven
 * executor and each event is forwarded as a `next` message until the stream
 * ends, the client sends `complete`, or the connection closes. Topic-keyed
 * delivery driven by an external pub/sub engine is available via
 * `SubscriptionManager.registerSubscription` and
 * `SubscriptionManager.publishToTopic`.
 *
 * TRANSPORT: this module speaks the protocol, it does NOT own a server. Two
 * equivalent entry points are provided, one per socket shape:
 *
 * - A DOM-shaped `WebSocket` (`addEventListener`) — hand it to
 *   `SubscriptionManager.handleConnection` and the manager wires its own
 *   listeners.
 * - A Bun `ServerWebSocket` (no `addEventListener`; the server invokes
 *   `open`/`message`/`close` handlers) — use `handleOpen`, `handleMessage`
 *   and `handleClose`, or pass `getWebSocketConfig()` straight into
 *   `Bun.serve({ websocket })`.
 *
 * Nothing here calls `server.upgrade()`: the HTTP route that upgrades a
 * request to a WebSocket belongs to whoever owns the server.
 * `SubscriptionManager.getPath()` exposes the configured
 * `subscriptions.path` so that route can be registered in the right place.
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  Injectable,
  Inject,
  SetMetadata,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  parse,
  getOperationAST,
  type DocumentNode,
  type GraphQLFormattedError,
} from 'graphql';
import type { ServerWebSocket } from 'bun';
import { escapeLog } from '@leaven-graphql/core';
import { isValidOperationId } from '@leaven-graphql/ws';
import { LeavenDriver, type HandlerResult } from './driver';
import { wrapWithFilter, SUBSCRIPTION_FILTER_KEY } from './decorators';
import { TopicIndex } from './topic-index';
import { readHeader } from './request-body';
import {
  LEAVEN_MODULE_OPTIONS,
  LEAVEN_DRIVER,
  LEAVEN_PUBSUB,
  type LeavenModuleOptions,
  type GqlContext,
} from './types';

/**
 * `readyState` value meaning OPEN.
 *
 * Deliberately a literal rather than `WebSocket.OPEN`: the manager also
 * drives Bun `ServerWebSocket`s, whose constructor exposes no such static,
 * and referencing the DOM global would make sending depend on a class the
 * server-side socket has nothing to do with. Both shapes use the same
 * numbering (`0` CONNECTING, `1` OPEN, `2` CLOSING, `3` CLOSED).
 */
const SOCKET_OPEN = 1;

/**
 * How long teardown waits for a subscription iterator's `return()` to settle
 * before abandoning it.
 *
 * Cancelling an async generator is NOT guaranteed to complete. `return()` on
 * a generator suspended at an `await` is queued until that await settles, so
 * a resolver parked on an event that never arrives — the normal state of a
 * pub/sub-backed subscription between events — can never be resumed by
 * cancellation alone. Awaiting such a `return()` unconditionally would hang
 * whoever asked for the teardown: a client `complete` frame, a disconnect,
 * and above all `onModuleDestroy`, which would block application shutdown
 * forever.
 *
 * So teardown is *initiated* unconditionally (well-behaved iterators still
 * run their cleanup and are still awaited to completion) but is only
 * *awaited* up to this deadline, after which the iterator is abandoned with
 * a loud log rather than taking the process down with it.
 */
const ITERATOR_TEARDOWN_TIMEOUT_MS = 1000;

/**
 * The minimal socket surface this manager depends on.
 *
 * Deliberately structural rather than `WebSocket` or `ServerWebSocket`: both
 * satisfy it, so protocol handling has ONE implementation regardless of which
 * transport delivered the frame. The DOM-only `addEventListener` is
 * conspicuously absent — it is used exactly once, in
 * {@link SubscriptionManager.handleConnection}, which is the only entry point
 * that requires a DOM socket.
 */
export interface SubscriptionSocket {
  /** `1` while the socket may be written to. */
  readonly readyState: number;
  /** Bun returns a byte count here, the DOM returns `void`; neither is used. */
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/**
 * An upgrade request reduced to the headers
 * {@link SubscriptionManager.isOriginAllowed} reads: a Fetch `Headers` or a
 * Node-style header map.
 */
export interface UpgradeRequestLike {
  readonly headers:
    | { get(name: string): string | null }
    | Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * Normalise an origin for comparison: its scheme and host, lowercased and
 * without the scheme's default port. A value that does not parse as a URL
 * (the opaque origin `null`, say) is just trimmed and lowercased.
 *
 * Twin of `normalizeOrigin` in `packages/ws/src/handler.ts`.
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    // `URL.origin` is `null` for non-special schemes; fall back to the parts.
    return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
  } catch {
    return origin.trim().toLowerCase();
  }
}

/** The `host[:port]` of a URL, or `undefined` when it does not parse. */
function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Bun WebSocket handlers, shaped for `Bun.serve({ websocket })`.
 *
 * @see SubscriptionManager.getWebSocketConfig
 */
export interface BunWebSocketConfig<TData = unknown> {
  open: (socket: ServerWebSocket<TData>) => void;
  message: (socket: ServerWebSocket<TData>, message: string | Buffer) => void;
  close: (socket: ServerWebSocket<TData>) => void;
}

/**
 * Subscription configuration
 */
export interface SubscriptionConfig {
  /**
   * WebSocket path for subscriptions.
   *
   * The manager does not own an HTTP server and therefore cannot bind this
   * itself; it is surfaced by {@link SubscriptionManager.getPath} so the code
   * that does own the server can register the upgrade route there.
   *
   * @default '/graphql'
   */
  path?: string;

  /**
   * Keep-alive interval in milliseconds
   * @default 12000
   */
  keepAlive?: number;

  /**
   * Connection initialization timeout in milliseconds
   * @default 3000
   */
  connectionInitWaitTimeout?: number;

  /**
   * Maximum number of subscriptions per connection
   * @default 100
   */
  maxSubscriptionsPerConnection?: number;

  /**
   * Cross-origin browser origins allowed to open a socket, closing
   * cross-site WebSocket hijacking (a browser attaches the user's cookies to
   * a cross-site upgrade, and WebSockets are exempt from CORS).
   *
   * By default only the server's own origin is allowed: the `Origin` header's
   * host and port must equal the upgrade request's `Host`. Each entry here
   * (`'https://app.example.com'`, say) is allowed in addition; `'*'` allows
   * every origin. Origins compare case-insensitively with default ports
   * normalised. A request with no `Origin` header (a non-browser client) is
   * always allowed.
   *
   * Checked by {@link SubscriptionManager.isOriginAllowed}, which the upgrade
   * route should call, and enforced again when a socket is opened with its
   * upgrade request (closed with `4403 Forbidden`).
   *
   * @default only the server's own origin
   */
  allowedOrigins?: readonly string[] | '*';

  /**
   * Context factory for subscription connections
   */
  context?: (ctx: SubscriptionContext) => GqlContext | Promise<GqlContext>;

  /**
   * Connection callback - called when a client connects
   */
  onConnect?: (ctx: SubscriptionContext) => boolean | Promise<boolean>;

  /**
   * Disconnect callback - called when a client disconnects
   */
  onDisconnect?: (ctx: SubscriptionContext) => void | Promise<void>;

  /**
   * Subscribe callback - called when a subscription starts
   */
  onSubscribe?: (ctx: SubscriptionContext, message: SubscribeMessage) => void | Promise<void>;

  /**
   * Operation callback - called before each operation is executed.
   * May return modified execution args (e.g. to swap the context value).
   */
  onOperation?: (
    ctx: SubscriptionContext,
    message: SubscribeMessage,
    args: ExecutionArgs
  ) => ExecutionArgs | Promise<ExecutionArgs>;

  /**
   * Complete callback - called when a subscription completes
   */
  onComplete?: (ctx: SubscriptionContext, message: CompleteMessage) => void | Promise<void>;
}

/**
 * Subscription context
 */
export interface SubscriptionContext {
  /**
   * The WebSocket connection.
   *
   * Typed as the transport-neutral {@link SubscriptionSocket} because the
   * connection may be either a DOM `WebSocket` or a Bun `ServerWebSocket`;
   * narrow with an instance/duck check before touching members outside that
   * surface.
   */
  socket: SubscriptionSocket;

  /**
   * Connection parameters from client
   */
  connectionParams: Record<string, unknown> | undefined;

  /**
   * Extra data attached to the connection
   */
  extra?: Record<string, unknown>;

  /**
   * Request object (if available)
   */
  request: Request | undefined;
}

/**
 * Subscribe message
 */
export interface SubscribeMessage {
  id: string;
  type: 'subscribe';
  payload: {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
    extensions?: Record<string, unknown>;
  };
}

/**
 * Complete message
 */
export interface CompleteMessage {
  id: string;
  type: 'complete';
}

/**
 * Execution args for GraphQL
 */
export interface ExecutionArgs {
  schema: unknown;
  document: unknown;
  rootValue?: unknown;
  contextValue?: unknown;
  variableValues?: Record<string, unknown>;
  operationName?: string;
}

/**
 * Subscription manager
 *
 * Manages WebSocket connections speaking the graphql-ws protocol.
 *
 * Single-result operations (queries and mutations) receive one `next`
 * message followed by `complete`, or one `error` message when they fail
 * before execution. While in flight they are tracked under their operation
 * id like streams, so a reused id closes with 4409 and they count against
 * `maxSubscriptionsPerConnection`. Streaming `subscription` operations are
 * executed through the driver and each event is forwarded as a `next`
 * message; the stream is cancelled when the client sends `complete` or the
 * connection closes. Server-side, topic-keyed delivery driven by an external
 * pub/sub engine is available via {@link registerSubscription} and
 * {@link publishToTopic}.
 *
 * Configuration is read from `LeavenModuleOptions.subscriptions` and merged
 * over built-in defaults.
 *
 * The manager is transport-agnostic and does NOT bind a server. Feed it a
 * DOM `WebSocket` via {@link handleConnection}, or a Bun `ServerWebSocket`
 * via {@link handleOpen}/{@link handleMessage}/{@link handleClose} —
 * {@link getWebSocketConfig} packages the latter trio for
 * `Bun.serve({ websocket })`. The upgrade route itself is the caller's
 * responsibility; {@link getPath} reports where it should live.
 */
@Injectable()
export class SubscriptionManager implements OnModuleInit, OnModuleDestroy {
  private connections = new Map<SubscriptionSocket, ConnectionState>();
  /**
   * Topic -> subscriptions registered for it via {@link registerSubscription},
   * so {@link publishToTopic} touches only the subscribers of that topic
   * instead of scanning every connection. Every removal from
   * `ConnectionState.subscriptions` goes through {@link removeSubscription},
   * which keeps it in sync.
   */
  private readonly topicIndex = new TopicIndex<TopicSubscriber>();
  private config: SubscriptionConfig;
  /** The listed `allowedOrigins`, normalised once (empty when unset or `'*'`). */
  private readonly listedOrigins: ReadonlySet<string>;

  constructor(
    @Inject(LEAVEN_MODULE_OPTIONS) private readonly options: LeavenModuleOptions,
    @Inject(LEAVEN_DRIVER) private readonly driver: LeavenDriver
  ) {
    this.config = this.normalizeConfig();
    const allowedOrigins = this.config.allowedOrigins;
    this.listedOrigins = new Set(
      Array.isArray(allowedOrigins) ? allowedOrigins.map(normalizeOrigin) : []
    );
  }

  /**
   * Initialize subscription manager
   */
  public async onModuleInit(): Promise<void> {
    // Initialization logic
  }

  /**
   * Tear every connection down, then close it.
   *
   * Teardown is driven EXPLICITLY here rather than being left to the sockets'
   * own `close` events. A real close is asynchronous: the listener installed
   * by {@link handleConnection} — or Bun's `close` handler — runs a tick or
   * more after `socket.close()` returns, which is long after this method has
   * finished. Relying on it meant `handleClose` found no entry in the map and
   * bailed on its first line, so on every shutdown the keep-alive interval
   * and the `connection_init` timeout were never cleared and no subscription
   * iterator was released: every in-flight resolver generator stayed
   * suspended holding whatever it held. The late close event still fires and
   * is still a no-op — but now because the work is already done.
   */
  public async onModuleDestroy(): Promise<void> {
    const sockets = [...this.connections.keys()];

    // Await teardown before closing: `handleClose` clears this connection's
    // timers and cancels each iterator, waiting for cleanup up to
    // ITERATOR_TEARDOWN_TIMEOUT_MS so a resolver that cancellation cannot
    // resume caps shutdown instead of blocking it forever.
    await Promise.all(sockets.map((socket) => this.handleClose(socket)));

    for (const socket of sockets) {
      socket.close(1000, 'Server shutdown');
    }

    // `handleClose` empties the map entry by entry; this only catches sockets
    // registered concurrently with the teardown above.
    this.connections.clear();
    this.topicIndex.clear();
  }

  /**
   * Normalize subscription configuration.
   *
   * Merges the user-supplied `LeavenModuleOptions.subscriptions` config
   * (including the `context`, `onConnect`, `onDisconnect`, `onSubscribe`,
   * `onOperation` and `onComplete` hooks) over built-in defaults.
   */
  private normalizeConfig(): SubscriptionConfig {
    const userConfig = this.options.subscriptions ?? {};

    return {
      ...userConfig,
      path: userConfig.path ?? this.options.path ?? '/graphql',
      keepAlive: userConfig.keepAlive ?? 12000,
      connectionInitWaitTimeout: userConfig.connectionInitWaitTimeout ?? 3000,
      maxSubscriptionsPerConnection: userConfig.maxSubscriptionsPerConnection ?? 100,
    };
  }

  /**
   * The GraphQL-over-WebSocket path this manager is configured for.
   *
   * The manager owns no HTTP server, so it CANNOT bind this itself. Whoever
   * owns the server is responsible for upgrading requests at this path and
   * routing the resulting socket into {@link handleOpen} /
   * {@link handleMessage} / {@link handleClose} — see
   * {@link getWebSocketConfig} for the Bun form. Without that step the
   * configured `subscriptions.path` is inert and no client can ever connect.
   *
   * @returns The configured `subscriptions.path`, falling back to the
   *   module's `path`, then `/graphql`
   */
  public getPath(): string {
    return this.config.path ?? '/graphql';
  }

  /**
   * Whether a WebSocket upgrade request's `Origin` may open a socket, per
   * `subscriptions.allowedOrigins`.
   *
   * Call it in the upgrade route before `server.upgrade()` and answer `403`
   * when it returns `false`. A browser sends the user's cookies with a
   * cross-site upgrade and WebSockets are not covered by CORS, so without
   * this check any site could open an authenticated socket.
   *
   * Allowed: a request with no `Origin` header (a non-browser client); an
   * `Origin` whose host and port equal the request's `Host` (falling back to
   * the host of `request.url`); an `Origin` listed in `allowedOrigins`; any
   * `Origin` when `allowedOrigins` is `'*'`. Comparison is case-insensitive
   * and normalises default ports (`https://a.test:443` is `https://a.test`).
   *
   * Twin of `WebSocketHandler.isOriginAllowed` in
   * `packages/ws/src/handler.ts`: the semantics must stay in step.
   *
   * @param request - The upgrade request, or anything exposing its headers as
   *   a Fetch `Headers` or a Node-style header map
   * @returns `true` when the socket may be opened
   *
   * @example
   * ```typescript
   * if (!manager.isOriginAllowed(request)) {
   *   return new Response('Forbidden', { status: 403 });
   * }
   * ```
   */
  public isOriginAllowed(request: Request | UpgradeRequestLike): boolean {
    const origin = readHeader(request.headers, 'origin');
    const allowed = this.config.allowedOrigins;
    if (origin === undefined || allowed === '*') {
      return true;
    }

    const listed = this.listedOrigins;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      // An opaque or malformed origin (e.g. `null`) can only be listed.
      return listed.has(normalizeOrigin(origin));
    }
    if (listed.has(normalizeOrigin(origin))) {
      return true;
    }

    const host =
      readHeader(request.headers, 'host') ??
      ('url' in request && typeof request.url === 'string' ? safeHost(request.url) : undefined);
    if (host === undefined || host === '') {
      return false;
    }
    // Resolve Host against the origin's scheme so the URL parser lowercases
    // it and drops that scheme's default port (`example.com:443` under https).
    let serverHost: string;
    try {
      serverHost = new URL(`${parsed.protocol}//${host}`).host;
    } catch {
      return false;
    }
    return parsed.host === serverHost;
  }

  /**
   * Bun WebSocket handlers for `Bun.serve({ websocket })`.
   *
   * Mirrors `@leaven-graphql/ws`'s `WebSocketHandler.getWebSocketConfig` so
   * both packages plug into a Bun server the same way.
   *
   * The returned handlers cover the socket lifecycle ONLY. The upgrade itself
   * is not — and cannot be — done here: `server.upgrade(request)` needs the
   * `Server` instance, which this manager never sees. Route it yourself at
   * {@link getPath}. These handlers never see the upgrade request, so the
   * route must check {@link isOriginAllowed} itself.
   *
   * @example
   * ```typescript
   * const manager = app.get(SubscriptionManager);
   *
   * Bun.serve({
   *   fetch(request, server) {
   *     if (new URL(request.url).pathname === manager.getPath()) {
   *       // Refuse cross-site WebSocket hijacking before upgrading.
   *       if (!manager.isOriginAllowed(request)) {
   *         return new Response('Forbidden', { status: 403 });
   *       }
   *       // The manager does NOT call this for you.
   *       if (server.upgrade(request)) return undefined;
   *     }
   *     return new Response('Not found', { status: 404 });
   *   },
   *   websocket: manager.getWebSocketConfig(),
   * });
   * ```
   */
  public getWebSocketConfig<TData = unknown>(): BunWebSocketConfig<TData> {
    return {
      open: (socket: ServerWebSocket<TData>): void => {
        this.handleOpen(socket);
      },
      message: (socket: ServerWebSocket<TData>, message: string | Buffer): void => {
        // Detached deliberately: Bun ignores the returned promise, so an
        // uncaught rejection here would surface as an unhandled rejection
        // rather than as a protocol error on the offending connection.
        void this.handleMessage(socket, message).catch((error: unknown) =>
          console.error('WebSocket message handling failed:', error)
        );
      },
      close: (socket: ServerWebSocket<TData>): void => {
        void this.handleClose(socket).catch((error: unknown) =>
          console.error('WebSocket close handling failed:', error)
        );
      },
    };
  }

  /**
   * Register a Bun `ServerWebSocket` (or any {@link SubscriptionSocket}) that
   * the server has just opened.
   *
   * The Bun counterpart of {@link handleConnection}: a `ServerWebSocket` has
   * no `addEventListener`, so the server delivers frames by calling
   * {@link handleMessage} and {@link handleClose} instead of the manager
   * subscribing to events. Connections are keyed by socket identity, so
   * nothing is written to `socket.data` and any per-connection data the
   * caller keeps there is left untouched.
   *
   * @param socket - The freshly opened socket
   * @param request - The upgrade request, exposed to the `context` and
   *   `onConnect` hooks. When given, its `Origin` is checked with
   *   {@link isOriginAllowed} and a disallowed socket is closed with
   *   `4403 Forbidden`
   */
  public handleOpen(socket: SubscriptionSocket, request?: Request): void {
    this.openConnection(socket, request);
  }

  /**
   * Handle a new DOM-shaped `WebSocket` connection.
   *
   * Use this when the socket dispatches events (`addEventListener`) — the
   * manager wires `message`/`close`/`error` itself. Bun's server-side socket
   * does NOT: use {@link handleOpen} and friends for that shape.
   *
   * When `request` is given, its `Origin` is checked with
   * {@link isOriginAllowed}; a disallowed socket is closed with
   * `4403 Forbidden` and no listeners are attached.
   */
  public async handleConnection(socket: WebSocket, request?: Request): Promise<void> {
    if (!this.openConnection(socket, request)) {
      return;
    }

    socket.addEventListener('message', (event) => {
      void this.handleMessage(socket, event.data as string).catch((error: unknown) =>
        console.error('WebSocket message handling failed:', error)
      );
    });

    socket.addEventListener('close', () => {
      void this.handleClose(socket).catch((e) =>
        console.error('WebSocket close handling failed:', e)
      );
    });

    socket.addEventListener('error', (error) => {
      this.handleError(socket, error);
    });
  }

  /**
   * Register a connection and arm its `connection_init` deadline.
   *
   * Shared by both transports so protocol state is created identically no
   * matter which entry point the socket arrived through; only the event
   * wiring differs.
   */
  private openConnection(
    socket: SubscriptionSocket,
    request?: Request
  ): ConnectionState | undefined {
    // Enforced here as well as in the upgrade route, so a caller that skipped
    // `isOriginAllowed` there is still protected. The socket is never
    // registered, so its frames and close are ignored.
    if (request !== undefined && !this.isOriginAllowed(request)) {
      socket.close(4403, 'Forbidden');
      return undefined;
    }

    const state: ConnectionState = {
      socket,
      request: request,
      subscriptions: new Map(),
      initialized: false,
      initializing: false,
      connectionParams: undefined,
      context: undefined,
      keepAliveInterval: undefined,
      initTimeout: undefined,
    };

    this.connections.set(socket, state);

    // Set connection init timeout. The handle is kept on the connection state
    // so a successful `connection_init` — or a close — can clear it; an
    // uncleared timer keeps the event loop (and the socket reference) alive
    // for its full duration after the connection is already resolved.
    state.initTimeout = setTimeout(() => {
      state.initTimeout = undefined;
      if (!state.initialized) {
        socket.close(4408, 'Connection initialization timeout');
      }
    }, this.config.connectionInitWaitTimeout);

    return state;
  }

  /**
   * Handle an incoming WebSocket frame.
   *
   * Public so a Bun server can deliver frames directly (a `ServerWebSocket`
   * has no events to listen to); {@link handleConnection} routes DOM `message`
   * events here too, so both transports share this one implementation.
   *
   * Per the graphql-ws protocol, an unparseable message or an unrecognized
   * message type closes the connection with 4400 (Bad Request). Errors thrown
   * while handling a `subscribe`/`complete` message are contained to that
   * operation id (a graphql-ws `error` message) so a single failing operation
   * does not tear down the whole connection.
   *
   * @param socket - A socket previously passed to {@link handleOpen} or
   *   {@link handleConnection}; frames for an unknown socket are ignored
   * @param data - The frame payload. Binary frames are decoded as UTF-8:
   *   graphql-ws is a JSON sub-protocol, and Bun hands binary frames over as
   *   a `Buffer`
   */
  public async handleMessage(
    socket: SubscriptionSocket,
    data: string | Uint8Array | ArrayBuffer
  ): Promise<void> {
    const state = this.connections.get(socket);
    if (!state) return;

    let message: GraphQLWSMessage;
    try {
      const parsed: unknown = JSON.parse(
        typeof data === 'string' ? data : new TextDecoder().decode(data)
      );
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        socket.close(4400, 'Bad Request');
        return;
      }
      const { type, id } = parsed as { type: string; id?: unknown };
      // Operation ids are client-chosen and end up in close reasons and log
      // lines; reject anything outside the shared allow-list up front.
      if ((type === 'subscribe' || type === 'complete') && !isValidOperationId(id)) {
        socket.close(4400, 'Invalid message');
        return;
      }
      message = parsed as GraphQLWSMessage;
    } catch (error) {
      // Diagnostics only — the protocol-visible response is the 4400 close.
      console.error('Error parsing WebSocket message:', error);
      socket.close(4400, 'Bad Request');
      return;
    }

    try {
      switch (message.type) {
        case 'connection_init':
          await this.handleConnectionInit(socket, state, message);
          break;
        case 'ping':
          this.send(socket, { type: 'pong' });
          break;
        case 'pong':
          // Client responded to keep-alive
          break;
        case 'subscribe':
          await this.handleSubscribe(socket, state, message as SubscribeMessage);
          break;
        case 'complete':
          await this.handleComplete(socket, state, message as CompleteMessage);
          break;
        default:
          // Unknown message type: protocol violation
          socket.close(4400, 'Bad Request');
          break;
      }
    } catch (error) {
      // Diagnostics only — the client is answered below.
      console.error('Error handling WebSocket message:', error);

      const type = (message as { type?: unknown }).type;
      const id = (message as { id?: unknown }).id;
      if ((type === 'subscribe' || type === 'complete') && typeof id === 'string') {
        // Contain per-operation failures to their operation id.
        this.sendError(socket, id, 'Internal server error');
      } else {
        // A throw from a recognized message type (notably `connection_init`,
        // which awaits the user's `onConnect`) is a SERVER failure, not a
        // protocol violation. 4400 is treated as non-retryable by conforming
        // graphql-ws clients, so a transient auth-service outage would
        // permanently disconnect every client; 1011 is retryable. Genuine
        // protocol violations still close 4400 above, inside the switch.
        socket.close(1011, 'Internal server error');
      }
    }
  }

  /**
   * Handle connection initialization
   */
  private async handleConnectionInit(
    socket: SubscriptionSocket,
    state: ConnectionState,
    message: { type: 'connection_init'; payload?: Record<string, unknown> }
  ): Promise<void> {
    // `initializing` is set synchronously, before the onConnect await:
    // checking `initialized` alone lets a second init that arrives while the
    // first is still in onConnect through, running onConnect again and
    // starting a second keep-alive timer.
    if (state.initialized || state.initializing) {
      socket.close(4429, 'Too many initialization requests');
      return;
    }
    state.initializing = true;

    state.connectionParams = message.payload ?? {};

    const ctx: SubscriptionContext = {
      socket,
      connectionParams: message.payload ?? {},
      request: state.request,
    };

    // Call onConnect callback if provided
    if (this.config.onConnect) {
      const allowed = await this.config.onConnect(ctx);
      // The socket may have closed (and been torn down) while onConnect ran;
      // acknowledging it now would start a keep-alive timer nothing clears.
      if (this.connections.get(socket) !== state) {
        return;
      }
      // graphql-ws: a rejected `connection_init` is 4403 Forbidden. 4401
      // Unauthorized is reserved for a `subscribe` before `connection_ack`.
      if (!allowed) {
        socket.close(4403, 'Forbidden');
        return;
      }
    }

    state.initialized = true;
    state.context = ctx;

    // The deadline has been met: stop the timer rather than letting it fire
    // (harmlessly) against an already-initialized connection.
    if (state.initTimeout) {
      clearTimeout(state.initTimeout);
      state.initTimeout = undefined;
    }

    this.send(socket, { type: 'connection_ack' });

    // Start keep-alive. Only one timer may ever exist per connection.
    if (this.config.keepAlive) {
      if (state.keepAliveInterval) {
        clearInterval(state.keepAliveInterval);
      }
      state.keepAliveInterval = setInterval(() => {
        this.send(socket, { type: 'ping' });
      }, this.config.keepAlive);
    }
  }

  /**
   * Handle subscribe message.
   *
   * Single-result operations (queries and mutations) are answered with a
   * `next` message followed by `complete`, or with one `error` message when
   * they fail before execution. Every operation claims its id while in
   * flight. Streaming `subscription` operations are handed to
   * {@link startStream}, which forwards each event as it arrives.
   */
  private async handleSubscribe(
    socket: SubscriptionSocket,
    state: ConnectionState,
    message: SubscribeMessage
  ): Promise<void> {
    if (!state.initialized) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    // Validate the message shape (graphql-ws requires id + payload.query)
    if (typeof message.id !== 'string' || typeof message.payload?.query !== 'string') {
      socket.close(4400, 'Bad Request');
      return;
    }

    // Operation ids are only unique per connection; reusing an active one is
    // a protocol violation.
    if (state.subscriptions.has(message.id)) {
      socket.close(4409, `Subscriber already exists: ${message.id}`);
      return;
    }

    // Check subscription limit
    if (state.subscriptions.size >= (this.config.maxSubscriptionsPerConnection ?? 100)) {
      this.sendError(socket, message.id, 'Too many subscriptions');
      return;
    }

    // Claim the operation id synchronously for EVERY operation, before any
    // await: a `complete` or close arriving during setup must be able to
    // cancel it, a second `subscribe` reusing the id must lose (4409), and an
    // in-flight query or mutation counts against
    // maxSubscriptionsPerConnection exactly like a stream.
    const registration: SubscriptionState = { clientId: message.id };
    state.subscriptions.set(message.id, registration);
    const owns = (): boolean => state.subscriptions.get(message.id) === registration;
    const release = (): void => {
      // Identity, not presence: a later subscribe may own the id now.
      if (owns()) {
        this.removeSubscription(state, message.id);
      }
    };

    // Execute the operation; failures are contained to this operation id.
    try {
      const streaming = await this.isSubscriptionOperation(
        message.payload.query,
        message.payload.operationName
      );

      // Call onSubscribe callback
      if (this.config.onSubscribe && state.context) {
        await this.config.onSubscribe(state.context, message);
      }

      const schema = this.driver.getSchema();
      if (!schema) {
        // Release the id claimed above before answering. Returning without
        // releasing leaves a phantom entry that makes any retry with the same
        // id (clients reuse "1", "2", …) close the whole connection with 4409
        // and counts against maxSubscriptionsPerConnection forever.
        const owned = owns();
        release();
        if (!owned) {
          return;
        }
        this.sendError(socket, message.id, 'Schema not available');
        return;
      }

      // Build the execution context. SECURITY: connection parameters are
      // client-controlled input — they are exposed only under the namespaced
      // `connectionParams` key and are NEVER spread into the context, so a
      // client cannot forge trusted fields such as `user` or overwrite
      // `req`/`res`. Trusted values must be derived by the configured
      // `context`/`onConnect` hooks.
      let context: GqlContext = {
        req: state.request as unknown as Request,
        res: {} as Response,
        connectionParams: state.connectionParams,
      };

      if (this.config.context && state.context) {
        context = await this.config.context(state.context);
      }

      // Assemble execution args and give onOperation a chance to adjust them
      let args: ExecutionArgs = {
        schema,
        document: message.payload.query,
        contextValue: context,
        variableValues: message.payload.variables,
        operationName: message.payload.operationName,
      };

      if (this.config.onOperation && state.context) {
        args = await this.config.onOperation(state.context, message, args);
      }

      if (streaming) {
        await this.startStream(socket, state, message.id, args, registration);
        return;
      }

      // Execute the single-result operation, then complete
      const result = await this.driver.execute(
        args.document as string | DocumentNode,
        args.variableValues,
        args.contextValue as GqlContext,
        args.operationName
      );

      // The client completed the operation (or the connection closed) while
      // it ran: it no longer wants the result.
      if (!owns()) {
        return;
      }
      release();

      // A result with no `data` at all failed before execution (parse,
      // validation, complexity or depth). graphql-ws reports such request
      // errors with a single `error` frame, as the streaming path does; an
      // execution result (even `data: null`) is a `next` + `complete`.
      if (result.data === undefined && result.errors?.length) {
        this.sendErrors(socket, message.id, result.errors);
        return;
      }

      this.send(socket, {
        id: message.id,
        type: 'next',
        payload: result,
      });
      this.send(socket, { id: message.id, type: 'complete' });
    } catch (error) {
      // Release the id claimed above so the client may retry it. A stream
      // that started owns its teardown in `pumpStream`. If the id was
      // completed (and possibly reused) meanwhile, this run is stale and must
      // not report to the client, matching the success path.
      const owned = owns();
      release();
      if (!owned) {
        return;
      }

      // Formatted and masked exactly as the driver formats a thrown error: a
      // failing `context`, `onSubscribe` or `onOperation` hook must not send
      // its raw text (a DSN, a connection failure) to the client in
      // production, and a coded error keeps its code.
      this.sendErrors(socket, message.id, [this.driver.formatThrownError(error)]);
    }
  }

  /**
   * Subscribe to a streaming operation and pump its events to the client.
   *
   * The subscription is registered before the first event is awaited so that
   * a `complete` from the client, or a connection close, can cancel a stream
   * that has not yet produced anything. Cancellation works by calling
   * `return()` on the iterator, which resumes the resolver's generator at its
   * suspension point and runs its cleanup.
   */
  private async startStream(
    socket: SubscriptionSocket,
    state: ConnectionState,
    id: string,
    args: ExecutionArgs,
    registration: SubscriptionState
  ): Promise<void> {
    const result = await this.driver.subscribe(
      args.document as string | DocumentNode,
      args.variableValues,
      args.contextValue as GqlContext,
      args.operationName
    );

    // A non-iterable result means the operation failed to parse or validate.
    if (!(Symbol.asyncIterator in result)) {
      if (state.subscriptions.get(id) !== registration) {
        // Completed or reused during `subscribe`: stale, so report nothing.
        return;
      }
      this.removeSubscription(state, id);
      const errors = result.errors ?? [{ message: 'Subscription failed' }];
      this.send(socket, { id, type: 'error', payload: [...errors] });
      return;
    }

    const iterator = result as AsyncIterableIterator<HandlerResult>;

    // The client may have completed or disconnected while `subscribe` was in
    // flight — or reused the id for a different operation. Either way this
    // registration no longer owns the id and its stream must not start.
    if (state.subscriptions.get(id) !== registration) {
      await this.closeIterator(iterator);
      return;
    }
    registration.iterator = iterator;

    // `pumpStream` contains stream failures itself, but its recovery path
    // sends on the socket and that can throw (the socket may have moved to
    // CLOSING between the readyState check and the send). Without this catch
    // such a throw becomes an unhandled rejection that takes down every
    // connection — defeating the per-operation isolation above.
    void this.pumpStream(socket, state, id, registration, iterator).catch((error) => {
      console.error(`Subscription pump failed for operation ${escapeLog(id)}:`, error);
      this.removeSubscription(state, id);
    });
  }

  /**
   * Forward every event from a subscription iterator to the client, then
   * send `complete`.
   *
   * Runs detached from the message handler so a long-lived stream never
   * blocks other messages on the same connection.
   */
  private async pumpStream(
    socket: SubscriptionSocket,
    state: ConnectionState,
    id: string,
    registration: SubscriptionState,
    iterator: AsyncIterableIterator<HandlerResult>
  ): Promise<void> {
    // Identity, not mere presence: the client may complete an id and reuse it
    // for a new operation while this stream is still tearing down, and this
    // stream must not emit for — or deregister — its successor.
    const owns = (): boolean => state.subscriptions.get(id) === registration;

    try {
      for await (const payload of iterator) {
        if (!owns()) {
          return;
        }
        this.send(socket, { id, type: 'next', payload });
      }

      if (owns()) {
        this.send(socket, { id, type: 'complete' });
      }
    } catch (error) {
      if (owns()) {
        this.sendErrors(socket, id, [this.driver.formatThrownError(error)]);
      }
    } finally {
      if (owns()) {
        this.removeSubscription(state, id);
      }
    }
  }

  /**
   * Cancel a subscription iterator, waiting at most
   * {@link ITERATOR_TEARDOWN_TIMEOUT_MS} for it to finish.
   *
   * Teardown errors are logged and swallowed: rethrowing would mask the
   * reason the stream was cancelled, but silence would hide a resolver whose
   * `finally` fails to release a pooled connection or unsubscribe.
   *
   * The deadline exists because `return()` on an async generator suspended at
   * an `await` is queued behind that await, so a resolver waiting on an event
   * that never arrives never resumes and its `return()` never settles. Every
   * caller here awaits this method — `handleComplete` from the message loop,
   * `handleClose` on disconnect, `onModuleDestroy` on shutdown — so an
   * unbounded wait turns one stuck generator into a stuck connection, or a
   * process that will not exit.
   */
  private async closeIterator(
    iterator: AsyncIterableIterator<HandlerResult> | undefined
  ): Promise<void> {
    if (!iterator?.return) {
      return;
    }

    // Failures are absorbed on the teardown promise itself, not via the race
    // below: a rejection arriving after the deadline has already been chosen
    // would otherwise be an unhandled rejection with no one left to catch it.
    const teardown = Promise.resolve()
      .then(() => iterator.return?.())
      .then(() => 'settled' as const)
      .catch((error: unknown) => {
        console.error('Subscription iterator teardown failed:', error);
        return 'settled' as const;
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ITERATOR_TEARDOWN_TIMEOUT_MS);
    });

    try {
      if ((await Promise.race([teardown, deadline])) === 'timeout') {
        console.error(
          `Subscription iterator did not finish teardown within ${ITERATOR_TEARDOWN_TIMEOUT_MS}ms; ` +
            'abandoning it. The resolver is most likely an async generator suspended ' +
            'awaiting an event that never arrives, which cancellation cannot resume.'
        );
      }
    } finally {
      // Without this the pending deadline keeps the event loop alive for its
      // full duration after a teardown that already finished.
      clearTimeout(timer);
    }
  }

  /**
   * Determine whether a query string is a streaming `subscription` operation.
   *
   * With an executor available the document is parsed through
   * `LeavenExecutor.parse`, which applies the executor's parser limits and
   * reuses a cached document when one exists (it reads the cache but does
   * not populate it). Without one (the driver has not been given a schema
   * yet) the query is parsed here under the same `parseOptions`.
   *
   * Parse failures return `false` so that syntax errors surface through the
   * normal execution/error path instead of being masked here. That includes
   * an exceeded `parseOptions.maxTokens`: either parse applies the same
   * token budget as the executor (default 10000), so an oversized document is
   * never lexed in full, and the executor then reports the limit.
   */
  private async isSubscriptionOperation(
    query: string,
    operationName?: string
  ): Promise<boolean> {
    try {
      const executor = this.driver.getExecutor();
      let document: DocumentNode;
      if (executor) {
        document = await executor.parse(query);
      } else {
        const { graphqlOptions, maxTokens } = this.driver.getParseOptions();
        document = parse(query, { ...graphqlOptions, maxTokens });
      }
      return getOperationAST(document, operationName)?.operation === 'subscription';
    } catch {
      return false;
    }
  }

  /**
   * Handle complete message
   */
  private async handleComplete(
    socket: SubscriptionSocket,
    state: ConnectionState,
    message: CompleteMessage
  ): Promise<void> {
    const subscription = state.subscriptions.get(message.id);
    if (subscription) {
      // Delete first: `pumpStream` treats a missing id as "cancelled" and
      // stops emitting, including for an event already in flight.
      this.removeSubscription(state, message.id);
      await this.closeIterator(subscription.iterator);

      if (this.config.onComplete && state.context) {
        await this.config.onComplete(state.context, message);
      }
    }
  }

  /**
   * Handle WebSocket close.
   *
   * Public so a Bun server can report the close directly (a `ServerWebSocket`
   * dispatches no `close` event); {@link handleConnection} routes the DOM
   * `close` event here, and {@link onModuleDestroy} calls it explicitly.
   * Idempotent: a socket already torn down is ignored.
   *
   * Teardown runs FIRST and the user's `onDisconnect` hook runs LAST, inside
   * its own try/catch. A rejecting hook must never strand resolver generators
   * at their suspension point (holding a DB cursor, a Redis subscription, an
   * interval) or leave the connection in `this.connections` — that would grow
   * without bound, one entry per disconnect.
   */
  public async handleClose(ws: SubscriptionSocket): Promise<void> {
    const state = this.connections.get(ws);
    if (!state) return;

    // Stop timers tied to this connection.
    if (state.keepAliveInterval) {
      clearInterval(state.keepAliveInterval);
      state.keepAliveInterval = undefined;
    }
    if (state.initTimeout) {
      clearTimeout(state.initTimeout);
      state.initTimeout = undefined;
    }

    // Cancel in-flight streams before dropping the connection, so resolver
    // generators run their cleanup instead of being left suspended.
    const subscriptions: SubscriptionState[] = [];
    for (const id of [...state.subscriptions.keys()]) {
      const subscription = this.removeSubscription(state, id);
      if (subscription) {
        subscriptions.push(subscription);
      }
    }
    this.connections.delete(ws);

    await Promise.all(subscriptions.map((s) => this.closeIterator(s.iterator)));

    // User hook last, and never allowed to escape: both call sites invoke
    // `handleClose` detached, so a rejection here would be unhandled.
    if (this.config.onDisconnect && state.context) {
      try {
        await this.config.onDisconnect(state.context);
      } catch (error) {
        console.error('onDisconnect hook failed:', error);
      }
    }
  }

  /**
   * Handle WebSocket error
   */
  private handleError(ws: SubscriptionSocket, _error: Event): void {
    const state = this.connections.get(ws);
    if (state) {
      void this.handleClose(ws).catch((e) =>
        console.error('WebSocket close handling failed:', e)
      );
    }
  }

  /**
   * Send message to client
   */
  private send(socket: SubscriptionSocket, message: GraphQLWSMessage): void {
    if (socket.readyState === SOCKET_OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Send error to client
   */
  private sendError(socket: SubscriptionSocket, id: string, message: string): void {
    this.sendErrors(socket, id, [{ message }]);
  }

  /**
   * Send already-formatted errors to the client as one `error` frame
   */
  private sendErrors(
    socket: SubscriptionSocket,
    id: string,
    errors: readonly GraphQLFormattedError[]
  ): void {
    this.send(socket, {
      id,
      type: 'error',
      payload: [...errors],
    });
  }

  /**
   * Register an active subscription for topic-keyed delivery via
   * {@link publishToTopic}.
   *
   * This is the integration point for a pub/sub engine (e.g. the future
   * `@leaven-graphql/ws` integration): the graphql-ws operation id chosen by
   * the client is only unique per connection, so deliveries must be routed by
   * a server-side topic and translated back to each subscriber's own
   * operation id.
   *
   * @param socket - A WebSocket connection managed by this manager that has
   *   completed `connection_init`
   * @param clientId - The client-chosen graphql-ws operation id (unique per
   *   connection only)
   * @param topic - Server-side topic used to route {@link publishToTopic} calls
   * @param context - Optional GraphQL context associated with the subscription
   * @returns `true` if the subscription was registered; `false` if the socket
   *   is unknown or uninitialized, the id is already registered on that
   *   connection, or the per-connection subscription limit has been reached
   */
  public registerSubscription(
    socket: SubscriptionSocket,
    clientId: string,
    topic: string,
    context?: GqlContext
  ): boolean {
    const state = this.connections.get(socket);
    if (!state || !state.initialized) {
      return false;
    }
    if (state.subscriptions.has(clientId)) {
      return false;
    }
    if (state.subscriptions.size >= (this.config.maxSubscriptionsPerConnection ?? 100)) {
      return false;
    }

    const subscription: SubscriptionState = { clientId, topic, context };
    const indexEntry: TopicSubscriber = { state, subscription };
    subscription.indexEntry = indexEntry;
    state.subscriptions.set(clientId, subscription);
    this.topicIndex.add(topic, indexEntry);
    return true;
  }

  /**
   * Remove an operation from its connection's subscriptions and, for a topic
   * subscription, from {@link topicIndex}.
   *
   * The ONLY way an entry leaves `ConnectionState.subscriptions`: routing
   * every removal through here is what keeps the topic index in sync. The
   * removal is unconditional; callers that must not evict a successor
   * registration under a reused id check identity first.
   *
   * @returns The removed subscription, or `undefined` if the id was not
   *   registered
   */
  private removeSubscription(
    state: ConnectionState,
    id: string
  ): SubscriptionState | undefined {
    const subscription = state.subscriptions.get(id);
    if (!subscription) {
      return undefined;
    }
    state.subscriptions.delete(id);
    if (subscription.topic !== undefined && subscription.indexEntry) {
      this.topicIndex.remove(subscription.topic, subscription.indexEntry);
    }
    return subscription;
  }

  /**
   * Publish a payload to every active subscription registered for a topic.
   *
   * Delivery is keyed on the server-side topic supplied to
   * {@link registerSubscription} — NEVER on the client-chosen operation id,
   * which is only unique per connection (most clients use "1", "2", …), so
   * keying on it would broadcast payloads across unrelated clients. Each
   * matching subscriber receives the payload in a `next` message addressed to
   * its own operation id.
   *
   * @param topic - Server-side topic to publish to
   * @param payload - Value delivered as the `data` of the `next` message
   */
  public publishToTopic(topic: string, payload: unknown): void {
    const subscribers = this.topicIndex.subscribers(topic);
    if (!subscribers) {
      return;
    }
    // Snapshot: a synchronous send may close a socket and mutate the set.
    for (const entry of [...subscribers]) {
      const { state, subscription } = entry;
      // Only deliver to a registration that is still live. An entry that
      // outlived it means some removal bypassed `removeSubscription`: warn so
      // the bug is visible, then drop the stale entry.
      if (state.subscriptions.get(subscription.clientId) !== subscription) {
        console.warn(
          `Stale topic index entry for operation ${escapeLog(subscription.clientId)} ` +
            `on topic ${escapeLog(topic)}; a subscription was removed without being unindexed.`
        );
        this.topicIndex.remove(topic, entry);
        continue;
      }
      this.send(state.socket, {
        id: subscription.clientId,
        type: 'next',
        payload: { data: payload },
      });
    }
  }

  /**
   * Publish a payload to every active subscription registered for a topic.
   *
   * @deprecated Renamed to {@link publishToTopic}. The rename exists because
   * the first argument CHANGED MEANING without changing type: it used to be
   * the graphql-ws operation id chosen by the client, and it is now a
   * server-side topic supplied to {@link registerSubscription}. Existing
   * `publish(operationId, payload)` calls still compile and still run, but
   * match nothing — streams started by `subscribe` deliberately carry no
   * topic — so subscribers silently stop receiving events. Migrate to
   * `publishToTopic(topic, payload)` and confirm the first argument is a
   * topic. Scheduled for removal in v1.0.0.
   *
   * @param topic - Server-side topic to publish to (NOT an operation id)
   * @param payload - Value delivered as the `data` of the `next` message
   */
  public publish(topic: string, payload: unknown): void {
    this.publishToTopic(topic, payload);
  }

  /**
   * Get connection count
   */
  public getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get total subscription count
   */
  public getSubscriptionCount(): number {
    let count = 0;
    for (const [_, state] of this.connections) {
      count += state.subscriptions.size;
    }
    return count;
  }
}

/**
 * Connection state
 */
interface ConnectionState {
  socket: SubscriptionSocket;
  request: Request | undefined;
  subscriptions: Map<string, SubscriptionState>;
  initialized: boolean;
  /** Set synchronously when connection_init processing starts */
  initializing: boolean;
  connectionParams: Record<string, unknown> | undefined;
  context: SubscriptionContext | undefined;
  keepAliveInterval: ReturnType<typeof setInterval> | undefined;
  /**
   * Handle for the `connection_init` deadline, cleared once the connection
   * initializes or closes so the timer does not outlive the connection.
   */
  initTimeout: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Subscription state
 *
 * Keyed by the client-chosen operation id within its connection; carries the
 * server-side topic used for {@link SubscriptionManager.publishToTopic}
 * routing.
 */
interface SubscriptionState {
  clientId: string;
  /**
   * Pub/sub routing key, set only by
   * {@link SubscriptionManager.registerSubscription}. Streams driven by their
   * own executed iterator have no topic and are therefore never targets of
   * {@link SubscriptionManager.publishToTopic}.
   */
  topic?: string;
  context?: GqlContext;
  /** Live iterator for an executed subscription, cancelled on teardown. */
  iterator?: AsyncIterableIterator<HandlerResult>;
  /**
   * This subscription's entry in `SubscriptionManager.topicIndex`, kept so
   * removal is a direct `Set.delete`. Set only alongside {@link topic}.
   */
  indexEntry?: TopicSubscriber;
}

/**
 * One entry of `SubscriptionManager.topicIndex`: a topic subscription and the
 * connection that owns it.
 */
interface TopicSubscriber {
  state: ConnectionState;
  subscription: SubscriptionState;
}

/**
 * GraphQL WS protocol messages
 */
type GraphQLWSMessage =
  | { type: 'connection_init'; payload?: Record<string, unknown> }
  | { type: 'connection_ack' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'subscribe'; id: string; payload: SubscribeMessage['payload'] }
  | { type: 'next'; id: string; payload: unknown }
  | { type: 'error'; id: string; payload: unknown[] }
  | { type: 'complete'; id?: string };

/**
 * Create a subscription decorator for NestJS resolvers.
 *
 * When `options.filter` is supplied the decorated method is wrapped so the
 * async iterator it returns yields only the events the predicate accepts, and
 * the predicate is recorded under {@link SUBSCRIPTION_FILTER_KEY} — fully
 * equivalent to applying `@SubscriptionFilter` with the same predicate, down
 * to the metadata a schema builder can inspect.
 *
 * SCOPE: this decorator only RECORDS metadata under `leaven:subscription`. It
 * does not register a subscription field with any schema — code-first schema
 * construction is not implemented, so a decorated method still needs a
 * matching `subscribe` in the schema you hand to `LeavenModule`. The
 * `filter` option is the part that takes effect unconditionally, because it
 * wraps the method itself.
 *
 * @param returns - Thunk naming the subscription's GraphQL type. RESERVED FOR
 *   FUTURE USE: it is stored in the metadata verbatim and nothing reads it
 *   today; a future code-first schema builder is what will consume it. Supply
 *   the accurate type anyway so that builder does not have to guess.
 * @param options - `filter` narrows the streamed events, exactly as
 *   `@SubscriptionFilter` does; it is also stored in the metadata.
 */
export function Subscription(
  returns: () => unknown,
  options?: {
    filter?: (
      payload: unknown,
      variables: unknown,
      context: unknown
    ) => boolean | Promise<boolean>;
  }
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    const filter = options?.filter;

    if (filter) {
      // Shared with `@SubscriptionFilter` so a correctness fix lands once.
      wrapWithFilter(descriptor as PropertyDescriptor, filter);

      // Recorded on the wrapper (applied after it) under the same key
      // `@SubscriptionFilter` uses, so inspection works either way.
      SetMetadata(SUBSCRIPTION_FILTER_KEY, filter)(target, propertyKey, descriptor);
    }

    // Guarded exactly as `schema-builder.ts` guards its own reads: the
    // reflect-metadata polyfill is always loaded under NestJS, but this
    // package must not assume it in every consumer. Recording metadata is a
    // best-effort annotation, so its absence degrades to a no-op instead of
    // throwing at class-definition time and taking the whole module with it.
    if (descriptor.value && typeof Reflect.defineMetadata === 'function') {
      Reflect.defineMetadata('leaven:subscription', { returns, options }, descriptor.value);
    }
    return descriptor;
  };
}

/**
 * Inject the module's shared {@link PubSub} instance.
 *
 * Resolves the `LEAVEN_PUBSUB` provider registered by `LeavenModule`, so a
 * provider can publish events and a subscription field can return
 * `pubSub.asyncIterator(topic)`.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class CommentService {
 *   constructor(@InjectPubSub() private readonly pubSub: PubSub) {}
 *
 *   add(comment: Comment): void {
 *     this.pubSub.publish('COMMENT_ADDED', comment);
 *   }
 * }
 * ```
 */
export function InjectPubSub(): ParameterDecorator {
  return Inject(LEAVEN_PUBSUB);
}
