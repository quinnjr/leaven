/**
 * @leaven-graphql/ws - Protocol tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  MessageType,
  parseMessage,
  formatMessage,
  createConnectionAck,
  createNextMessage,
  createErrorMessage,
  createCompleteMessage,
  createPongMessage,
  isValidOperationId,
  OPERATION_ID_PATTERN,
} from './protocol';

describe('MessageType', () => {
  test('should have all message types', () => {
    expect(MessageType.ConnectionInit).toBe('connection_init');
    expect(MessageType.ConnectionAck).toBe('connection_ack');
    expect(MessageType.Ping).toBe('ping');
    expect(MessageType.Pong).toBe('pong');
    expect(MessageType.Subscribe).toBe('subscribe');
    expect(MessageType.Next).toBe('next');
    expect(MessageType.Error).toBe('error');
    expect(MessageType.Complete).toBe('complete');
  });
});

describe('parseMessage', () => {
  test('should parse connection_init message', () => {
    const message = parseMessage('{"type":"connection_init"}');
    expect(message.type).toBe(MessageType.ConnectionInit);
  });

  test('should parse connection_init with payload', () => {
    const message = parseMessage(
      '{"type":"connection_init","payload":{"token":"abc"}}'
    );
    expect(message.type).toBe(MessageType.ConnectionInit);
    expect((message as { payload?: { token: string } }).payload?.token).toBe('abc');
  });

  test('should parse subscribe message', () => {
    const message = parseMessage(
      '{"id":"1","type":"subscribe","payload":{"query":"{ hello }"}}'
    );
    expect(message.type).toBe(MessageType.Subscribe);
    expect((message as { id: string }).id).toBe('1');
  });

  test('should parse complete message', () => {
    const message = parseMessage('{"id":"1","type":"complete"}');
    expect(message.type).toBe(MessageType.Complete);
    expect((message as { id: string }).id).toBe('1');
  });

  test('should parse ping message', () => {
    const message = parseMessage('{"type":"ping"}');
    expect(message.type).toBe(MessageType.Ping);
  });

  test('should parse pong message', () => {
    const message = parseMessage('{"type":"pong"}');
    expect(message.type).toBe(MessageType.Pong);
  });

  test('should parse from Buffer', () => {
    const buffer = Buffer.from('{"type":"ping"}');
    const message = parseMessage(buffer);
    expect(message.type).toBe(MessageType.Ping);
  });

  test('should throw for invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow(/Invalid JSON/);
  });

  test('should throw for missing type', () => {
    expect(() => parseMessage('{}')).toThrow(/must have a type/);
  });

  // `JSON.parse` accepts all of these, so without an explicit guard the
  // `message.type` dereference throws an engine TypeError ("null is not an
  // object …") that the server hands straight back as a close reason
  test.each([['null'], ['[]'], ['[{"type":"ping"}]'], ['"ping"'], ['42'], ['true']])(
    'should throw a protocol error for non-object JSON: %s',
    (text) => {
      expect(() => parseMessage(text)).toThrow(/Message must be an object/);
      expect(() => parseMessage(text)).not.toThrow(/is not an object \(evaluating/);
    }
  );

  test('should throw for a non-string type', () => {
    expect(() => parseMessage('{"type":42}')).toThrow(/Invalid message type: 42/);
  });

  test('should escape and bound an unknown type echoed in the error', () => {
    let message = '';
    try {
      parseMessage(JSON.stringify({ type: `bad\n${'x'.repeat(500)}` }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.startsWith('Invalid message type: bad\\n')).toBe(true);
    expect(message).not.toContain('\n');
    // The handler uses this as a WebSocket close reason, capped at 123 bytes
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(123);
  });

  test('should throw for invalid type', () => {
    expect(() => parseMessage('{"type":"invalid"}')).toThrow(/Invalid message type/);
  });

  test('should throw for subscribe message without id', () => {
    expect(() =>
      parseMessage('{"type":"subscribe","payload":{"query":"{ hello }"}}')
    ).toThrow(/must have a string id/);
  });

  test('should throw for complete message without id', () => {
    expect(() => parseMessage('{"type":"complete"}')).toThrow(/must have a string id/);
  });

  test('should throw for next message without id', () => {
    expect(() => parseMessage('{"type":"next","payload":{"data":{}}}')).toThrow(
      /must have a string id/
    );
  });

  test('should throw for error message without id', () => {
    expect(() =>
      parseMessage('{"type":"error","payload":[{"message":"x"}]}')
    ).toThrow(/must have a string id/);
  });

  test('should throw for non-string id', () => {
    expect(() => parseMessage('{"id":1,"type":"complete"}')).toThrow(
      /must have a string id/
    );
  });

  test('should accept id-less frames when requireId is false', () => {
    // Client-side parsing of SERVER -> client frames from a lenient peer must
    // not throw just because the id was omitted
    expect(
      parseMessage('{"type":"next","payload":{"data":{}}}', { requireId: false }).type
    ).toBe(MessageType.Next);
    expect(
      parseMessage('{"type":"error","payload":[{"message":"x"}]}', {
        requireId: false,
      }).type
    ).toBe(MessageType.Error);
    expect(parseMessage('{"type":"complete"}', { requireId: false }).type).toBe(
      MessageType.Complete
    );
  });

  test('should still validate type when requireId is false', () => {
    expect(() => parseMessage('{"type":"bogus"}', { requireId: false })).toThrow(
      /Invalid message type/
    );
  });

  test('should require id by default when options are omitted', () => {
    expect(() => parseMessage('{"type":"complete"}', {})).toThrow(
      /must have a string id/
    );
  });

  test('should not require id for connection_init, ping, or pong', () => {
    expect(parseMessage('{"type":"connection_init"}').type).toBe(
      MessageType.ConnectionInit
    );
    expect(parseMessage('{"type":"ping"}').type).toBe(MessageType.Ping);
    expect(parseMessage('{"type":"pong"}').type).toBe(MessageType.Pong);
  });
});

describe('operation id validation', () => {
  const valid = ['1', 'sub-1', 'a.b:c_d-E', 'x'.repeat(64), '0f8fad5b-d9cb-469f-a165-70867728950e'];
  const invalid = [
    '',
    'x'.repeat(65),
    'sub 1',
    'evil\nINFO forged log line',
    'evil\r\nx',
    'tab\there',
    'nul\u0000',
    'del\u007f',
    'emoji\u{1F600}',
    'caf\u00e9',
    'semi;colon',
    'slash/x',
  ];

  test('should expose the id pattern', () => {
    expect(OPERATION_ID_PATTERN.source).toBe('^[A-Za-z0-9_.:-]{1,64}$');
  });

  test.each(valid)('isValidOperationId accepts %p', (id) => {
    expect(isValidOperationId(id)).toBe(true);
  });

  test.each(invalid)('isValidOperationId rejects %p', (id) => {
    expect(isValidOperationId(id)).toBe(false);
  });

  test('should reject non-string operation ids in isValidOperationId', () => {
    expect(isValidOperationId(1)).toBe(false);
    expect(isValidOperationId(undefined)).toBe(false);
    expect(isValidOperationId(null)).toBe(false);
  });

  test.each(invalid)('parseMessage rejects subscribe id %p', (id) => {
    const frame = JSON.stringify({ id, type: 'subscribe', payload: { query: '{ a }' } });
    expect(() => parseMessage(frame)).toThrow(/^Invalid message$/);
  });

  test.each(invalid)('parseMessage rejects complete id %p', (id) => {
    expect(() => parseMessage(JSON.stringify({ id, type: 'complete' }))).toThrow(
      /^Invalid message$/
    );
  });

  test.each(valid)('parseMessage accepts subscribe/complete id %p', (id) => {
    expect(parseMessage(JSON.stringify({ id, type: 'complete' })).type).toBe(
      MessageType.Complete
    );
    const frame = JSON.stringify({ id, type: 'subscribe', payload: { query: '{ a }' } });
    expect(parseMessage(frame).type).toBe(MessageType.Subscribe);
  });

  test('should leave server -> client ids alone in parseMessage when requireId is false', () => {
    // A client parsing server frames must not be torn down over an id it
    // did not choose; the format rule guards what a server accepts.
    expect(
      parseMessage(JSON.stringify({ id: 'a b', type: 'next', payload: {} }), {
        requireId: false,
      }).type
    ).toBe(MessageType.Next);
  });
});

describe('formatMessage', () => {
  test('should format connection_ack message', () => {
    const message = { type: MessageType.ConnectionAck } as const;
    const formatted = formatMessage(message);
    expect(JSON.parse(formatted)).toEqual({ type: 'connection_ack' });
  });

  test('should format next message', () => {
    const message = {
      id: '1',
      type: MessageType.Next as const,
      payload: { data: { hello: 'world' } },
    };
    const formatted = formatMessage(message);
    const parsed = JSON.parse(formatted);

    expect(parsed.id).toBe('1');
    expect(parsed.type).toBe('next');
    expect(parsed.payload.data.hello).toBe('world');
  });

  test('should format error message', () => {
    const message = {
      id: '1',
      type: MessageType.Error as const,
      payload: [{ message: 'Error occurred' }],
    };
    const formatted = formatMessage(message);
    const parsed = JSON.parse(formatted);

    expect(parsed.type).toBe('error');
    expect(parsed.payload[0].message).toBe('Error occurred');
  });
});

describe('createConnectionAck', () => {
  test('should create connection_ack message', () => {
    const message = createConnectionAck();
    expect(message.type).toBe(MessageType.ConnectionAck);
    expect(message.payload).toBeUndefined();
  });

  test('should include payload', () => {
    const message = createConnectionAck({ sessionId: 'abc' });
    expect(message.payload?.sessionId).toBe('abc');
  });
});

describe('createNextMessage', () => {
  test('should create next message with data', () => {
    const message = createNextMessage('1', { hello: 'world' });

    expect(message.type).toBe(MessageType.Next);
    expect(message.id).toBe('1');
    expect(message.payload.data).toEqual({ hello: 'world' });
  });

  test('should include errors', () => {
    const message = createNextMessage('1', null, [{ message: 'Error' }]);

    expect(message.payload.data).toBeNull();
    expect(message.payload.errors?.[0]?.message).toBe('Error');
  });
});

describe('createErrorMessage', () => {
  test('should create error message', () => {
    const message = createErrorMessage('1', [{ message: 'Something went wrong' }]);

    expect(message.type).toBe(MessageType.Error);
    expect(message.id).toBe('1');
    expect(message.payload[0]?.message).toBe('Something went wrong');
  });

  test('should include multiple errors', () => {
    const message = createErrorMessage('1', [
      { message: 'Error 1' },
      { message: 'Error 2' },
    ]);

    expect(message.payload.length).toBe(2);
  });
});

describe('createCompleteMessage', () => {
  test('should create complete message', () => {
    const message = createCompleteMessage('1');

    expect(message.type).toBe(MessageType.Complete);
    expect(message.id).toBe('1');
  });
});

describe('createPongMessage', () => {
  test('should create pong message', () => {
    const message = createPongMessage();

    expect(message.type).toBe(MessageType.Pong);
    expect(message.payload).toBeUndefined();
  });

  test('should include payload', () => {
    const message = createPongMessage({ timestamp: 123 });

    expect(message.payload?.timestamp).toBe(123);
  });
});

describe('parseMessage subscribe payload', () => {
  const reject = (json: string): void => {
    expect(() => parseMessage(json)).toThrow('Invalid message');
  };

  test('should reject a subscribe with no payload', () => {
    reject('{"type":"subscribe","id":"1"}');
  });

  test('should reject a non-object payload', () => {
    reject('{"type":"subscribe","id":"1","payload":"x"}');
    reject('{"type":"subscribe","id":"1","payload":[]}');
    reject('{"type":"subscribe","id":"1","payload":null}');
  });

  test('should reject a non-string query', () => {
    reject('{"type":"subscribe","id":"1","payload":{"query":5}}');
    reject('{"type":"subscribe","id":"1","payload":{}}');
  });

  test('should reject malformed optional fields', () => {
    reject('{"type":"subscribe","id":"1","payload":{"query":"{a}","operationName":1}}');
    reject('{"type":"subscribe","id":"1","payload":{"query":"{a}","variables":"x"}}');
    reject('{"type":"subscribe","id":"1","payload":{"query":"{a}","extensions":[]}}');
  });

  test('should reject a malformed payload even with requireId false', () => {
    for (const json of [
      '{"type":"subscribe","id":"1","payload":5}',
      '{"type":"subscribe","id":"1","payload":{"query":5}}',
      '{"type":"subscribe","id":"1","payload":{"query":"{a}","extensions":[]}}',
    ]) {
      expect(() => parseMessage(json, { requireId: false })).toThrow('Invalid message');
    }
  });

  test('should accept a well-formed payload', () => {
    const message = parseMessage(
      '{"type":"subscribe","id":"1","payload":{"query":"{a}","operationName":"A","variables":{"x":1},"extensions":{}}}'
    );
    expect(message.type).toBe(MessageType.Subscribe);
  });
});

describe('createNextMessage extensions', () => {
  test('should include extensions when given', () => {
    const message = createNextMessage('1', { a: 1 }, undefined, { trace: true });
    expect(message.payload.extensions).toEqual({ trace: true });
  });

  test('should omit extensions when absent', () => {
    const message = createNextMessage('1', { a: 1 });
    expect('extensions' in message.payload).toBe(false);
  });
});
