/**
 * @leaven-graphql/sse - Event stream tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import type { GraphQLResponse, SubscriptionIterator } from '@leaven-graphql/core';
import { formatCompleteEvent, formatNextEvent, SSE_KEEP_ALIVE } from './protocol';
import {
  createEventStream,
  createEventStreamResponse,
  isSubscriptionIterator,
} from './stream';

type Result = GraphQLResponse<Record<string, unknown>>;

const decoder = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return out;
    }
    out += decoder.decode(value, { stream: true });
  }
}

interface ManualIterator extends SubscriptionIterator<Record<string, unknown>> {
  returnCalls: number;
}

function iteratorOf(values: Result[], options: { onReturn?: () => void } = {}): ManualIterator {
  let index = 0;
  const iterator: ManualIterator = {
    returnCalls: 0,
    next: async () => {
      if (index < values.length) {
        return { done: false, value: values[index++] as Result };
      }
      return { done: true, value: undefined };
    },
    return: async () => {
      iterator.returnCalls++;
      options.onReturn?.();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

/** Yields `first` values, then a `next()` that stays pending until `return()` */
function pendingIterator(first: Result[] = []): ManualIterator {
  let index = 0;
  let release: ((r: IteratorResult<Result>) => void) | undefined;
  const iterator: ManualIterator = {
    returnCalls: 0,
    next: () => {
      if (index < first.length) {
        return Promise.resolve({ done: false, value: first[index++] as Result });
      }
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    return: async () => {
      iterator.returnCalls++;
      release?.({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

function throwingIterator(): ManualIterator {
  const iterator = iteratorOf([]);
  iterator.next = async () => {
    throw new Error('db password leaked');
  };
  return iterator;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('isSubscriptionIterator', () => {
  test('should recognise an async iterator', () => {
    expect(isSubscriptionIterator(iteratorOf([]))).toBe(true);
  });
  test('should reject a plain response', () => {
    expect(isSubscriptionIterator({ data: {} })).toBe(false);
  });
});

describe('createEventStream', () => {
  test('should emit one next and complete for a single response', async () => {
    expect(await readAll(createEventStream({ data: { a: 1 } }))).toBe(
      'event: next\ndata: {"data":{"a":1}}\n\nevent: complete\ndata:\n\n'
    );
  });

  test('should emit a next per iterator value then complete', async () => {
    const iterator = iteratorOf([{ data: { n: 1 } }, { data: { n: 2 } }]);
    const out = await readAll(createEventStream(iterator));
    expect(out).toBe(
      formatNextEvent({ data: { n: 1 } }) + formatNextEvent({ data: { n: 2 } }) + formatCompleteEvent()
    );
    expect(iterator.returnCalls).toBe(0);
  });

  test('should pass each result through formatResult', async () => {
    const out = await readAll(
      createEventStream({ data: { a: 1 } }, { formatResult: () => ({ masked: true }) })
    );
    expect(out.startsWith('event: next\ndata: {"masked":true}\n\n')).toBe(true);
  });

  test('should await an async formatResult', async () => {
    const out = await readAll(
      createEventStream(iteratorOf([{ data: { n: 1 } }]), {
        formatResult: async (result) => ({ wrapped: result.data }),
      })
    );
    expect(out).toBe(formatNextEvent({ wrapped: { n: 1 } }) + formatCompleteEvent());
  });

  test('should send a masked error then complete when the iterator throws', async () => {
    const iterator = throwingIterator();
    const out = await readAll(createEventStream(iterator));
    expect(out).toContain('event: next');
    expect(out).not.toContain('db password leaked');
    expect(out.endsWith(formatCompleteEvent())).toBe(true);
    expect(iterator.returnCalls).toBe(0);
  });

  test('should use a custom formatError for iterator errors', async () => {
    const out = await readAll(
      createEventStream(throwingIterator(), { formatError: () => ({ message: 'custom' }) })
    );
    expect(out).toBe(formatNextEvent({ errors: [{ message: 'custom' }] }) + formatCompleteEvent());
  });

  test('should send an error, complete and call return when formatResult throws', async () => {
    const iterator = iteratorOf([{ data: { n: 1 } }, { data: { n: 2 } }]);
    const out = await readAll(
      createEventStream(iterator, {
        formatResult: () => {
          throw new Error('secret formatter failure');
        },
      })
    );
    expect(out).not.toContain('secret formatter failure');
    expect(out.startsWith('event: next\ndata: {"errors":[')).toBe(true);
    expect(out.endsWith(formatCompleteEvent())).toBe(true);
    expect(out.match(/event: next/g)?.length).toBe(1);
    expect(iterator.returnCalls).toBe(1);
  });

  test('should send an error then complete when formatResult rejects for a single response', async () => {
    const out = await readAll(
      createEventStream({ data: {} }, { formatResult: () => Promise.reject(new Error('nope')) })
    );
    expect(out).not.toContain('nope');
    expect(out.endsWith(formatCompleteEvent())).toBe(true);
  });

  test('should call iterator.return and onClose once when the signal aborts', async () => {
    const iterator = pendingIterator([{ data: { n: 1 } }]);
    const controller = new AbortController();
    let closes = 0;
    const stream = createEventStream(iterator, {
      signal: controller.signal,
      keepAliveInterval: 0,
      onClose: () => closes++,
    });
    const reader = stream.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(formatNextEvent({ data: { n: 1 } }));
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    expect(iterator.returnCalls).toBe(1);
    expect(closes).toBe(1);
  });

  test('should call iterator.return when the consumer cancels the stream', async () => {
    const iterator = pendingIterator();
    let closes = 0;
    const stream = createEventStream(iterator, { keepAliveInterval: 0, onClose: () => closes++ });
    await stream.getReader().cancel();
    expect(iterator.returnCalls).toBe(1);
    expect(closes).toBe(1);
  });

  test('should ignore a rejecting iterator.return', async () => {
    const iterator = pendingIterator();
    const original = iterator.return?.bind(iterator);
    iterator.return = async (value) => {
      await original?.(value);
      throw new Error('return failed');
    };
    const controller = new AbortController();
    const stream = createEventStream(iterator, { signal: controller.signal, keepAliveInterval: 0 });
    const pending = readAll(stream);
    controller.abort();
    expect(await pending).toBe('');
    expect(iterator.returnCalls).toBe(1);
  });

  test('should ignore a synchronously throwing iterator.return', async () => {
    const iterator = pendingIterator();
    const original = iterator.return?.bind(iterator);
    iterator.return = (value) => {
      void original?.(value);
      throw new Error('return threw');
    };
    let closes = 0;
    const out = await readAll(
      createEventStream(iterator, { signal: AbortSignal.abort(), onClose: () => closes++ })
    );
    expect(out).toBe('');
    expect(iterator.returnCalls).toBe(1);
    expect(closes).toBe(1);
  });

  test('should return immediately when the signal is already aborted', async () => {
    const iterator = pendingIterator();
    let closes = 0;
    const out = await readAll(
      createEventStream(iterator, { signal: AbortSignal.abort(), onClose: () => closes++ })
    );
    expect(out).toBe('');
    expect(iterator.returnCalls).toBe(1);
    expect(closes).toBe(1);
  });

  test('should emit nothing for a single response when the signal is already aborted', async () => {
    expect(await readAll(createEventStream({ data: {} }, { signal: AbortSignal.abort() }))).toBe('');
  });

  test('should call onClose once when the stream completes on its own', async () => {
    let closes = 0;
    await readAll(createEventStream(iteratorOf([{ data: {} }]), { onClose: () => closes++ }));
    expect(closes).toBe(1);
  });

  test('should emit keep-alive comments on the interval and clear the timer on close', async () => {
    const created: unknown[] = [];
    const cleared: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const id = realSetInterval(...args);
      created.push(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
      cleared.push(id);
      realClearInterval(id);
    }) as typeof clearInterval;
    try {
      const iterator = pendingIterator();
      const controller = new AbortController();
      const reader = createEventStream(iterator, {
        signal: controller.signal,
        keepAliveInterval: 20,
      }).getReader();
      let keepAlives = 0;
      const deadline = Date.now() + 2000;
      while (keepAlives < 2 && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (decoder.decode(chunk.value) === SSE_KEEP_ALIVE) {
          keepAlives++;
        }
      }
      expect(keepAlives).toBe(2);
      expect(created.length).toBe(1);
      controller.abort();
      expect((await reader.read()).done).toBe(true);
      expect(cleared).toEqual(created);
      expect(iterator.returnCalls).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  test('should not emit keep-alives when keepAliveInterval is 0', async () => {
    const controller = new AbortController();
    const pending = readAll(
      createEventStream(pendingIterator(), { signal: controller.signal, keepAliveInterval: 0 })
    );
    await wait(50);
    controller.abort();
    expect(await pending).toBe('');
  });
});

/** Collects uncaught exceptions and unhandled rejections for the test's duration */
async function withoutEscapes(run: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onEscape = (error: unknown): void => {
    escaped.push(error);
  };
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
  try {
    await run();
    await wait(10);
  } finally {
    process.off('uncaughtException', onEscape);
    process.off('unhandledRejection', onEscape);
  }
  return escaped;
}

const throwingOnClose = (): never => {
  throw new Error('onClose exploded');
};

/** Make every TextEncoder.encode throw while `run` executes */
async function withFailingEncoder(run: () => Promise<void>): Promise<void> {
  const realEncode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = (): never => {
    throw new Error('enqueue failed');
  };
  try {
    await run();
  } finally {
    TextEncoder.prototype.encode = realEncode;
  }
}

describe('createEventStream onClose isolation', () => {
  test('should not let a throwing onClose escape the abort listener', async () => {
    const iterator = pendingIterator();
    const escaped = await withoutEscapes(async () => {
      const controller = new AbortController();
      const pending = readAll(
        createEventStream(iterator, {
          signal: controller.signal,
          keepAliveInterval: 0,
          onClose: throwingOnClose,
        })
      );
      controller.abort();
      expect(await pending).toBe('');
    });
    expect(escaped).toEqual([]);
    expect(iterator.returnCalls).toBe(1);
  });

  test('should not let a throwing onClose escape the keep-alive timer', async () => {
    const iterator = pendingIterator();
    let stream: ReadableStream<Uint8Array> | undefined;
    const escaped = await withoutEscapes(async () => {
      await withFailingEncoder(async () => {
        stream = createEventStream(iterator, { keepAliveInterval: 5, onClose: throwingOnClose });
        await wait(40);
      });
    });
    expect(escaped).toEqual([]);
    expect(iterator.returnCalls).toBe(1);
    expect(await readAll(stream as ReadableStream<Uint8Array>)).toBe('');
  });

  test('should not let a throwing onClose reject cancel', async () => {
    const iterator = pendingIterator();
    const escaped = await withoutEscapes(async () => {
      const stream = createEventStream(iterator, {
        keepAliveInterval: 0,
        onClose: throwingOnClose,
      });
      await stream.getReader().cancel();
    });
    expect(escaped).toEqual([]);
    expect(iterator.returnCalls).toBe(1);
  });

  test('should not let a throwing onClose escape an already-aborted start', async () => {
    const iterator = pendingIterator();
    const escaped = await withoutEscapes(async () => {
      const stream = createEventStream(iterator, {
        signal: AbortSignal.abort(),
        onClose: throwingOnClose,
      });
      expect(await readAll(stream)).toBe('');
    });
    expect(escaped).toEqual([]);
    expect(iterator.returnCalls).toBe(1);
  });

  test('should not let a throwing onClose escape natural completion', async () => {
    const escaped = await withoutEscapes(async () => {
      const out = await readAll(createEventStream({ data: {} }, { onClose: throwingOnClose }));
      expect(out.endsWith(formatCompleteEvent())).toBe(true);
    });
    expect(escaped).toEqual([]);
  });
});

describe('createEventStream backpressure', () => {
  test('should not drain the iterator beyond the queue limit until the reader reads', async () => {
    let nextCalls = 0;
    const iterator = iteratorOf([]);
    iterator.next = async () => {
      nextCalls++;
      return { done: false, value: { data: { n: nextCalls } } };
    };
    const stream = createEventStream(iterator, { keepAliveInterval: 0 });
    await wait(20);
    const before = nextCalls;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(before).toBeLessThanOrEqual(2);
    const reader = stream.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(formatNextEvent({ data: { n: 1 } }));
    await wait(20);
    expect(nextCalls).toBe(before + 1);
    await reader.cancel();
    expect(iterator.returnCalls).toBe(1);
  });

  test('should skip keep-alive ticks while the queue is full', async () => {
    const iterator = pendingIterator([{ data: { n: 1 } }]);
    const stream = createEventStream(iterator, { keepAliveInterval: 5 });
    // Eight ticks elapse while the single queued `next` fills the queue
    await wait(40);
    const reader = stream.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(formatNextEvent({ data: { n: 1 } }));
    // A read on a non-empty queue resolves at once, so it wins this race only
    // if a keep-alive was enqueued behind the `next` while the queue was full
    const second = await Promise.race([reader.read(), Promise.resolve('empty' as const)]);
    expect(second).toBe('empty');
    await reader.cancel();
    expect(iterator.returnCalls).toBe(1);
  });

  test('should call return when enqueue fails', async () => {
    const iterator = pendingIterator([{ data: { n: 1 } }]);
    let closes = 0;
    await withFailingEncoder(async () => {
      createEventStream(iterator, { keepAliveInterval: 0, onClose: () => closes++ });
      await wait(10);
    });
    expect(iterator.returnCalls).toBe(1);
    expect(closes).toBe(1);
  });
});

describe('createEventStream error and abort races', () => {
  test('should fall back to a generic error when formatError throws', async () => {
    const out = await readAll(
      createEventStream(throwingIterator(), {
        formatError: () => {
          throw new Error('formatter broke');
        },
      })
    );
    expect(out).toBe(
      formatNextEvent({ errors: [{ message: 'An unexpected error occurred' }] }) +
        formatCompleteEvent()
    );
  });

  test('should not call formatError for a next() rejection after an abort', async () => {
    let reject: ((error: Error) => void) | undefined;
    const iterator = iteratorOf([]);
    iterator.next = () =>
      new Promise((_resolve, rejectNext) => {
        reject = rejectNext;
      });
    iterator.return = async () => {
      iterator.returnCalls++;
      reject?.(new Error('iterator torn down'));
      return { done: true, value: undefined };
    };
    let formatErrorCalls = 0;
    const controller = new AbortController();
    const pending = readAll(
      createEventStream(iterator, {
        signal: controller.signal,
        keepAliveInterval: 0,
        formatError: (error) => {
          formatErrorCalls++;
          return { message: String(error) };
        },
      })
    );
    await wait(5);
    controller.abort();
    expect(await pending).toBe('');
    await wait(5);
    expect(formatErrorCalls).toBe(0);
    expect(iterator.returnCalls).toBe(1);
  });

  test('should send nothing more when aborted while formatResult is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    let formatCalls = 0;
    const iterator = iteratorOf([{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }]);
    const controller = new AbortController();
    const reader = createEventStream(iterator, {
      signal: controller.signal,
      keepAliveInterval: 0,
      formatResult: (result) => {
        formatCalls++;
        if (formatCalls === 1) {
          return result;
        }
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }).getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(formatNextEvent({ data: { n: 1 } }));
    const deadline = Date.now() + 1000;
    while (release === undefined && Date.now() < deadline) {
      await wait(1);
    }
    expect(release).toBeDefined();
    controller.abort();
    release?.({ late: true });
    expect((await reader.read()).done).toBe(true);
    await wait(5);
    expect(formatCalls).toBe(2);
    expect(iterator.returnCalls).toBe(1);
  });

  test('should run return and onClose once when an abort is followed by cancel', async () => {
    const iterator = pendingIterator();
    let closes = 0;
    const controller = new AbortController();
    const reader = createEventStream(iterator, {
      signal: controller.signal,
      keepAliveInterval: 0,
      onClose: () => closes++,
    }).getReader();
    controller.abort();
    await reader.cancel();
    expect(iterator.returnCalls).toBe(1);
    expect(closes).toBe(1);
  });
});

describe('createEventStreamResponse', () => {
  test('should set SSE headers merged with extra headers', () => {
    const res = createEventStreamResponse(
      { data: {} },
      { headers: { 'Access-Control-Allow-Origin': '*' } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-encoding')).toBe('none');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('should not let extra headers override Content-Type or Cache-Control', () => {
    const res = createEventStreamResponse(
      { data: {} },
      {
        headers: {
          'content-type': 'application/json',
          'Cache-Control': 'max-age=3600',
          'X-Request-Id': 'abc',
        },
      }
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-request-id')).toBe('abc');
  });

  test('should merge non-conflicting extra headers case-insensitively', () => {
    const res = createEventStreamResponse(
      { data: {} },
      { headers: { 'x-trace': 'one', 'X-Trace': 'two' } }
    );
    expect(res.headers.get('x-trace')).toBe('two');
  });

  test('should stream the events as the body', async () => {
    const res = createEventStreamResponse({ data: { a: 1 } });
    expect(await res.text()).toBe(formatNextEvent({ data: { a: 1 } }) + formatCompleteEvent());
  });
});
