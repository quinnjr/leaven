/**
 * @leaven-graphql/sse - graphql-sse protocol encoding and negotiation
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/** Content type of a graphql-sse response */
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/** Headers sent with every successful event-stream response */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': SSE_CONTENT_TYPE,
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Content-Encoding': 'none',
});

/** Keep-alive comment frame */
export const SSE_KEEP_ALIVE = ':\n\n';

/** Default keep-alive interval in milliseconds (below Bun's 10 s idleTimeout) */
export const DEFAULT_KEEP_ALIVE_INTERVAL = 8000;

/**
 * Frame a named server-sent event
 *
 * @param event - The event name; must not contain CR or LF
 * @param data - The payload; one `data:` field is emitted per line (lines end
 *   at CRLF, CR or LF, as the SSE parser splits them)
 * @returns The encoded event
 * @throws TypeError when `event` contains a line break, which would let it
 *   inject fields or events into the stream
 */
export function formatSSEEvent(event: string, data: string): string {
  if (/[\r\n]/.test(event)) {
    throw new TypeError('SSE event name must not contain CR or LF');
  }
  const lines =
    data === ''
      ? 'data:'
      : data
          .split(/\r\n|\r|\n/)
          .map((line) => `data: ${line}`)
          .join('\n');
  return `event: ${event}\n${lines}\n\n`;
}

/**
 * Encode a `next` event carrying a JSON-encoded execution result
 *
 * @param result - The execution result (`undefined` is encoded as `null`)
 * @returns The encoded event
 */
export function formatNextEvent(result: unknown): string {
  return formatSSEEvent('next', JSON.stringify(result ?? null));
}

/**
 * Encode the `complete` event
 *
 * @returns The encoded event
 */
export function formatCompleteEvent(): string {
  return formatSSEEvent('complete', '');
}

const JSON_TYPES = new Set(['application/json', 'application/graphql-response+json']);

function parseQuality(params: string[]): number {
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (param.slice(0, eq).trim().toLowerCase() === 'q') {
      const q = Number(param.slice(eq + 1).trim());
      // RFC 9110 bounds q to [0, 1]; clamp so q=5 cannot outrank a plain range
      return Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 0;
    }
  }
  return 1;
}

/**
 * Decide whether a client asked for an event stream
 *
 * Only the exact range `text/event-stream` counts; wildcards never opt in.
 * The stream wins when its quality is above zero and at least that of the
 * best-matching JSON range (exact or wildcard).
 *
 * @param input - A request, an Accept header value, or nothing
 * @returns True when the event stream should be served
 */
export function acceptsEventStream(input: Request | string | null | undefined): boolean {
  const accept = typeof input === 'string' ? input : (input?.headers.get('accept') ?? '');
  let sse = 0;
  let json = 0;
  for (const range of accept.split(',')) {
    const [rawType, ...params] = range.split(';');
    const type = (rawType ?? '').trim().toLowerCase();
    const q = parseQuality(params);
    if (type === 'text/event-stream') {
      sse = Math.max(sse, q);
    } else if (JSON_TYPES.has(type) || type === 'application/*' || type === '*/*') {
      json = Math.max(json, q);
    }
  }
  return sse > 0 && sse >= json;
}
