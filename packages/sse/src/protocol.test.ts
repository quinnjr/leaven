/**
 * @leaven-graphql/sse - graphql-sse protocol tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  SSE_HEADERS,
  formatSSEEvent,
  formatNextEvent,
  formatCompleteEvent,
  acceptsEventStream,
} from './protocol';

describe('formatSSEEvent', () => {
  test('should frame a single-line payload', () => {
    expect(formatSSEEvent('next', '{"a":1}')).toBe('event: next\ndata: {"a":1}\n\n');
  });
  test('should emit one data line per payload line', () => {
    expect(formatSSEEvent('x', 'a\nb')).toBe('event: x\ndata: a\ndata: b\n\n');
  });
  test('should emit a bare data field for an empty payload', () => {
    expect(formatSSEEvent('complete', '')).toBe('event: complete\ndata:\n\n');
  });
});

test('formatNextEvent should JSON-encode the result', () => {
  expect(formatNextEvent({ data: { hello: 'world' } })).toBe(
    'event: next\ndata: {"data":{"hello":"world"}}\n\n'
  );
});

test('formatCompleteEvent should match the graphql-sse complete frame', () => {
  expect(formatCompleteEvent()).toBe('event: complete\ndata:\n\n');
});

describe('acceptsEventStream', () => {
  test.each([
    ['text/event-stream', true],
    ['text/event-stream; charset=utf-8', true],
    ['application/json, text/event-stream', true],
    ['text/event-stream;q=0.5, application/json', false],
    ['text/event-stream;q=0', false],
    ['*/*', false],
    ['application/json, */*', false],
    ['text/*', false],
    ['', false],
  ])('should return for %p -> %p', (accept, expected) => {
    expect(acceptsEventStream(accept)).toBe(expected);
  });

  test('should read the Accept header from a Request', () => {
    const req = new Request('http://x/graphql', { headers: { accept: 'text/event-stream' } });
    expect(acceptsEventStream(req)).toBe(true);
    expect(acceptsEventStream(null)).toBe(false);
  });

  test('should treat a non-finite q as zero and params case-insensitively', () => {
    expect(acceptsEventStream('TEXT/EVENT-STREAM;Q=abc')).toBe(false);
    expect(acceptsEventStream('Text/Event-Stream;Q=0.9, application/json;q=0.5')).toBe(true);
    expect(acceptsEventStream('text/event-stream;q=0.5, application/graphql-response+json')).toBe(
      false
    );
    expect(acceptsEventStream('text/event-stream;q=0.5, */*;q=0.1')).toBe(true);
  });
});

test('SSE_HEADERS should carry the streaming headers', () => {
  expect(SSE_HEADERS).toEqual({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
});
