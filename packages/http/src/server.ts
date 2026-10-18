/**
 * @leaven-graphql/http - Bun HTTP server
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { Server } from 'bun';
import type { WebSocketHandler, WebSocketContext } from '@leaven-graphql/ws';
import { createHandler, type HandlerConfig, type GraphQLHandler } from './handler';

/** Bun's default `idleTimeout`, in seconds; LeavenServer does not override it */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 10;

/**
 * Server configuration
 */
export interface ServerConfig<TContext = unknown> extends HandlerConfig<TContext> {
  /** Port to listen on (default: 4000) */
  port?: number;
  /** Hostname to bind to (default: '0.0.0.0') */
  hostname?: string;
  /** Enable development mode */
  development?: boolean;
  /** Custom fetch handler for non-GraphQL routes */
  fallback?: (request: Request) => Response | Promise<Response>;
  /** Routes map for multiple endpoints */
  routes?: Record<string, GraphQLHandler | ((request: Request) => Response | Promise<Response>)>;
  /**
   * WebSocket handler for GraphQL subscriptions. When set, requests to the
   * GraphQL path carrying an `Upgrade: websocket` header are upgraded and
   * handled via the graphql-transport-ws protocol. For subscriptions over
   * plain HTTP, set `sse` instead (or as well): requests that Accept
   * `text/event-stream` are streamed as server-sent events, with Bun's idle
   * timeout disabled while the stream is open and restored when it closes.
   */
  websocket?: WebSocketHandler;
  /** Called when server starts */
  onStart?: (server: Server<unknown>) => void;
  /** Called when server stops */
  onStop?: () => void;
  /** Called on request error */
  onError?: (error: Error, request: Request) => Response | Promise<Response>;
}

/**
 * Server information
 */
export interface ServerInfo {
  /** Port the server is listening on */
  port: number;
  /** Hostname the server is bound to */
  hostname: string;
  /** Full URL of the server */
  url: string;
}

/**
 * Leaven GraphQL Server for Bun
 */
export class LeavenServer {
  private server: Server<unknown> | null = null;
  private readonly config: ServerConfig;
  private readonly handler: GraphQLHandler;
  private readonly path: string;
  private readonly routeMap: Map<
    string,
    GraphQLHandler | ((request: Request) => Response | Promise<Response>)
  >;

  constructor(config: ServerConfig) {
    this.config = config;
    this.path = config.path ?? '/graphql';
    this.handler = createHandler(config);
    this.routeMap = new Map(Object.entries(config.routes ?? {}));
  }

  /**
   * Handle incoming requests
   *
   * Returns `undefined` only when the request was upgraded to a WebSocket
   * connection (Bun requires `fetch` to return undefined in that case).
   */
  private async handleRequest(request: Request): Promise<Response | undefined> {
    try {
      const url = new URL(request.url);

      // Check routes (all handlers are awaited so async failures are
      // routed through onError instead of escaping the try block)
      const routeHandler = this.routeMap.get(url.pathname);
      if (routeHandler) {
        return await routeHandler(request);
      }

      // Handle GraphQL endpoint
      if (url.pathname === this.path) {
        // Upgrade WebSocket connections for subscriptions
        if (
          this.config.websocket &&
          this.server &&
          request.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ) {
          const data: WebSocketContext = {
            connectionId: '',
            initialized: false,
            subscriptions: new Set(),
          };
          if (this.server.upgrade(request, { data })) {
            return undefined;
          }
          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        return this.holdOpenForStream(request, await this.handler(request));
      }

      // Fallback handler
      if (this.config.fallback) {
        return await this.config.fallback(request);
      }

      // Default 404
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      if (this.config.onError) {
        return this.config.onError(error as Error, request);
      }

      console.error('Request error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  /**
   * Keep Bun's idle timeout from closing an open event stream.
   *
   * An event stream may stay quiet longer than Bun's idle timeout between
   * events; keep-alives cover proxies, this covers Bun itself. The timeout is
   * only disabled once the handler has actually answered a GET or POST with
   * an event stream — never for a JSON error — and it is restored when the
   * stream ends or the client cancels it, so the keep-alive socket that
   * carried the stream is not left without a timeout afterwards.
   *
   * @param request - The request Bun handed to `fetch`
   * @param response - The handler's response
   * @returns The response, with its body wrapped when it is an event stream
   */
  private holdOpenForStream(request: Request, response: Response): Response {
    const server = this.server;
    const method = request.method.toUpperCase();
    if (
      !this.config.sse ||
      !server ||
      (method !== 'GET' && method !== 'POST') ||
      !response.body ||
      !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')
    ) {
      return response;
    }

    server.timeout(request, 0);
    let restored = false;
    const restore = (): void => {
      if (restored) {
        return;
      }
      restored = true;
      try {
        server.timeout(request, DEFAULT_IDLE_TIMEOUT_SECONDS);
      } catch {
        // The socket is already gone; there is no timeout left to restore
      }
    };

    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        try {
          const { done, value } = await reader.read();
          if (done) {
            restore();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          restore();
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        restore();
        await reader.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Build the Bun.serve options.
   *
   * Shared by `start()` and `reload()` so a reload restates the full option
   * set — `development`, and the current WebSocket handler — rather than a
   * subset. Bun carries a previously installed WebSocket handler across a
   * reload that omits one, so this matters when the configuration has
   * *changed*: a swapped handler takes effect instead of the stale one
   * continuing to serve.
   */
  private buildServeOptions(): {
    port: number;
    hostname: string;
    development: boolean | undefined;
    fetch: (request: Request) => Promise<Response | undefined>;
    websocket?: ReturnType<WebSocketHandler['getWebSocketConfig']>;
  } {
    const websocket = this.config.websocket?.getWebSocketConfig();

    return {
      port: this.config.port ?? 4000,
      hostname: this.config.hostname ?? '0.0.0.0',
      development: this.config.development,
      fetch: (request: Request) => this.handleRequest(request),
      ...(websocket ? { websocket } : {}),
    };
  }

  /**
   * Start the server
   */
  public start(): ServerInfo {
    const options = this.buildServeOptions();
    const { port, hostname } = options;

    this.server = Bun.serve(
      options as unknown as Parameters<typeof Bun.serve>[0]
    ) as unknown as Server<unknown>;

    const actualPort = this.server.port ?? port;
    const actualHostname = this.server.hostname ?? hostname;

    const info: ServerInfo = {
      port: actualPort,
      hostname: actualHostname,
      url: `http://${actualHostname === '0.0.0.0' ? 'localhost' : actualHostname}:${actualPort}${this.path}`,
    };

    this.config.onStart?.(this.server);

    return info;
  }

  /**
   * Stop the server
   */
  public stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.config.onStop?.();
    }
  }

  /**
   * Get the underlying Bun server
   */
  public getServer(): Server<unknown> | null {
    return this.server;
  }

  /**
   * Check if the server is running
   */
  public isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Reload the server (for development)
   */
  public reload(): void {
    if (this.server) {
      this.server.reload(
        this.buildServeOptions() as unknown as Parameters<
          Server<unknown>['reload']
        >[0]
      );
    }
  }
}

/**
 * Create a Leaven GraphQL server (call `.start()` to begin listening)
 */
export function createServer<TContext = unknown>(
  config: ServerConfig<TContext>
): LeavenServer {
  return new LeavenServer(config as ServerConfig);
}
