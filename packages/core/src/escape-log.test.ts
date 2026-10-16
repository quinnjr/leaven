/**
 * @leaven-graphql/core - escapeLog tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { escapeLog, LOG_VALUE_MAX_LENGTH } from './escape-log';

describe('escapeLog', () => {
  test('should leave printable text alone', () => {
    expect(escapeLog('sub-1 user:42 café ✓')).toBe('sub-1 user:42 café ✓');
  });

  test('should escape CR and LF so a value cannot start a new log line', () => {
    const out = escapeLog('id\r\n2026-01-01 INFO forged entry');
    expect(out).toBe('id\\r\\n2026-01-01 INFO forged entry');
    expect(out).not.toMatch(/[\r\n]/);
  });

  test('should escape tab, NUL, ESC and every other C0 control character', () => {
    expect(escapeLog('a\tb')).toBe('a\\tb');
    expect(escapeLog('\u0000')).toBe('\\x00');
    expect(escapeLog('\u001b[31mred')).toBe('\\x1b[31mred');
    for (let code = 0; code < 0x20; code++) {
      expect(escapeLog(String.fromCharCode(code))).not.toMatch(/[\u0000-\u001f]/);
    }
  });

  test('should escape DEL, C1 controls and Unicode line separators', () => {
    expect(escapeLog('\u007f')).toBe('\\x7f');
    expect(escapeLog('\u0085')).toBe('\\x85');
    expect(escapeLog('\u2028\u2029')).toBe('\\u2028\\u2029');
  });

  test('should cap long values and say how much was cut', () => {
    const out = escapeLog('x'.repeat(1000));
    expect(LOG_VALUE_MAX_LENGTH).toBe(256);
    expect(out.startsWith('x'.repeat(256))).toBe(true);
    expect(out).toBe(`${'x'.repeat(256)}…[+744 chars]`);
  });

  test('should cap before escaping so the output stays bounded', () => {
    const out = escapeLog('\n'.repeat(1000));
    expect(out).toBe(`${'\\n'.repeat(256)}…[+744 chars]`);
  });

  test('should honour a custom maximum length', () => {
    expect(escapeLog('abcdef', 3)).toBe('abc…[+3 chars]');
    expect(escapeLog('abc', 3)).toBe('abc');
  });

  test('should stringify non-string values', () => {
    expect(escapeLog(42)).toBe('42');
    expect(escapeLog(undefined)).toBe('undefined');
    expect(escapeLog(null)).toBe('null');
    expect(escapeLog(new Error('a\nb'))).toBe('Error: a\\nb');
  });

  test('should not throw on values whose toString throws', () => {
    const hostile = {
      toString(): string {
        throw new Error('nope');
      },
    };
    expect(escapeLog(hostile)).toBe('[unprintable]');
  });
});
