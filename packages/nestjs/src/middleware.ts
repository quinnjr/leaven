/**
 * @leaven-graphql/nestjs - Middleware
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  Injectable,
  type NestMiddleware,
  Inject,
  type Type,
} from '@nestjs/common';
import {
  isLeavenError,
  statusForResponse,
} from '@leaven-graphql/errors';
import { renderGraphiQL } from '@leaven-graphql/playground';
import type { GqlContext } from './types';
// Express types for NestJS middleware compatibility
interface Request {
  method: string;
  path: string;
  /** Full URL including the query string, as populated by Express */
  originalUrl?: string;
  url?: string;
  secure?: boolean;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface Response {
  status(code: number): Response;
  json(body: unknown): Response;
  send(body: unknown): Response;
  setHeader(name: string, value: string): Response;
  end(): Response;
}

type NextFunction = () => void;
import { LEAVEN_DRIVER, LEAVEN_MODULE_OPTIONS } from './module';
import { LeavenDriver } from './driver';
import { normalizeHttpException } from './http-exception';
import {
  csrfBlockedError,
  isCsrfBlocked,
  readHeader,
  resolveCsrfRequestHeaders,
  validateGraphQLBody,
} from './request-body';
import type { CorsOptions, LeavenModuleOptions } from './types';

/**
 * A `Host` header safe to interpolate into a URL: a hostname (or IPv4
 * literal) with an optional port, and nothing else. Anything containing
 * userinfo, a path, whitespace, or other authority metacharacters is
 * rejected rather than trusted.
 */
const VALID_HOST = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * `Request` members that read or depend on the body. Accessing any of them on
 * the request handed to a context factory materializes the serialized body.
 */
const BODY_MEMBERS: ReadonlySet<string> = new Set([
  'body',
  'bodyUsed',
  'json',
  'text',
  'arrayBuffer',
  'blob',
  'bytes',
  'formData',
  'clone',
]);

/**
 * GraphQL middleware for handling GraphQL requests
 *
 * This middleware intercepts requests to the GraphQL endpoint
 * and processes them through the Leaven driver.
 *
 * ## Scope of the transport this middleware implements
 *
 * It calls {@link LeavenDriver.execute} directly and deliberately does NOT go
 * through {@link LeavenDriver.handleRequest}, which is an alternative
 * Fetch-native entry point for callers that already hold a `Request`/`Response`
 * pair (a Bun `fetch` handler, for example). Two consequences follow, and both
 * are intentional rather than oversights:
 *
 * - Only `POST` with a JSON body is served. `GET ?query=` is reserved for the
 *   playground, and `application/graphql` bodies — which `handleRequest`'s
 *   parser does support — are not accepted here.
 * - The context's `req`/`res` are the **Express** request and response, not the
 *   Fetch `Request`/`Response` that `handleRequest` stores. This is what makes
 *   `ctx.req.user` work under Passport. See {@link GqlContext} for the full
 *   contract; a resolver that must work behind either entry point should read
 *   values placed on the context by the `context` factory rather than reaching
 *   into `ctx.req`.
 */
@Injectable()
export class GraphQLMiddleware implements NestMiddleware {
  /**
   * Header names that satisfy CSRF prevention, or `undefined` when
   * `csrfPrevention` is `false`. Resolved (and validated) at construction.
   */
  private readonly csrfRequestHeaders: readonly string[] | undefined;

  constructor(
    @Inject(LEAVEN_DRIVER) private readonly driver: LeavenDriver,
    @Inject(LEAVEN_MODULE_OPTIONS) private readonly options: LeavenModuleOptions
  ) {
    this.csrfRequestHeaders = resolveCsrfRequestHeaders(options.csrfPrevention);
  }

  /**
   * Handle incoming requests
   */
  public async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = this.driver.getPath();

    // Only handle requests to the GraphQL endpoint
    if (!req.path.endsWith(path)) {
      return next();
    }

    // Handle GET requests for playground
    if (req.method === 'GET' && this.driver.isPlaygroundEnabled()) {
      this.servePlayground(res);
      return;
    }

    // Handle POST requests for GraphQL queries
    if (req.method === 'POST') {
      await this.handleGraphQLRequest(req, res);
      return;
    }

    // Handle OPTIONS for CORS preflight
    if (req.method === 'OPTIONS') {
      if (this.resolveCorsOptions() === null) {
        // CORS handling is not enabled — let the application handle the request
        return next();
      }
      this.handleCorsPreFlight(req, res);
      return;
    }

    next();
  }

  /**
   * Handle GraphQL request
   */
  private async handleGraphQLRequest(req: Request, res: Response): Promise<void> {
    // Browsers require CORS headers on the actual response, not just the
    // preflight, so apply them here as well
    this.applyCorsHeaders(req, res);

    try {
      // CSRF prevention runs before the body is looked at or the context
      // factory runs, whatever shape the body parser left `req.body` in:
      // NestJS's Express adapter parses `application/x-www-form-urlencoded`
      // by default, so a cross-site HTML form POST arrives as an object.
      if (
        this.csrfRequestHeaders !== undefined &&
        isCsrfBlocked(
          readHeader(req.headers, 'content-type'),
          (name) => readHeader(req.headers, name),
          this.csrfRequestHeaders
        )
      ) {
        throw csrfBlockedError();
      }

      // No body at all (no body-parser installed, or an empty POST) is a
      // missing query rather than a malformed body.
      const { query, variables, operationName } = validateGraphQLBody(
        req.body === undefined ? {} : req.body
      );

      // Create context with request info. `req`/`res` are the Express objects
      // this middleware was handed — NOT the Fetch pair `driver.handleRequest`
      // would store — because that is what carries Passport's `req.user`. The
      // context factory still receives an adapted Fetch `Request` (see
      // `toFetchRequest`), so the two entry points agree on the factory's
      // contract even though they disagree on `ctx.req`.
      const context = {
        req,
        res,
        ...(this.options.context
          ? await this.options.context(
              this.toFetchRequest(req),
              res as unknown as globalThis.Response
            )
          : {}),
      };

      const result = await this.driver.execute(
        query,
        variables,
        context as unknown as GqlContext,
        operationName
      );

      // A response with non-null `data` is a partial success and stays 200
      // whatever the error codes say; only a total failure (`data` absent or
      // `null`) derives its status from the first error's code via
      // `ERROR_CODES`, exactly as `LeavenGraphQLDriver` does.
      res.status(statusForResponse(result)).json(result);
    } catch (thrown) {
      // Format through the driver so the middleware agrees with every other
      // path: production masking, stack-trace opt-in, and the user's
      // `formatError` hook applied exactly once. A Leaven error keeps its own
      // status — a NestJS `HttpException` is normalised to one first, so a
      // context factory's `UnauthorizedException` answers 401 — and anything
      // else derives it from the formatted error's code.
      const error = normalizeHttpException(thrown);
      const formattedError = this.driver.formatThrownError(error);

      res
        .status(
          isLeavenError(error)
            ? error.statusCode
            : statusForResponse({ errors: [formattedError] })
        )
        .json({ errors: [formattedError] });
    }
  }

  /**
   * Serve GraphiQL HTML
   *
   * Delegates to `@leaven-graphql/playground`, which owns the template and
   * its escaping, rather than maintaining a second copy here.
   */
  private servePlayground(res: Response): void {
    const html = renderGraphiQL({ endpoint: this.driver.getPath() });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }

  /**
   * Handle CORS preflight request
   */
  private handleCorsPreFlight(req: Request, res: Response): void {
    this.applyCorsHeaders(req, res);
    res.status(204).end();
  }

  /**
   * Resolve the effective CORS configuration, or `null` when this middleware
   * must not emit CORS headers at all.
   *
   * CORS is **opt-in**, matching the `cors` option's documented "Enable CORS"
   * semantics: leaving it unset emits no `Access-Control-*` headers and leaves
   * `OPTIONS` preflights to the application. Only an explicit `true` (or an
   * options object) turns it on — a stock `LeavenModule.forRoot({ schema })`
   * must never answer every GraphQL POST with `Access-Control-Allow-Origin: *`.
   * `false` is equivalent to unset and is accepted for explicitness.
   */
  private resolveCorsOptions(): CorsOptions | null {
    const corsOptions = this.options.cors;

    if (corsOptions === undefined || corsOptions === false) {
      return null;
    }

    return corsOptions === true ? {} : corsOptions;
  }

  /**
   * Apply CORS headers to a response
   *
   * Called for both preflight (OPTIONS) responses and actual GraphQL
   * responses — browsers require `Access-Control-Allow-Origin` on the
   * actual response as well as the preflight. No-op when CORS was not
   * enabled (see {@link resolveCorsOptions}).
   *
   * The allowed origin is *reflected*, never defaulted to `*` when an
   * allowlist is configured: `origin: false` emits no origin header at all,
   * an array emits the request's `Origin` only when the allowlist contains
   * it, and `origin: true` echoes the request's `Origin` only without
   * `credentials`: with `credentials: true`, a wildcard (`true`, `'*'` or no
   * `origin`) emits neither the origin nor the credentials header (see
   * {@link resolveAllowedOrigin}). `Vary: Origin` is emitted whenever the
   * value depends on the request so caches cannot serve one origin's response
   * to another.
   *
   * Twin of `corsHeaders` in `packages/http/src/response.ts`: this method and
   * {@link resolveAllowedOrigin} together are the nestjs side of the CORS
   * emission, and must stay in step with it.
   */
  private applyCorsHeaders(req: Request, res: Response): void {
    const options = this.resolveCorsOptions();

    if (options === null) {
      return;
    }

    const requestOrigin = readHeader(req.headers, 'origin');
    const allowOrigin = this.resolveAllowedOrigin(options, requestOrigin);

    if (allowOrigin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    }
    // The emitted origin depends on the request unless it is the literal '*'.
    if (allowOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      Array.isArray(options.methods)
        ? options.methods.join(', ')
        : options.methods ?? 'GET, POST, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      Array.isArray(options.allowedHeaders)
        ? options.allowedHeaders.join(', ')
        : options.allowedHeaders ?? this.defaultAllowedHeaders()
    );

    if (options.exposedHeaders) {
      res.setHeader(
        'Access-Control-Expose-Headers',
        Array.isArray(options.exposedHeaders)
          ? options.exposedHeaders.join(', ')
          : options.exposedHeaders
      );
    }

    // Credentials are only ever paired with an origin that passed an explicit
    // string or allowlist check (see resolveAllowedOrigin).
    if (options.credentials && allowOrigin !== undefined) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (options.maxAge) {
      res.setHeader('Access-Control-Max-Age', String(options.maxAge));
    }
  }

  /**
   * The default `Access-Control-Allow-Headers`, used when `allowedHeaders`
   * is not configured: `Content-Type`, `Authorization` and, while CSRF
   * prevention is on, its configured header names, so a cross-origin client
   * can send the header the check asks for.
   *
   * Twin of the CSRF-inclusive default allow-headers that `createHandler` in
   * `packages/http/src/handler.ts` builds: the two must stay in step.
   */
  private defaultAllowedHeaders(): string {
    return ['Content-Type', 'Authorization', ...(this.csrfRequestHeaders ?? [])].join(', ');
  }

  /**
   * Resolve the `Access-Control-Allow-Origin` value for a request
   *
   * Returns `undefined` to mean "emit no origin header". Only an origin that
   * passed an explicit string or allowlist check is ever paired with
   * credentials: a credentialed response cannot use the `*` wildcard, and
   * echoing the request `Origin` in its place would let any site make
   * credentialed reads. So with `credentials` and a wildcard origin (`cors:
   * true`, `origin: true`, `origin: '*'`, or an omitted `origin`), no origin is
   * emitted at all, and the caller then omits the credentials header too.
   *
   * Twin of `corsHeaders` in `packages/http/src/response.ts` (with
   * {@link applyCorsHeaders}, which emits the headers): the CORS origin rules
   * must stay in step between the two.
   */
  private resolveAllowedOrigin(
    options: CorsOptions,
    requestOrigin: string | undefined
  ): string | undefined {
    const { origin, credentials } = options;

    // Explicitly deny cross-origin access
    if (origin === false) {
      return undefined;
    }

    // Allowlist: reflect the request origin only when it is on the list
    if (Array.isArray(origin)) {
      return requestOrigin !== undefined && origin.includes(requestOrigin)
        ? requestOrigin
        : undefined;
    }

    // A concrete origin is echoed verbatim
    if (typeof origin === 'string' && origin !== '*') {
      return origin;
    }

    // Wildcard: no explicit check narrowed the origin, so it can never be
    // combined with credentials.
    if (credentials) {
      return undefined;
    }

    if (origin === true) {
      return requestOrigin ?? '*';
    }

    return '*';
  }

  /**
   * Adapt an Express-style request into a Fetch API `Request`
   *
   * The body is serialized only when the factory reads it (see
   * {@link BODY_MEMBERS}); headers, URL and method cost no serialization.
   *
   * The `ContextFactory` contract (types.ts) is declared against the global
   * Fetch API types, and `driver.createContext` passes genuine Fetch objects.
   * Adapting here keeps that contract intact **for the factory's first
   * parameter only**, so factories may call `request.headers.get()`,
   * `request.json()`, or read `request.url` regardless of how the request
   * arrived.
   *
   * The factory's second parameter is NOT adapted: it is the transport-native
   * response object, which under this middleware is the Express response.
   * `response.status(...)` is therefore a method rather than a number and
   * `response.headers` does not exist — use `response.setHeader(name, value)`
   * when writing a factory that must work behind `GraphQLMiddleware`.
   *
   * The URL's authority is never taken from an untrusted `Host` header
   * unchecked: `options.publicUrl` wins when configured, otherwise `Host` is
   * accepted only if it looks like a plain authority, and anything else falls
   * back to the canonical default. A factory resolving tenancy from
   * `new URL(request.url).hostname` therefore cannot be steered by a
   * spoofed header, and a hostile value cannot make `new Request()` throw
   * and turn every request into a 500.
   */
  private toFetchRequest(req: Request): globalThis.Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          headers.append(name, entry);
        }
      } else {
        headers.set(name, value);
      }
    }

    // `req.path` drops the query string; `originalUrl` keeps it, so a factory
    // reading `request.url` sees the same URL the driver would have built.
    const path = req.originalUrl ?? req.url ?? req.path;
    const url = `${this.resolveOrigin(req)}${path}`;

    const hasBody =
      req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD';
    if (hasBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const build = (init: RequestInit): globalThis.Request => {
      try {
        return new globalThis.Request(url, init);
      } catch {
        // A path that cannot be parsed as a URL must not take the request down
        return new globalThis.Request(
          `${this.canonicalOrigin(req)}${this.driver.getPath()}`,
          init
        );
      }
    };

    const bodiless = build({ method: req.method, headers });
    if (!hasBody) {
      return bodiless;
    }

    // The body is serialized lazily: most factories only read headers or the
    // URL, so `JSON.stringify(req.body)` runs only when a body member is
    // touched. Every other member is served by the bodiless request.
    //
    // The body members are own properties defined on the bodiless request
    // itself, not a Proxy around it: Bun treats a Proxy-wrapped Request as a
    // plain object in `new Request(proxy, init)`, dropping its method and
    // body. A real instance keeps the Request brand, and Bun's constructor
    // reads `body` through the property, so the copy carries the body.
    let withBody: globalThis.Request | undefined;
    const body = (): globalThis.Request =>
      (withBody ??= build({ method: req.method, headers, body: JSON.stringify(req.body) }));

    for (const member of BODY_MEMBERS) {
      const value: unknown = Reflect.get(bodiless, member);
      Object.defineProperty(
        bodiless,
        member,
        typeof value === 'function'
          ? {
              configurable: true,
              value: (...args: unknown[]): unknown => {
                const source = body();
                return (Reflect.get(source, member) as (...a: unknown[]) => unknown).apply(
                  source,
                  args
                );
              },
            }
          : { configurable: true, get: (): unknown => Reflect.get(body(), member) }
      );
    }

    return bodiless;
  }

  /**
   * Resolve the origin (scheme + authority) for the synthesized request URL
   *
   * A configured `publicUrl` always wins; otherwise the `Host` header is used
   * only when it is a plain authority, and anything else falls back to the
   * canonical origin.
   */
  private resolveOrigin(req: Request): string {
    if (this.options.publicUrl) {
      return this.canonicalOrigin(req);
    }

    const host = readHeader(req.headers, 'host');
    if (host !== undefined && VALID_HOST.test(host)) {
      return `${req.secure ? 'https' : 'http'}://${host}`;
    }

    return this.canonicalOrigin(req);
  }

  /**
   * The trusted origin used when no configured or trustworthy authority is
   * available
   */
  private canonicalOrigin(req: Request): string {
    return this.options.publicUrl?.replace(/\/+$/, '')
      ?? (req.secure ? 'https://localhost' : 'http://localhost');
  }
}

/**
 * Create middleware module with proper configuration
 */
export function createGraphQLMiddleware(): Type<NestMiddleware> {
  return GraphQLMiddleware;
}
