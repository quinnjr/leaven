/**
 * @leaven-graphql/sse - Event stream from an executor result
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { GraphQLFormattedError } from 'graphql';
import type { GraphQLResponse, SubscriptionIterator } from '@leaven-graphql/core';
import { formatError as formatLeavenError } from '@leaven-graphql/errors';
import {
  DEFAULT_KEEP_ALIVE_INTERVAL,
  SSE_HEADERS,
  SSE_KEEP_ALIVE,
  formatCompleteEvent,
  formatNextEvent,
} from './protocol';

/** What an executor hands back: a single response or a subscription iterator */
export type EventStreamSource<TData = Record<string, unknown>> =
  | GraphQLResponse<TData>
  | SubscriptionIterator<TData>;

/** Options for {@link createEventStream} */
export interface EventStreamOptions<TData = Record<string, unknown>> {
  /** Aborting this signal ends the stream and returns the iterator */
  signal?: AbortSignal;
  /** Keep-alive comment interval in ms (default DEFAULT_KEEP_ALIVE_INTERVAL; 0 disables) */
  keepAliveInterval?: number;
  /**
   * Transform each result before it is JSON-encoded (default identity).
   *
   * `result.errors` are already `GraphQLFormattedError`s, not `GraphQLError`s:
   * to mask them, use {@link formatResultErrors}, which rebuilds each one
   * first so intentional errors keep their code and `path`.
   */
  formatResult?: (result: GraphQLResponse<TData>) => unknown | Promise<unknown>;
  /** Format an error thrown by the iterator or formatResult (default: masked formatError) */
  formatError?: (error: unknown) => GraphQLFormattedError;
  /** Called exactly once, however the stream ends */
  onClose?: () => void;
}

/** Options for {@link createEventStreamResponse} */
export interface EventStreamResponseOptions<TData = Record<string, unknown>>
  extends EventStreamOptions<TData> {
  /** Extra response headers, merged over the SSE headers */
  headers?: Record<string, string>;
}

/**
 * Tell a subscription iterator apart from a single response
 *
 * @param source - The executor result
 * @returns True when the source is an async iterator
 */
export function isSubscriptionIterator<TData>(
  source: EventStreamSource<TData>
): source is SubscriptionIterator<TData> {
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as Partial<SubscriptionIterator<TData>>)[Symbol.asyncIterator] === 'function'
  );
}

function defaultFormatError(error: unknown): GraphQLFormattedError {
  return formatLeavenError(error, { maskErrors: true });
}

const FALLBACK_ERROR: GraphQLFormattedError = Object.freeze({
  message: 'An unexpected error occurred',
});

/**
 * Encode an executor result as a graphql-sse event stream
 *
 * Each result becomes a `next` event, followed by one `complete` event. An
 * error thrown by the iterator or by `formatResult` is sent as a `next` event
 * carrying `{ errors: [formatError(error)] }`, then the stream completes. An
 * abort, a consumer cancel, or a failure to format or enqueue ends the stream
 * early and calls `iterator.return()`.
 *
 * The stream honours backpressure: the iterator is not advanced, and
 * keep-alive ticks are skipped, while the consumer's queue is full.
 *
 * @param source - A single response or a subscription iterator
 * @param options - Stream options
 * @returns A byte stream of server-sent events
 */
export function createEventStream<TData = Record<string, unknown>>(
  source: EventStreamSource<TData>,
  options: EventStreamOptions<TData> = {}
): ReadableStream<Uint8Array> {
  const {
    signal,
    keepAliveInterval = DEFAULT_KEEP_ALIVE_INTERVAL,
    formatResult = (result: GraphQLResponse<TData>): unknown => result,
    formatError = defaultFormatError,
    onClose,
  } = options;
  const iterator = isSubscriptionIterator(source) ? source : undefined;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resumePump: (() => void) | undefined;
  let closed = false;
  let iteratorFinished = false;

  const hasDemand = (): boolean => (controller?.desiredSize ?? 0) > 0;

  /** Release a pump waiting for demand (called by pull and close) */
  const wake = (): void => {
    const resume = resumePump;
    resumePump = undefined;
    resume?.();
  };

  const waitForDemand = (): Promise<void> => {
    if (closed || hasDemand()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      resumePump = resolve;
    });
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
    signal?.removeEventListener('abort', close);
    wake();
    if (iterator && !iteratorFinished) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // A throwing return() must not block teardown
      }
    }
    try {
      controller?.close();
    } catch {
      // Already closed or cancelled by the consumer
    }
    try {
      onClose?.();
    } catch {
      // close() runs from abort listeners, timers and cancel(); user code must not escape
    }
  };

  const send = (chunk: string): void => {
    if (closed) {
      return;
    }
    try {
      controller?.enqueue(encoder.encode(chunk));
    } catch {
      // enqueue throws if the consumer tore the stream down before close() ran
      close();
    }
  };

  const sendError = (error: unknown): void => {
    if (closed) {
      return;
    }
    let formatted: GraphQLFormattedError;
    try {
      formatted = formatError(error);
    } catch {
      formatted = FALLBACK_ERROR;
    }
    send(formatNextEvent({ errors: [formatted] }));
  };

  /** Send one result; false when the stream must complete now. Callers check `closed` first. */
  const emit = async (result: GraphQLResponse<TData>): Promise<boolean> => {
    try {
      const formatted = await formatResult(result);
      if (closed) {
        return false;
      }
      send(formatNextEvent(formatted));
    } catch (error) {
      sendError(error);
      return false;
    }
    return !closed;
  };

  const finish = (): void => {
    send(formatCompleteEvent());
    close();
  };

  const pump = async (): Promise<void> => {
    if (!iterator) {
      await emit(source as GraphQLResponse<TData>);
      finish();
      return;
    }
    for (;;) {
      await waitForDemand();
      if (closed) {
        return;
      }
      let step: IteratorResult<GraphQLResponse<TData>>;
      try {
        step = await iterator.next();
      } catch (error) {
        iteratorFinished = true;
        sendError(error);
        finish();
        return;
      }
      if (closed) {
        return;
      }
      if (step.done) {
        iteratorFinished = true;
        finish();
        return;
      }
      if (!(await emit(step.value))) {
        finish();
        return;
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(streamController): void {
      controller = streamController;
      if (signal?.aborted) {
        close();
        return;
      }
      signal?.addEventListener('abort', close, { once: true });
      if (keepAliveInterval > 0) {
        timer = setInterval(() => {
          if (hasDemand()) {
            send(SSE_KEEP_ALIVE);
          }
        }, keepAliveInterval);
      }
      void pump().catch(close);
    },
    pull(): void {
      wake();
    },
    cancel(): void {
      close();
    },
  });
}

/**
 * Wrap an executor result in a `200` event-stream response
 *
 * @param source - A single response or a subscription iterator
 * @param options - Stream options plus extra headers
 * @returns The streaming response
 */
export function createEventStreamResponse<TData = Record<string, unknown>>(
  source: EventStreamSource<TData>,
  options: EventStreamResponseOptions<TData> = {}
): Response {
  const { headers, ...streamOptions } = options;
  const responseHeaders = new Headers(SSE_HEADERS);
  for (const [name, value] of Object.entries(headers ?? {})) {
    responseHeaders.set(name, value);
  }
  return new Response(createEventStream(source, streamOptions), {
    status: 200,
    headers: responseHeaders,
  });
}
