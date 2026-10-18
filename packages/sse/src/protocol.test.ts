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
  test('should split the payload on CRLF and lone CR as well as LF', () => {
    expect(formatSSEEvent('x', 'a\r\nb\rc\nd')).toBe(
      'event: x\ndata: a\ndata: b\ndata: c\ndata: d\n\n'
    );
  });
  test.each(['bad\nevent', 'bad\revent', 'bad\r\nevent'])(
    'should throw a TypeError for an event name containing a line break (%p)',
    (event) => {
      expect(() => formatSSEEvent(event, 'x')).toThrow(TypeError);
    }
  );
});

test('formatNextEvent should JSON-encode the result', () => {
  expect(formatNextEvent({ data: { hello: 'world' } })).toBe(
    'event: next\ndata: {"data":{"hello":"world"}}\n\n'
  );
});

test('formatNextEvent should encode an undefined result as null', () => {
  expect(formatNextEvent(undefined)).toBe('event: next\ndata: null\n\n');
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

  test('should clamp q values to the range 0 to 1', () => {
    // q=5 clamps to 1, so it ties with JSON instead of outranking it
    expect(acceptsEventStream('text/event-stream;q=5, application/json')).toBe(true);
    expect(acceptsEventStream('text/event-stream, application/json;q=5')).toBe(true);
    expect(acceptsEventStream('text/event-stream;q=0.9, application/json;q=5')).toBe(false);
    // a negative q clamps to 0: not acceptable
    expect(acceptsEventStream('text/event-stream;q=-1')).toBe(false);
    expect(acceptsEventStream('text/event-stream;q=0.1, application/json;q=-3')).toBe(true);
  });
});

test('SSE_HEADERS should carry the streaming headers', () => {
  expect(SSE_HEADERS).toEqual({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
  });
});
