/**
 * @leaven-graphql/ws - WebSocket handler
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { OperationTypeNode, getOperationAST, parse, type GraphQLSchema } from 'graphql';
import type { ServerWebSocket } from 'bun';
import type { GraphQLRequest } from '@leaven-graphql/core';

import { SubscriptionManager, type SubscriptionManagerConfig } from './manager';
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
  /** Connection initialization timeout (ms) */
  connectionInitTimeout?: number;
  /** Keep alive interval (ms) */
  keepAliveInterval?: number;
  /** Subscription manager config */
  subscriptionManager?: Omit<SubscriptionManagerConfig, 'schema'>;
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

  private readonly initTimeouts: Map<string, ReturnType<typeof setTimeout>>;
  private readonly keepAliveTimers: Map<string, ReturnType<typeof setInterval>>;
  private readonly states: WeakMap<ServerWebSocket<WebSocketContext>, ConnectionState>;

  constructor(config: WebSocketHandlerConfig<TContext>) {
    this.schema = config.schema;
    this.contextFactory = config.context;
    this.connectionInitTimeout = config.connectionInitTimeout ?? 3000;
    this.keepAliveInterval = config.keepAliveInterval ?? 12000;
    this.subscriptionManager = new SubscriptionManager({
      schema: config.schema,
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
      state = { initializing: false, closed: false };
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
          console.error(`${name} failed:`, error);
        });
      }
    } catch (error) {
      console.error(`${name} failed:`, error);
    }
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
    this.states.set(socket, { initializing: false, closed: false });

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
      const allowed = await this.onConnect(socket, params);
      // The socket may have closed while onConnect ran. Acknowledging it now
      // would start a keep-alive timer that nothing ever clears.
      if (state.closed) {
        return;
      }
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
   * Handle subscribe message
   */
  private async handleSubscribe(
    socket: ServerWebSocket<WebSocketContext>,
    message: SubscribeMessage
  ): Promise<void> {
    const { id, payload } = message;

    // Check if subscription ID already exists
    if (socket.data.subscriptions.has(id)) {
      socket.close(4409, `Subscriber for ${id} already exists`);
      return;
    }

    // Register the ID synchronously, BEFORE any await, so a concurrent
    // Subscribe frame with the same ID is caught by the duplicate check
    // above while this one is still setting up
    socket.data.subscriptions.add(id);

    const request: GraphQLRequest = {
      query: payload.query,
      operationName: payload.operationName,
      variables: payload.variables,
      extensions: payload.extensions,
    };

    try {
      // Call onSubscribe hook
      await this.onSubscribe?.(socket, id, request);

      // Build context
      let context: TContext | undefined;
      if (this.contextFactory) {
        context = await this.contextFactory(socket, request);
      }

      // A Subscribe frame is the graphql-ws transport for EVERY operation,
      // not just subscriptions. A query or mutation yields a single Next
      // followed by Complete; routing it into graphql-js `subscribe()` would
      // fail with "Schema is not configured to execute subscription
      // operation."
      if (!this.isSubscriptionOperation(request)) {
        const response = await this.subscriptionManager.execute(request, context);

        // Errors raised BEFORE execution (validation, variable coercion) are
        // an Error message; errors raised DURING execution ride inside the
        // single Next. The executor omits `data` entirely in the former case,
        // which is what separates the two here.
        if (response.data === undefined && response.errors && response.errors.length > 0) {
          socket.send(formatMessage(createErrorMessage(id, response.errors)));
        } else {
          socket.send(formatMessage(createNextMessage(id, response.data, response.errors)));
          socket.send(formatMessage(createCompleteMessage(id)));
        }

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
          socket.send(formatMessage(createNextMessage(id, result.data, result.errors)));
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
    } catch (error) {
      // Per graphql-ws, operation setup failures are reported as an Error
      // message on the offending ID — the connection (and its other
      // subscriptions) must stay open
      const errorText = error instanceof Error ? error.message : 'Subscription failed';
      socket.send(formatMessage(createErrorMessage(id, [{ message: errorText }])));
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
   * guessing at one.
   */
  private isSubscriptionOperation(request: GraphQLRequest): boolean {
    const document = parse(request.query);
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
    socket.data.subscriptions.delete(subscriptionId);
    // Scoped to THIS connection: operation ids are unique per connection, so
    // an unscoped teardown would drop another client's subscription
    this.subscriptionManager.unsubscribe(socket.data.connectionId, subscriptionId);
    this.invokeHook('onComplete hook', () => this.onComplete?.(socket, subscriptionId));
  }

  /**
   * Handle WebSocket close
   */
  public async handleClose(socket: ServerWebSocket<WebSocketContext>): Promise<void> {
    const { connectionId } = socket.data;

    // Flag the close synchronously, before anything else: operations still
    // awaiting onConnect, a context factory or the executor check it when
    // they resume and must not register anything on a dead socket.
    this.stateOf(socket).closed = true;

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
          console.error('WebSocket message handling failed:', error);
        });
      },
      close: (socket: ServerWebSocket<WebSocketContext>) => {
        void this.handleClose(socket).catch((error) => {
          console.error('onDisconnect failed:', error);
        });
      },
    };
  }
}

/**
 * Create a WebSocket handler
 */
export function createWebSocketHandler<TContext = unknown>(
  config: WebSocketHandlerConfig<TContext>
): WebSocketHandler<TContext> {
  return new WebSocketHandler(config);
}
