/**
 * @leaven-graphql/ws - Logger interface
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/**
 * Destination for the diagnostics the WebSocket transport emits: failing
 * hooks, subscriber callbacks and subscription timeouts. Defaults to
 * `console`. `warn` is optional; without it, warnings go to `error`.
 */
export interface WebSocketLogger {
  error(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

/**
 * Emit a warning, falling back to `error` when the logger has no `warn`.
 */
export function logWarning(logger: WebSocketLogger, ...args: unknown[]): void {
  if (logger.warn) {
    logger.warn(...args);
  } else {
    logger.error(...args);
  }
}
