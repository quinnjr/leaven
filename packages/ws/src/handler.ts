/**
 * @leaven-graphql/ws - WebSocket handler
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { OperationTypeNode, getOperationAST, type DocumentNode, type GraphQLSchema } from 'graphql';
import type { ServerWebSocket } from 'bun';
import type { GraphQLRequest } from '@leaven-graphql/core';
import {
  ErrorCode,
  LeavenError,
  formatError,
  withMaskingDefault,
  type ErrorMaskingOptions,
} from '@leaven-graphql/errors';

import { SubscriptionManager, type SubscriptionManagerConfig } from './manager';
import type { WebSocketLogger } from './logger';
import {
  MessageType,
  parseMessage,
  formatMessage,
  createConnectionAck,
  createNextMessage,
  createErrorMessage,
  createCompleteMessage,
  createPongMessage,
  type Message,
  type SubscribeMessage,
} from './protocol';

/**
 * WebSocket context data
 */
export interface WebSocketContext {
  /** Connection ID */
  connectionId: string;
  /** Connection parameters from init */
  connectionParams?: Record<string, unknown>;
  /** Whether the connection is initialized */
  initialized: boolean;
  /** Active subscription IDs */
  subscriptions: Set<string>;
}

/**
 * Context factory for WebSocket connections
 */
export type WebSocketContextFactory<TContext> = (
  socket: ServerWebSocket<WebSocketContext>,
  request: GraphQLRequest
) => TContext | Promise<TContext>;

/**
 * WebSocket handler configuration
 */
export interface WebSocketHandlerConfig<TContext = unknown> {
  /** GraphQL schema */
  schema: GraphQLSchema;
  /** Context factory */
  context?: WebSocketContextFactory<TContext>;
  /**
   * Connection initialization timeout (ms, default 3000). The socket is
   * closed with 4408 if `connection_init` does not arrive in time, or if
   * `onConnect` has not settled this long after it arrived.
   */
  connectionInitTimeout?: number;
  /** Keep alive interval (ms) */
  keepAliveInterval?: number;
  /**
   * Browser origins allowed to open a WebSocket, checked by
   * {@link WebSocketHandler.isOriginAllowed} before the upgrade (LeavenServer
   * does this automatically). Browsers attach cookies to cross-site WebSocket
   * handshakes and no CORS preflight applies, so accepting any origin allows
   * cross-site WebSocket hijacking.
   *
   * By default only the server's own origin is allowed: the `Origin` header's
   * host:port must equal the upgrade request's `Host` header (compared
   * case-insensitively, default ports normalised). A list adds the given
   * origins (e.g. `'https://app.example.com'`) to the server's own; `'*'`
   * allows any origin. A request with no `Origin` header (a non-browser
   * client) is always allowed.
   */
  allowedOrigins?: readonly string[] | '*';
  /** Subscription manager config */
  subscriptionManager?: Omit<SubscriptionManagerConfig, 'schema'>;
  /**
   * Where diagnostics (failing hooks and callbacks) are logged. Defaults to
   * `console`. Also passed to the subscription manager unless
   * `subscriptionManager.logger` is set.
   */
  logger?: WebSocketLogger;
  /**
   * Error formatting options, as for the HTTP transport's `errorFormatting`.
   *
   * Every error sent in an `error` or `next` frame goes through
   * `formatError` from `@leaven-graphql/errors`: one thrown by `onSubscribe`,
   * the context factory or a source stream always; execution errors the
   * executor already serialised only when this is set. Thrown errors are
   * masked by default (`maskErrors` defaults to `true` for them, so a throwing
   * context factory never sends its raw message, such as a DSN, to the
   * client); set `maskErrors: false` to disable. A `LeavenError` or an error
   * with a known non-`INTERNAL_ERROR` code keeps its message and
   * `extensions.code`; anything else (an uncoded `GraphQLError` included) is
   * masked as `INTERNAL_ERROR`. Also passed to the subscription manager unless
   * `subscriptionManager.errorFormatting` is set.
   */
  errorFormatting?: ErrorMaskingOptions;
  /** Called when a connection is initialized */
  onConnect?: (
    socket: ServerWebSocket<WebSocketContext>,
    params?: Record<string, unknown>
  ) => boolean | Promise<boolean>;
  /** Called when a connection is closed */
  onDisconnect?: (socket: ServerWebSocket<WebSocketContext>) => void | Promise<void>;
  /** Called on subscription start */
  onSubscribe?: (
    socket: ServerWebSocket<WebSocketContext>,
    id: string,
    request: GraphQLRequest
  ) => void | Promise<void>;
  /** Called on subscription end */
  onComplete?: (
    socket: ServerWebSocket<WebSocketContext>,
    id: string
  ) => void | Promise<void>;
}

/**
 * Handler-private lifecycle state for one socket.
 *
 * Kept off `socket.data` (which is the application's) and keyed by the socket
 * object, so it outlives `handleClose`: an operation that resumes after the
 * socket closed still finds `closed: true` rather than a fresh state.
 */
interface ConnectionState {
  /** Set synchronously when connection_init processing starts */
  initializing: boolean;
  /** Set synchronously at the start of `handleClose` */
  closed: boolean;
  /**
   * Operations accepted but not yet registered with the subscription
   * manager, by id. A client `complete` for one of these cancels it, so when
   * its setup resumes it registers nothing (and any iterator it obtained is
   * returned) even if the id has since been reused.
   */
  pending: Map<string, PendingOperation>;
}

/**
 * Cancellation token for one in-flight operation.
 */
interface PendingOperation {
  cancelled: boolean;
}

/**
 * WebSocket handler for Bun
 */
export class WebSocketHandler<TContext = unknown> {
  private readonly schema: GraphQLSchema;
  private readonly contextFactory?: WebSocketContextFactory<TContext>;
  private readonly connectionInitTimeout: number;
  private readonly keepAliveInterval: number;
  private readonly subscriptionManager: SubscriptionManager;
  private readonly onConnect?: WebSocketHandlerConfig<TContext>['onConnect'];
  private readonly onDisconnect?: WebSocketHandlerConfig<TContext>['onDisconnect'];
  private readonly onSubscribe?: WebSocketHandlerConfig<TContext>['onSubscribe'];
  private readonly onComplete?: WebSocketHandlerConfig<TContext>['onComplete'];
  private readonly logger: WebSocketLogger;
  private readonly maskingOptions: ErrorMaskingOptions;
  private readonly allowedOrigins: ReadonlySet<string> | '*';

  private readonly initTimeouts: Map<string, ReturnType<typeof setTimeout>>;
  private readonly keepAliveTimers: Map<string, ReturnType<typeof setInterval>>;
  private readonly states: WeakMap<ServerWebSocket<WebSocketContext>, ConnectionState>;

  constructor(config: WebSocketHandlerConfig<TContext>) {
    this.schema = config.schema;
    this.contextFactory = config.context;
    this.connectionInitTimeout = config.connectionInitTimeout ?? 3000;
    this.keepAliveInterval = config.keepAliveInterval ?? 12000;
    this.logger = config.logger ?? console;
    this.maskingOptions = withMaskingDefault(config.errorFormatting);
    this.allowedOrigins =
      config.allowedOrigins === '*'
        ? '*'
        : new Set((config.allowedOrigins ?? []).map(normalizeOrigin));
    this.subscriptionManager = new SubscriptionManager({
      schema: config.schema,
      logger: this.logger,
      errorFormatting: config.errorFormatting,
      ...config.subscriptionManager,
    });
    this.onConnect = config.onConnect;
    this.onDisconnect = config.onDisconnect;
    this.onSubscribe = config.onSubscribe;
    this.onComplete = config.onComplete;

    this.initTimeouts = new Map();
    this.keepAliveTimers = new Map();
    this.states = new WeakMap();
  }

  /**
   * Lifecycle state for a socket, created on first use.
   */
  private stateOf(socket: ServerWebSocket<WebSocketContext>): ConnectionState {
    let state = this.states.get(socket);
    if (!state) {
      state = { initializing: false, closed: false, pending: new Map() };
      this.states.set(socket, state);
    }
    return state;
  }

  /**
   * Stop and forget a connection's keep-alive timer, if it has one.
   */
  private clearKeepAlive(connectionId: string): void {
    const timer = this.keepAliveTimers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(connectionId);
    }
  }

  /**
   * Generate a unique connection ID
   */
  private generateConnectionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Invoke a user-supplied lifecycle hook without letting its failure escape.
   *
   * These hooks are called from places with no caller able to catch: iterator
   * consumption stacks inside the subscription manager, timer callbacks, and
   * Bun's `void`-returning socket callbacks. A rejected promise dropped into
   * one of those slots is an unhandled rejection, which by default aborts the
   * process and takes every other connection with it.
   */
  private invokeHook(name: string, invoke: () => void | Promise<void>): void {
    try {
      const result = invoke();
      if (result instanceof Promise) {
        result.catch((error) => {
          this.logger.error(`${name} failed:`, error);
        });
      }
    } catch (error) {
      this.logger.error(`${name} failed:`, error);
    }
  }

  /**
   * Whether an upgrade request's `Origin` may open a WebSocket, per
   * `allowedOrigins`. Call it before `server.upgrade()` and refuse the
   * upgrade (e.g. with 403) when it returns `false`; LeavenServer does so.
   *
   * A request without an `Origin` header (a non-browser client) is always
   * allowed. Otherwise the origin is allowed when `allowedOrigins` is `'*'`,
   * when its host:port equals the request's `Host` header (case-insensitive,
   * default ports normalised), or when it is in `allowedOrigins`.
   *
   * Twin of `SubscriptionManager.isOriginAllowed` in
   * packages/nestjs/src/subscriptions.ts. Only a `Request` is accepted, so the
   * header lookup is case-insensitive.
   *
   * @param request - The WebSocket upgrade request
   * @returns `true` when the upgrade may proceed
   */
  public isOriginAllowed(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (origin === null || this.allowedOrigins === '*') {
      return true;
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      // An opaque or malformed origin (e.g. `null`) can only be listed.
      return this.allowedOrigins.has(normalizeOrigin(origin));
    }
    if (this.allowedOrigins.has(normalizeOrigin(origin))) {
      return true;
    }

    const host = request.headers.get('host') ?? safeHost(request);
    if (host === '') {
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
   * Handle WebSocket open
   */
  public handleOpen(socket: ServerWebSocket<WebSocketContext>): void {
    const connectionId = this.generateConnectionId();

    socket.data = {
      connectionId,
      initialized: false,
      subscriptions: new Set(),
    };
    this.states.set(socket, { initializing: false, closed: false, pending: new Map() });

    // Set connection init timeout
    const timeout = setTimeout(() => {
      if (!socket.data.initialized) {
        socket.close(4408, 'Connection initialization timeout');
      }
    }, this.connectionInitTimeout);

    this.initTimeouts.set(connectionId, timeout);
  }

  /**
   * Handle WebSocket message
   */
  public async handleMessage(
    socket: ServerWebSocket<WebSocketContext>,
    message: string | Buffer
  ): Promise<void> {
    try {
      // Inbound client frames must carry a routable id; state it explicitly so
      // the server's strictness is visible at the call site
      const parsed = parseMessage(message, { requireId: true });
      await this.processMessage(socket, parsed);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid message';
      socket.close(4400, errorMessage);
    }
  }

  /**
   * Process a parsed message
   */
  private async processMessage(
    socket: ServerWebSocket<WebSocketContext>,
    message: Message
  ): Promise<void> {
    switch (message.type) {
      case MessageType.ConnectionInit:
        await this.handleConnectionInit(socket, message.payload);
        break;

      case MessageType.Ping:
        socket.send(formatMessage(createPongMessage(message.payload)));
        break;

      case MessageType.Pong:
        // Client responded to our ping
        break;

      case MessageType.Subscribe:
        if (!socket.data.initialized) {
          socket.close(4401, 'Unauthorized');
          return;
        }
        await this.handleSubscribe(socket, message);
        break;

      case MessageType.Complete:
        if (!socket.data.initialized) {
          return;
        }
        this.handleComplete(socket, message.id);
        break;

      default:
        socket.close(4400, 'Invalid message');
    }
  }

  /**
   * Handle connection init message
   */
  private async handleConnectionInit(
    socket: ServerWebSocket<WebSocketContext>,
    params?: Record<string, unknown>
  ): Promise<void> {
    const state = this.stateOf(socket);

    // Reject repeated connection_init (graphql-ws close code 4429). The
    // `initializing` flag is set synchronously, BEFORE the onConnect await:
    // checking `initialized` alone lets a second init that arrives while the
    // first is still in onConnect pass, run onConnect again and start a
    // second keep-alive timer.
    if (state.initializing || socket.data.initialized) {
      socket.close(4429, 'Too many initialisation requests');
      return;
    }
    state.initializing = true;

    // Clear init timeout
    const timeout = this.initTimeouts.get(socket.data.connectionId);
    if (timeout) {
      clearTimeout(timeout);
      this.initTimeouts.delete(socket.data.connectionId);
    }

    // Check onConnect hook
    if (this.onConnect) {
      let outcome: Awaited<ReturnType<WebSocketHandler<TContext>['awaitOnConnect']>>;
      try {
        outcome = await this.awaitOnConnect(this.onConnect, socket, params);
      } catch (error) {
        // A throwing hook is treated like a rejection; its text (a DSN, a
        // connection failure) must not reach the client as a close reason
        this.logger.error('onConnect hook failed:', error);
        if (!state.closed) {
          socket.close(4403, 'Forbidden');
        }
        return;
      }
      // The socket may have closed, or timed out, while onConnect ran.
      // Acknowledging it now would start a keep-alive timer that nothing
      // ever clears.
      if (state.closed || outcome.timedOut) {
        return;
      }
      const { allowed } = outcome;
      if (!allowed) {
        socket.close(4403, 'Forbidden');
        return;
      }
    }

    socket.data.connectionParams = params;
    socket.data.initialized = true;

    // Send ack
    socket.send(formatMessage(createConnectionAck()));

    // Start keep-alive. Only one timer may ever exist per connection, so any
    // existing one is cleared first.
    if (this.keepAliveInterval > 0) {
      this.clearKeepAlive(socket.data.connectionId);
      const timer = setInterval(() => {
        socket.send(formatMessage({ type: MessageType.Ping }));
      }, this.keepAliveInterval);

      this.keepAliveTimers.set(socket.data.connectionId, timer);
    }
  }

  /**
   * Run onConnect, bounded by `connectionInitTimeout`.
   *
   * The open-time init timer stops when connection_init arrives, so without
   * this an onConnect that never settles would hold the socket open
   * unauthenticated forever. If it has not settled in time the socket is
   * closed with the same 4408 as a missing connection_init, and its late
   * result is ignored: a late rejection is logged rather than closing the
   * socket a second time. The timer lives in `initTimeouts`, so a close
   * during onConnect stops it.
   */
  private async awaitOnConnect(
    onConnect: NonNullable<WebSocketHandlerConfig<TContext>['onConnect']>,
    socket: ServerWebSocket<WebSocketContext>,
    params: Record<string, unknown> | undefined
  ): Promise<{ timedOut: true } | { timedOut: false; allowed: boolean }> {
    const { connectionId } = socket.data;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.initTimeouts.delete(connectionId);
      socket.close(4408, 'Connection initialization timeout');
    }, this.connectionInitTimeout);
    this.initTimeouts.set(connectionId, timer);

    try {
      const allowed = await onConnect(socket, params);
      return timedOut ? { timedOut: true } : { timedOut: false, allowed };
    } catch (error) {
      if (timedOut) {
        this.logger.error('onConnect failed after the connection initialisation timeout:', error);
        return { timedOut: true };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.initTimeouts.get(connectionId) === timer) {
        this.initTimeouts.delete(connectionId);
      }
    }
  }

  /**
   * Handle subscribe message
   */
  private async handleSubscribe(
    socket: ServerWebSocket<WebSocketContext>,
    message: SubscribeMessage
  ): Promise<void> {
    const { id, payload } = message;
    const state = this.stateOf(socket);

    // Check if subscription ID already exists
    if (socket.data.subscriptions.has(id)) {
      socket.close(4409, `Subscriber for ${id} already exists`);
      return;
    }

    // Enforce the per-connection limit here too, counting operations still
    // being set up: the manager only sees an operation once its hooks and
    // context factory have run, so without this a burst of frames would run
    // all of that work before any of them hit the manager's limit.
    if (socket.data.subscriptions.size >= this.subscriptionManager.subscriptionLimit) {
      const limitError = new LeavenError(
        'Maximum subscriptions per connection reached',
        ErrorCode.BAD_REQUEST
      );
      socket.send(
        formatMessage(createErrorMessage(id, [formatError(limitError, this.maskingOptions)]))
      );
      return;
    }

    // Register the ID synchronously, BEFORE any await, so a concurrent
    // Subscribe frame with the same ID is caught by the duplicate check
    // above while this one is still setting up
    socket.data.subscriptions.add(id);
    const token: PendingOperation = { cancelled: false };
    state.pending.set(id, token);
    const settle = (): void => {
      if (state.pending.get(id) === token) {
        state.pending.delete(id);
      }
    };

    const request: GraphQLRequest = {
      query: payload.query,
      operationName: payload.operationName,
      variables: payload.variables,
      extensions: payload.extensions,
    };

    // Whether this operation was abandoned while it awaited: the socket
    // closed, or the client completed the id (which may since have been
    // reused by a newer operation). Nothing may be sent, registered or
    // cleaned up for it after that: the id is no longer this operation's.
    const abandoned = (): boolean => state.closed || token.cancelled;

    try {
      // Call onSubscribe hook
      await this.onSubscribe?.(socket, id, request);
      if (abandoned()) return;

      // Build context
      let context: TContext | undefined;
      if (this.contextFactory) {
        context = await this.contextFactory(socket, request);
        if (abandoned()) return;
      }

      // A Subscribe frame is the graphql-ws transport for EVERY operation,
      // not just subscriptions. A query or mutation yields a single Next
      // followed by Complete; routing it into graphql-js `subscribe()` would
      // fail with "Schema is not configured to execute subscription
      // operation."
      const isSubscription = await this.isSubscriptionOperation(request);
      if (abandoned()) return;
      if (!isSubscription) {
        const response = await this.subscriptionManager.execute(request, context);
        if (abandoned()) return;

        // Errors raised BEFORE execution (validation, variable coercion) are
        // an Error message; errors raised DURING execution ride inside the
        // single Next. The executor omits `data` entirely in the former case,
        // which is what separates the two here.
        if (response.data === undefined && response.errors && response.errors.length > 0) {
          socket.send(formatMessage(createErrorMessage(id, response.errors)));
        } else {
          socket.send(
            formatMessage(
              createNextMessage(id, response.data, response.errors, response.extensions)
            )
          );
          socket.send(formatMessage(createCompleteMessage(id)));
        }

        settle();
        socket.data.subscriptions.delete(id);
        this.invokeHook('onComplete hook', () => this.onComplete?.(socket, id));
        return;
      }

      // Create subscription
      await this.subscriptionManager.subscribe(
        socket.data.connectionId,
        id,
        request,
        context,
        (result) => {
          socket.send(
            formatMessage(createNextMessage(id, result.data, result.errors, result.extensions))
          );
        },
        () => {
          socket.send(formatMessage(createCompleteMessage(id)));
          socket.data.subscriptions.delete(id);
          this.invokeHook('onComplete hook', () => this.onComplete?.(socket, id));
        },
        (errors) => {
          socket.send(formatMessage(createErrorMessage(id, errors)));
          socket.data.subscriptions.delete(id);
          this.invokeHook('onComplete hook', () => this.onComplete?.(socket, id));
        }
      );
      // Registered (or already finished): a client complete is now handled
      // by the manager's unsubscribe, which returns the iterator
      settle();
    } catch (error) {
      if (abandoned()) return;
      settle();
      // Per graphql-ws, operation setup failures are reported as an Error
      // message on the offending ID — the connection (and its other
      // subscriptions) must stay open. Formatted like HTTP formats an error
      // thrown outside execution: a throwing onSubscribe hook or context
      // factory must not send its raw text (a DSN, a connection failure) to
      // the client when masking is on, and a coded error keeps its code.
      socket.send(
        formatMessage(createErrorMessage(id, [formatError(error, this.maskingOptions)]))
      );
      socket.data.subscriptions.delete(id);
      // Terminal, like the other three paths: the id is finished, so the
      // hook fires here too rather than only for operations that reached
      // 'active'
      this.invokeHook('onComplete hook', () => this.onComplete?.(socket, id));
    }
  }

  /**
   * Whether a request's selected operation is a subscription.
   *
   * A document graphql-js cannot resolve to a single operation (no operations
   * at all, or several with no `operationName`) is reported as a subscription
   * so the executor produces the precise error rather than this method
   * guessing at one. The same goes for a document that fails to parse.
   *
   * Parsing goes through the executor, so the configured `maxTokens` and
   * depth limits apply here too; a plain `parse()` would lex an arbitrarily
   * large document before the executor's limits ever ran.
   */
  private async isSubscriptionOperation(request: GraphQLRequest): Promise<boolean> {
    let document: DocumentNode;
    try {
      document = await this.subscriptionManager.parse(request.query);
    } catch {
      return true;
    }
    const operation = getOperationAST(document, request.operationName ?? null);
    return !operation || operation.operation === OperationTypeNode.SUBSCRIPTION;
  }

  /**
   * Handle complete message (client unsubscribe)
   */
  private handleComplete(
    socket: ServerWebSocket<WebSocketContext>,
    subscriptionId: string
  ): void {
    // Cancel an operation that is still being set up, so it registers
    // nothing when it resumes
    const state = this.stateOf(socket);
    const pending = state.pending.get(subscriptionId);
    if (pending) {
      pending.cancelled = true;
      state.pending.delete(subscriptionId);
    }

    // Only an operation that was live fires onComplete: a duplicate, unknown
    // or already-finished id must not
    const wasLive = pending !== undefined || socket.data.subscriptions.has(subscriptionId);
    socket.data.subscriptions.delete(subscriptionId);
    // Scoped to THIS connection: operation ids are unique per connection, so
    // an unscoped teardown would drop another client's subscription
    this.subscriptionManager.unsubscribe(socket.data.connectionId, subscriptionId);
    if (wasLive) {
      this.invokeHook('onComplete hook', () => this.onComplete?.(socket, subscriptionId));
    }
  }

  /**
   * Handle WebSocket close
   */
  public async handleClose(socket: ServerWebSocket<WebSocketContext>): Promise<void> {
    const { connectionId } = socket.data;

    // Flag the close synchronously, before anything else: operations still
    // awaiting onConnect, a context factory or the executor check it when
    // they resume and must not register anything on a dead socket.
    const state = this.stateOf(socket);
    state.closed = true;
    for (const pending of state.pending.values()) {
      pending.cancelled = true;
    }
    state.pending.clear();

    // Clear timeouts/timers
    const initTimeout = this.initTimeouts.get(connectionId);
    if (initTimeout) {
      clearTimeout(initTimeout);
      this.initTimeouts.delete(connectionId);
    }

    this.clearKeepAlive(connectionId);

    // Unsubscribe all subscriptions
    this.subscriptionManager.unsubscribeConnection(connectionId);
    socket.data.subscriptions.clear();

    // Call onDisconnect hook
    await this.onDisconnect?.(socket);
  }

  /**
   * Get Bun WebSocket handler config
   */
  public getWebSocketConfig(): {
    open: (socket: ServerWebSocket<WebSocketContext>) => void;
    message: (socket: ServerWebSocket<WebSocketContext>, message: string | Buffer) => void;
    close: (socket: ServerWebSocket<WebSocketContext>) => void;
  } {
    // Bun's callbacks are `void`-returning slots: a promise dropped into one
    // rejects with nobody watching, which is an unhandled rejection and by
    // default aborts the process. Every async path is terminated here.
    return {
      open: (socket: ServerWebSocket<WebSocketContext>) => this.handleOpen(socket),
      message: (socket: ServerWebSocket<WebSocketContext>, message: string | Buffer) => {
        void this.handleMessage(socket, message).catch((error) => {
          this.logger.error('WebSocket message handling failed:', error);
        });
      },
      close: (socket: ServerWebSocket<WebSocketContext>) => {
        void this.handleClose(socket).catch((error) => {
          this.logger.error('onDisconnect failed:', error);
        });
      },
    };
  }
}

/**
 * Normalise an origin for comparison: scheme://host[:port], lowercased and
 * without the scheme's default port. A value that does not parse as a URL
 * (e.g. the opaque origin `null`) is just trimmed and lowercased.
 *
 * Twin of `normalizeOrigin` in packages/nestjs/src/subscriptions.ts.
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

/**
 * The host:port of the request URL. `Request.url` always parses, so no guard
 * is needed (the nestjs twin accepts non-Request inputs and keeps its own).
 */
function safeHost(request: Request): string {
  return new URL(request.url).host;
}

/**
 * Create a WebSocket handler
 */
export function createWebSocketHandler<TContext = unknown>(
  config: WebSocketHandlerConfig<TContext>
): WebSocketHandler<TContext> {
  return new WebSocketHandler(config);
}
